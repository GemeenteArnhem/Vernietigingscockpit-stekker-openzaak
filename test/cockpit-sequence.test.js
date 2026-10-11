import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';

const sequenceConfig = {
  peildatum: '2026-09-25',
  aantalKandidaten: Number.parseInt(process.env.SEQUENCE_AANTAL_KANDIDATEN || '25', 10),
  batchSize: Number.parseInt(process.env.SEQUENCE_BATCH_SIZE || '10', 10),
  pageSize: Number.parseInt(process.env.SEQUENCE_PAGE_SIZE || '50', 10),
  selectieDelayMs: Number.parseInt(process.env.SEQUENCE_SELECTIE_DELAY_MS || '100', 10),
  vernietigingDelayMs: Number.parseInt(process.env.SEQUENCE_VERNIETIGING_DELAY_MS || '50', 10),
  pollIntervalMs: 50,
  pollTimeoutMs: 10000
};

// Simuleert de Cockpit via HTTP, volgens de Stekker-OpenAPI-spec: selectie starten,
// alle kandidaten pagineren, vernietigen in meerdere batches met Idempotency-Keys,
// een herstart van de Cockpit halverwege, pollen tot een eindstatus en de
// integriteitscontrole "elke aangeboden kandidaat heeft precies één resultaat".
test('cockpit-sequence volgens de stekker-specificatie', async () => {
  const server = await startTestServer();

  try {
    const hostUrl = `http://127.0.0.1:${server.address().port}`;
    const baseUrl = `${hostUrl}/v2`;
    const taak = 'cockpit-sequence-taak-001';
    logStep(`Stekker gestart op ${baseUrl}`);

    const health = await httpJson(`${hostUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    logStep('Healthcheck OK');

    // Selectie
    const selectieStart = await httpJson(`${baseUrl}/selecties`, {
      method: 'POST',
      body: { peildatum: sequenceConfig.peildatum }
    });
    assert.equal(selectieStart.status, 202);
    assert.equal(selectieStart.body.status, 'RUNNING');
    logStep(`Selectie gestart: ${selectieStart.body.selectieId}`);

    const earlyObjects = await httpJson(`${baseUrl}/selecties/${selectieStart.body.selectieId}/vernietigingskandidaten?offset=0&limit=1`, {
      expectedStatuses: [409]
    });
    assert.equal(earlyObjects.body.code, 'SELECTIE_NOT_READY');
    logStep('Vroege objectopvraag geeft SELECTIE_NOT_READY');

    const selectie = await waitForReadySelection(baseUrl, selectieStart.body.selectieId);
    assert.equal(selectie.totaalKandidaten, 129);
    logStep(`Selectie READY met ${selectie.totaalKandidaten} kandidaten`);

    const kandidaten = await haalAlleKandidatenOp(baseUrl, selectie.selectieId);
    assert.equal(kandidaten.length, selectie.totaalKandidaten);
    assert.equal(new Set(kandidaten.map((kandidaat) => kandidaat.vernietigingskandidaatId)).size, kandidaten.length);
    logStep(`${kandidaten.length} kandidaten opgehaald in pagina's van ${sequenceConfig.pageSize}`);

    // Vernietiging, in deterministische volgorde en in meerdere batches
    const aangeboden = kandidaten
      .map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }))
      .sort((a, b) => a.vernietigingskandidaatId.localeCompare(b.vernietigingskandidaatId))
      .slice(0, sequenceConfig.aantalKandidaten);
    const batches = chunk(aangeboden, sequenceConfig.batchSize);

    const startVerzoek = {
      method: 'POST',
      headers: { 'Idempotency-Key': `${taak}:stekker:vernietiging` },
      body: {
        selectieId: selectie.selectieId,
        cockpitTaakId: taak,
        besluitReferentie: 'cockpit-sequence-besluit-001',
        vernietigingsdossierId: 'cockpit-sequence-dossier-001'
      }
    };
    const vernietigingStart = await httpJson(`${baseUrl}/vernietigingen`, startVerzoek);
    assert.equal(vernietigingStart.status, 202);
    assert.equal(vernietigingStart.body.status, 'IDLE');
    const vernietigingId = vernietigingStart.body.vernietigingId;
    logStep(`Vernietiging aangemaakt: ${vernietigingId}`);

    for (const [index, objecten] of batches.entries()) {
      const batch = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/batches`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `${taak}:stekker:batch:${index + 1}` },
        body: { batchNummer: index + 1, vernietigingskandidaten: objecten }
      });
      assert.equal(batch.status, 202);
      assert.equal(batch.body.batchNummer, index + 1);
    }
    logStep(`${batches.length} batches aangeleverd (${aangeboden.length} kandidaten)`);

    const vrijgaveVerzoek = {
      method: 'POST',
      headers: { 'Idempotency-Key': `${taak}:stekker:vrijgeven` },
      body: { aantalBatches: batches.length, aantalKandidaten: aangeboden.length }
    };
    const vrijgave = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/vrijgeven`, vrijgaveVerzoek);
    assert.equal(vrijgave.status, 202);
    assert.equal(vrijgave.body.status, 'RUNNING');
    logStep('Vernietiging vrijgegeven, status RUNNING');

    // Cockpit herstart: alle muterende calls worden met dezelfde keys herhaald.
    const herhaaldeStart = await httpJson(`${baseUrl}/vernietigingen`, startVerzoek);
    assert.equal(herhaaldeStart.body.vernietigingId, vernietigingId);
    const herhaaldeBatch = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/batches`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `${taak}:stekker:batch:1` },
      body: { batchNummer: 1, vernietigingskandidaten: batches[0] }
    });
    assert.equal(herhaaldeBatch.status, 202);
    const herhaaldeVrijgave = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/vrijgeven`, vrijgaveVerzoek);
    assert.equal(herhaaldeVrijgave.status, 202);
    assert.notEqual(herhaaldeVrijgave.body.status, 'IDLE');
    logStep('Herstart gesimuleerd: herhaalde calls met dezelfde keys leveren dezelfde vernietiging op');

    const afgerond = await waitForEindstatus(baseUrl, vernietigingId);
    assert.equal(afgerond.status, 'COMPLETED');
    assert.equal(afgerond.totaalBatches, batches.length);
    assert.equal(afgerond.totaalKandidaten, aangeboden.length);
    assert.equal(afgerond.succesvolVernietigd, aangeboden.length);
    logStep(`Vernietiging COMPLETED met ${afgerond.succesvolVernietigd} SUCCESS resultaten`);

    // Resultaten via de batch-endpoints, met integriteitscontrole
    const overzicht = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/batches`);
    assert.deepEqual(overzicht.body.map((batchResultaat) => batchResultaat.batchNummer), batches.map((_, index) => index + 1));

    const resultaten = [];
    for (const [index, objecten] of batches.entries()) {
      const batchResultaat = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}/batches/${index + 1}`);
      assert.equal(batchResultaat.body.resultaten.length, objecten.length);
      resultaten.push(...batchResultaat.body.resultaten);
    }

    const resultaatPerKandidaat = new Map();
    for (const resultaat of resultaten) {
      assert.equal(
        resultaatPerKandidaat.has(resultaat.vernietigingskandidaatId),
        false,
        `Dubbel resultaat voor ${resultaat.vernietigingskandidaatId}`
      );
      resultaatPerKandidaat.set(resultaat.vernietigingskandidaatId, resultaat);
    }
    for (const object of aangeboden) {
      assert.deepEqual(
        resultaatPerKandidaat.get(object.vernietigingskandidaatId)?.identificatie,
        object.identificatie,
        `Geen passend resultaat voor ${object.vernietigingskandidaatId}`
      );
    }
    assert.equal(resultaatPerKandidaat.size, aangeboden.length);
    assert.equal(resultaten.filter((resultaat) => resultaat.resultaat === 'SUCCESS').length, afgerond.succesvolVernietigd);
    logStep('Integriteitscontrole: elke aangeboden kandidaat heeft precies één resultaat, tellingen kloppen');

    // Tweede poging op een al vernietigde zaak
    const tweedeVernietiging = await httpJson(`${baseUrl}/vernietigingen`, {
      method: 'POST',
      body: {
        selectieId: selectie.selectieId,
        cockpitTaakId: 'cockpit-sequence-taak-002',
        besluitReferentie: 'cockpit-sequence-besluit-002'
      }
    });
    await httpJson(`${baseUrl}/vernietigingen/${tweedeVernietiging.body.vernietigingId}/batches`, {
      method: 'POST',
      body: { batchNummer: 1, vernietigingskandidaten: [aangeboden[0]] }
    });
    const tweedeVrijgave = await httpJson(`${baseUrl}/vernietigingen/${tweedeVernietiging.body.vernietigingId}/vrijgeven`, {
      method: 'POST',
      body: { aantalBatches: 1, aantalKandidaten: 1 }
    });
    assert.equal(tweedeVrijgave.status, 202);
    const tweedeAfgerond = await waitForEindstatus(baseUrl, tweedeVernietiging.body.vernietigingId);
    assert.equal(tweedeAfgerond.nietGevonden, 1);
    assert.equal(tweedeAfgerond.status, 'PARTIAL');
    logStep('Tweede poging op dezelfde zaak geeft NOT_FOUND en status PARTIAL');

    logStep('Cockpit sequence succesvol afgerond.');
  } finally {
    await closeServer(server);
  }
});

async function startTestServer() {
  const bron = new GeheugenBron();
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: sequenceConfig.selectieDelayMs
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    processingDelayMs: sequenceConfig.vernietigingDelayMs
  });
  const testServer = createHttpServer({ selectieService, vernietigingService, logRequests: false });

  testServer.listen(0, '127.0.0.1');
  await once(testServer, 'listening');
  return testServer;
}

async function waitForReadySelection(baseUrl, selectieId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < sequenceConfig.pollTimeoutMs) {
    const response = await httpJson(`${baseUrl}/selecties/${selectieId}`);

    if (response.body.status === 'READY') {
      return response.body;
    }

    if (response.body.status === 'FAILED') {
      throw new Error(`Selectie ${selectieId} is FAILED.`);
    }

    await sleep(sequenceConfig.pollIntervalMs);
  }

  throw new Error(`Selectie ${selectieId} werd niet READY binnen ${sequenceConfig.pollTimeoutMs}ms.`);
}

async function haalAlleKandidatenOp(baseUrl, selectieId) {
  const kandidaten = [];
  let totaal;

  do {
    const pagina = await httpJson(
      `${baseUrl}/selecties/${selectieId}/vernietigingskandidaten?offset=${kandidaten.length}&limit=${sequenceConfig.pageSize}`
    );
    totaal = pagina.body.totaal;

    if (pagina.body.items.length === 0) {
      break;
    }

    kandidaten.push(...pagina.body.items);
  } while (kandidaten.length < totaal);

  return kandidaten;
}

async function waitForEindstatus(baseUrl, vernietigingId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < sequenceConfig.pollTimeoutMs) {
    const response = await httpJson(`${baseUrl}/vernietigingen/${vernietigingId}`);

    if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(response.body.status)) {
      return response.body;
    }

    await sleep(sequenceConfig.pollIntervalMs);
  }

  throw new Error(`Vernietiging ${vernietigingId} bereikte geen eindstatus binnen ${sequenceConfig.pollTimeoutMs}ms.`);
}

async function httpJson(url, { method = 'GET', body, headers = {}, expectedStatuses } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const responseBody = await response.json();
  const allowedStatuses = expectedStatuses ?? Array.from({ length: 100 }, (_, index) => 200 + index);

  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`Onverwachte HTTP-status ${response.status} voor ${method} ${url}: ${JSON.stringify(responseBody)}`);
  }

  return {
    status: response.status,
    body: responseBody
  };
}

async function closeServer(testServer) {
  if (!testServer.listening) {
    return;
  }

  testServer.close();
  await once(testServer, 'close');
}

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logStep(message) {
  console.log(`[sequence] ${message}`);
}
