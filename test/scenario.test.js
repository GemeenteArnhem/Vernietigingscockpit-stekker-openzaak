import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { parseScenario, scenarioResultaat } from '../src/config/scenario-config.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';

function maakServices(scenario, { selectieDelayMs = 0 } = {}) {
  const bron = new GeheugenBron();
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: selectieDelayMs,
    scenario
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    processingDelayMs: 0,
    scenario
  });
  return { bron, selectieService, vernietigingService };
}

async function vernietigAlles({ bron, selectieService, vernietigingService }) {
  const selectie = await selectieService.startSelectie({ peildatum: '2026-09-25' });
  const objecten = selectie.kandidaten.map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));
  const vernietiging = vernietigingService.startVernietiging({
    selectieId: selectie.selectieId,
    cockpitTaakId: 'taak-scenario',
    besluitReferentie: 'besluit-scenario'
  });
  vernietigingService.voegBatchToe(vernietiging.vernietigingId, { batchNummer: 1, vernietigingskandidaten: objecten });
  const afgerond = await vernietigingService.vrijgeven(vernietiging.vernietigingId, {
    aantalBatches: 1,
    aantalKandidaten: objecten.length
  });
  const vernietigd = new Set(selectie.kandidaten.filter((kandidaat) => bron.zaak(kandidaat.bronId).verwijderd).map((kandidaat) => kandidaat.bronId));
  return { selectie, afgerond, vernietigd };
}

async function metServer(t, scenario, { selectieDelayMs = 0 } = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const { selectieService, vernietigingService } = maakServices(scenario, { selectieDelayMs });
  const server = createHttpServer({ selectieService, vernietigingService, scenario, logRequests: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (pad, { method = 'GET', body } = {}) => {
    // Stekker API v2: paden onder /v2 (behalve /health) en een Idempotency-Key op elke POST.
    const response = await fetch(pad === '/health' ? `${baseUrl}${pad}` : `${baseUrl}/v2${pad}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
}

test('parseScenario: standaard uit, en ongeldige configuratie faalt bij opstarten', () => {
  const standaard = parseScenario({});
  assert.deepEqual(standaard.resultaatPercentages, { FAILED: 0, CHANGED: 0, NOT_FOUND: 0, SKIPPED: 0 });
  assert.equal(standaard.selectieFail, false);
  assert.equal(standaard.http.failFirstN, 0);

  assert.throws(() => parseScenario({ SCENARIO_FAILED_PERCENTAGE: '60', SCENARIO_CHANGED_PERCENTAGE: '50' }), /maximaal 100/);
  assert.throws(() => parseScenario({ SCENARIO_CHANGED_PERCENTAGE: '300' }), /tussen 0 en 100/);
  assert.throws(() => parseScenario({ SCENARIO_NOT_FOUND_PERCENTAGE: 'veel' }), /geheel getal/);
  assert.throws(() => parseScenario({ SCENARIO_HTTP_FAIL_STATUS: '418' }), /SCENARIO_HTTP_FAIL_STATUS/);
  assert.throws(() => parseScenario({ SCENARIO_HTTP_FAIL_MODE: 'soms' }), /SCENARIO_HTTP_FAIL_MODE/);
});

test('scenarioResultaat is deterministisch per kandidaat-id', () => {
  const vijftigProcent = parseScenario({ SCENARIO_FAILED_PERCENTAGE: '50' });
  const ids = Array.from({ length: 1000 }, (_, index) => `vk-${index}`);
  const eerste = ids.map((id) => scenarioResultaat(vijftigProcent, id));
  const tweede = ids.map((id) => scenarioResultaat(vijftigProcent, id));
  const aantalFailed = eerste.filter((resultaat) => resultaat === 'FAILED').length;

  assert.deepEqual(eerste, tweede);
  assert.ok(aantalFailed > 400 && aantalFailed < 600, `verwacht ~500 FAILED, kreeg ${aantalFailed}`);
  assert.equal(scenarioResultaat(parseScenario({}), 'vk-1'), undefined);
  assert.equal(scenarioResultaat(parseScenario({ SCENARIO_CHANGED_PERCENTAGE: '100' }), 'vk-1'), 'CHANGED');
});

test('met 100% CHANGED krijgt elke kandidaat CHANGED, status PARTIAL, en wordt niets vernietigd', async () => {
  const { selectie, afgerond, vernietigd } = await vernietigAlles(maakServices(parseScenario({ SCENARIO_CHANGED_PERCENTAGE: '100' })));

  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(afgerond.gewijzigd, selectie.totaalKandidaten);
  assert.equal(afgerond.succesvolVernietigd, 0);
  assert.equal(afgerond.resultaten.every((resultaat) => resultaat.foutcode === 'SCENARIO_CHANGED'), true);
  assert.equal(vernietigd.size, 0);
});

test('met een mix van scenario-resultaten kloppen de tellingen', async () => {
  const scenario = parseScenario({
    SCENARIO_FAILED_PERCENTAGE: '20',
    SCENARIO_NOT_FOUND_PERCENTAGE: '10',
    SCENARIO_SKIPPED_PERCENTAGE: '10'
  });
  const { selectie, afgerond, vernietigd } = await vernietigAlles(maakServices(scenario));
  const som = afgerond.succesvolVernietigd + afgerond.mislukt + afgerond.nietGevonden + afgerond.overgeslagen + afgerond.gewijzigd;

  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(som, selectie.totaalKandidaten);
  assert.ok(afgerond.mislukt > 0 && afgerond.nietGevonden > 0 && afgerond.overgeslagen > 0);
  assert.equal(vernietigd.size, afgerond.succesvolVernietigd);
});

test('met SCENARIO_SELECTIE_FAIL eindigt de selectie op FAILED, synchroon en via HTTP', async (t) => {
  const scenario = parseScenario({ SCENARIO_SELECTIE_FAIL: 'true' });
  const synchroon = await maakServices(scenario).selectieService.startSelectie({ peildatum: '2026-09-25' });
  assert.equal(synchroon.status, 'FAILED');
  assert.equal(synchroon.aantalFouten, 1);

  const request = await metServer(t, scenario, { selectieDelayMs: 20 });
  const gestart = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  assert.equal(gestart.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const opgevraagd = await request(`/selecties/${gestart.body.selectieId}`);
  assert.equal(opgevraagd.body.status, 'FAILED');
  assert.equal(opgevraagd.body.aantalFouten, 1);
});

test('transportfout vóór verwerking: de eerste N calls per endpoint falen, daarna slaagt de call', async (t) => {
  const request = await metServer(t, parseScenario({
    SCENARIO_HTTP_FAIL_FIRST_N: '2',
    SCENARIO_HTTP_FAIL_STATUS: '503',
    SCENARIO_HTTP_FAIL_ENDPOINTS: 'POST /selecties'
  }));

  const pogingen = [];
  for (let poging = 0; poging < 3; poging += 1) {
    pogingen.push(await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } }));
  }

  assert.deepEqual(pogingen.map((poging) => poging.status), [503, 503, 202]);
  assert.equal(pogingen[0].body.code, 'SERVICE_UNAVAILABLE');
  assert.ok(pogingen[0].body.logReference);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/selecties/bestaat-niet')).status, 404, 'endpoints buiten de filter falen niet');
});

test('transportfout ná verwerking: het verzoek is wel uitgevoerd, de retry slaagt', async (t) => {
  const request = await metServer(t, parseScenario({
    SCENARIO_HTTP_FAIL_FIRST_N: '1',
    SCENARIO_HTTP_FAIL_MODE: 'na',
    SCENARIO_HTTP_FAIL_ENDPOINTS: 'POST /vernietigingen/{vernietigingId}/batches'
  }));
  const selectie = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const pagina = await request(`/selecties/${selectie.body.selectieId}/vernietigingskandidaten?limit=3`);
  const objecten = pagina.body.items.map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));
  const vernietiging = await request('/vernietigingen', {
    method: 'POST',
    body: { selectieId: selectie.body.selectieId, cockpitTaakId: 'taak-na', besluitReferentie: 'besluit-na' }
  });
  const pad = `/vernietigingen/${vernietiging.body.vernietigingId}`;

  const eerste = await request(`${pad}/batches`, { method: 'POST', body: { batchNummer: 1, vernietigingskandidaten: objecten } });
  assert.equal(eerste.status, 503);

  // De batch is ondanks de 503 ontvangen: de vrijgave met 1 batch slaagt.
  const retry = await request(`${pad}/batches`, { method: 'POST', body: { batchNummer: 1, vernietigingskandidaten: objecten } });
  assert.equal(retry.status, 202);
  const vrijgave = await request(`${pad}/vrijgeven`, { method: 'POST', body: { aantalBatches: 1, aantalKandidaten: 3 } });
  assert.equal(vrijgave.status, 202);
});

test('transportfout met 401 en een vaste vertraging per call', async (t) => {
  const request = await metServer(t, parseScenario({
    SCENARIO_HTTP_FAIL_FIRST_N: '1',
    SCENARIO_HTTP_FAIL_STATUS: '401',
    SCENARIO_HTTP_DELAY_MS: '120'
  }));

  const start = Date.now();
  const response = await request('/selecties/iets');
  const duur = Date.now() - start;

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
  assert.ok(duur >= 110, `verwacht minstens 120 ms vertraging, was ${duur} ms`);
});
