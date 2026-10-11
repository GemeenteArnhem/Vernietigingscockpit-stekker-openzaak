import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { parseScenario } from '../src/config/scenario-config.js';
import { InMemoryIdempotencyRepository } from '../src/infrastructure/repositories/in-memory-idempotency-repository.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';
import { valideerTegenXsd } from './helpers/xsd.js';

// Gedrag dat nieuw is in Stekker API v2 (ADR-0004, ADR-0005).


function maakServices(scenario = parseScenario({})) {
  const bron = new GeheugenBron();
  const idempotencyRepository = new InMemoryIdempotencyRepository();
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: 0,
    scenario,
    idempotencyRepository
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    processingDelayMs: 0,
    scenario,
    idempotencyRepository
  });
  return { selectieService, vernietigingService };
}

async function metServer(t, scenario) {
  t.mock.method(console, 'warn', () => {});
  const { selectieService, vernietigingService } = maakServices(scenario);
  const server = createHttpServer({ selectieService, vernietigingService, scenario, logRequests: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (url, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const tekst = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(tekst) : tekst
    };
  };
}

const sleutel = () => ({ 'Idempotency-Key': crypto.randomUUID() });

async function vernietigEersteKandidaten(request, aantal) {
  const selectie = await request('/v2/selecties', { method: 'POST', headers: sleutel(), body: { peildatum: '2026-09-25' } });
  const pagina = await request(`/v2/selecties/${selectie.body.selectieId}/vernietigingskandidaten?limit=${aantal}`);
  const kandidaten = pagina.body.items;
  const vernietiging = await request('/v2/vernietigingen', {
    method: 'POST',
    headers: sleutel(),
    body: { selectieId: selectie.body.selectieId, cockpitTaakId: 'taak-v2', besluitReferentie: 'besluit-v2' }
  });
  const pad = `/v2/vernietigingen/${vernietiging.body.vernietigingId}`;
  await request(`${pad}/batches`, {
    method: 'POST',
    headers: sleutel(),
    body: {
      batchNummer: 1,
      vernietigingskandidaten: kandidaten.map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }))
    }
  });
  const vrijgave = await request(`${pad}/vrijgeven`, {
    method: 'POST',
    headers: sleutel(),
    body: { aantalBatches: 1, aantalKandidaten: kandidaten.length }
  });
  return { kandidaten, pad, vrijgave };
}

test('Idempotency-Key is verplicht op elke POST (400 IDEMPOTENCY_KEY_MISSING)', async (t) => {
  const request = await metServer(t);

  for (const [url, body] of [
    ['/v2/selecties', { peildatum: '2026-09-25' }],
    ['/v2/vernietigingen', { selectieId: 'x', cockpitTaakId: 't', besluitReferentie: 'b' }],
    ['/v2/vernietigingen/x/batches', { batchNummer: 1, vernietigingskandidaten: [] }],
    ['/v2/vernietigingen/x/vrijgeven', { aantalBatches: 1, aantalKandidaten: 1 }]
  ]) {
    const response = await request(url, { method: 'POST', body });
    assert.deepEqual([response.status, response.body.code], [400, 'IDEMPOTENCY_KEY_MISSING'], url);
  }
});

test('POST /selecties is idempotent: zelfde key geeft dezelfde selectie, andere inhoud geeft 409', async (t) => {
  const request = await metServer(t);
  const headers = { 'Idempotency-Key': 'selectie-taak-1' };
  const eerste = await request('/v2/selecties', { method: 'POST', headers, body: { peildatum: '2026-09-25' } });
  const herhaling = await request('/v2/selecties', { method: 'POST', headers, body: { peildatum: '2026-09-25' } });
  const anders = await request('/v2/selecties', { method: 'POST', headers, body: { peildatum: '2026-09-24' } });

  assert.equal(herhaling.body.selectieId, eerste.body.selectieId);
  assert.deepEqual([anders.status, anders.body.code], [409, 'IDEMPOTENCY_KEY_REUSED']);
});

test('de API staat onder /v2 en meldt de volledige versie in API-Version', async (t) => {
  const request = await metServer(t);
  const zonderPrefix = await request('/selecties/iets');
  const metPrefix = await request('/v2/selecties/iets');
  const health = await request('/health');

  assert.equal(zonderPrefix.status, 404);
  assert.equal(metPrefix.status, 404);
  assert.equal(metPrefix.body.code, 'SELECTIE_NOT_FOUND');
  assert.equal(metPrefix.headers.get('api-version'), '2.0.0');
  assert.equal(health.status, 200);
});

test('kandidaten volgen het MDTO-profiel; einddatum = startdatum + looptijd', async () => {
  const { selectieService } = maakServices();
  const selectie = await selectieService.startSelectie({ peildatum: '2026-09-25' });

  for (const kandidaat of selectie.kandidaten) {
    const { termijnStartdatumLooptijd, termijnLooptijd, termijnEinddatum } = kandidaat.bewaartermijn;
    const jaren = Number(termijnLooptijd.match(/^P(\d+)Y$/)[1]);
    const verwacht = new Date(`${termijnStartdatumLooptijd}T00:00:00Z`);
    verwacht.setUTCFullYear(verwacht.getUTCFullYear() + jaren);

    assert.equal(termijnEinddatum, verwacht.toISOString().slice(0, 10), kandidaat.vernietigingskandidaatId);
    assert.equal(kandidaat.waardering.begripCode, 'V');
    assert.ok(['Archief', 'Serie', 'Dossier', 'Archiefstuk'].includes(kandidaat.aggregatieniveau.begripLabel));
    assert.ok(kandidaat.identificatie.length >= 1);
  }
});

test('SUCCESS draagt het event Vernietigen; de uitvoering meldt de vernietigingsmethode', async (t) => {
  const request = await metServer(t);
  const { pad, vrijgave } = await vernietigEersteKandidaten(request, 3);
  const vernietiging = await request(pad);
  const batch = await request(`${pad}/batches/1`);

  assert.equal(vrijgave.body.vernietigingsmethode.begripLabel, 'Verwijderd via bronfunctie');
  assert.ok(vrijgave.body.vernietigingsmethodeToelichting);
  assert.equal(vernietiging.body.status, 'COMPLETED');
  assert.equal(vernietiging.body.verwerkteBatches, 1);

  for (const resultaat of batch.body.resultaten) {
    assert.equal(resultaat.resultaat, 'SUCCESS');
    assert.equal(resultaat.event.eventType.begripLabel, 'Vernietigen');
    assert.ok(!Number.isNaN(Date.parse(resultaat.event.eventTijd)));
    assert.equal(resultaat.bronId, undefined, 'de technische sleutel lekt niet als los veld');
  }
});

test('specificatie: MDTO-XML voor een vernietigde kandidaat, 409 zonder SUCCESS, 404 als niet aangeboden', async (t) => {
  const request = await metServer(t, parseScenario({ SCENARIO_CHANGED_PERCENTAGE: '50' }));
  const { kandidaten, pad } = await vernietigEersteKandidaten(request, 10);
  const batch = await request(`${pad}/batches/1`);
  const vernietigd = batch.body.resultaten.find((resultaat) => resultaat.resultaat === 'SUCCESS');
  const gewijzigd = batch.body.resultaten.find((resultaat) => resultaat.resultaat === 'CHANGED');
  const kandidaat = kandidaten.find((item) => item.vernietigingskandidaatId === vernietigd.vernietigingskandidaatId);

  const specificatie = await request(`${pad}/specificaties/${vernietigd.vernietigingskandidaatId}`);
  assert.equal(specificatie.status, 200);
  assert.match(specificatie.headers.get('content-type'), /application\/xml/);
  assert.match(specificatie.body, /<MDTO xmlns="https:\/\/www\.nationaalarchief\.nl\/mdto"/);
  assert.match(specificatie.body, /<begripLabel>Vernietigen<\/begripLabel>/);
  assert.equal(specificatie.body.match(/<bevatOnderdeel>/g)?.length ?? 0, kandidaat.aantalObjecten);
  valideerTegenXsd(t, specificatie.body);

  const nietVernietigd = await request(`${pad}/specificaties/${gewijzigd.vernietigingskandidaatId}`);
  assert.deepEqual([nietVernietigd.status, nietVernietigd.body.code], [409, 'SPECIFICATIE_NIET_BESCHIKBAAR']);
  const onbekend = await request(`${pad}/specificaties/vk-bestaat-niet`);
  assert.deepEqual([onbekend.status, onbekend.body.code], [404, 'KANDIDAAT_NOT_FOUND']);
});

test('met SCENARIO_LEVER_NIET_V levert de stekker ook kandidaten met waardering B', async () => {
  const standaard = await maakServices(parseScenario({})).selectieService.startSelectie({ peildatum: '2026-09-25' });
  const metB = await maakServices(parseScenario({ SCENARIO_LEVER_NIET_V: 'true' })).selectieService.startSelectie({ peildatum: '2026-09-25' });
  const bKandidaten = metB.kandidaten.filter((kandidaat) => kandidaat.waardering.begripCode === 'B');

  assert.equal(standaard.kandidaten.some((kandidaat) => kandidaat.waardering.begripCode !== 'V'), false);
  assert.ok(bKandidaten.length > 0);
  assert.equal(bKandidaten[0].waardering.begripLabel, 'Blijvend te bewaren');
  assert.equal(metB.totaalKandidaten, standaard.totaalKandidaten + bKandidaten.length);
});
