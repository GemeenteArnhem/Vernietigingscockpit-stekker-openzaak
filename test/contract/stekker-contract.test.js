import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../../src/api/http-server.js';
import { SelectieService } from '../../src/application/selectie-service.js';
import { VernietigingService } from '../../src/application/vernietiging-service.js';
import { GeheugenBron } from '../helpers/geheugen-bron.js';
import { InMemorySelectieRepository } from '../../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../../src/infrastructure/repositories/in-memory-vernietiging-repository.js';
import { loadContract } from './openapi-contract.js';

const contract = loadContract();
const EINDSTATUSSEN = ['COMPLETED', 'PARTIAL', 'FAILED'];
const POLL_TIMEOUT_MS = 10000;

// Doorloopt de volledige cockpit-sequence en legt elke call vast. Daarna wordt
// per call getoetst aan de spec: HTTP-status én responsebody.
// De driver leest bewust zowel spec- als afwijkende veldnamen, zodat de flow
// doorloopt en alle afwijkingen in één run zichtbaar worden. De toetsing
// zelf gebeurt uitsluitend tegen de spec.
const calls = await runSequence();

for (const call of calls) {
  test(`${call.method} ${call.pathTemplate} → ${call.verwacht}`, () => {
    const fouten = [];

    if (call.status !== call.expectedStatus) {
      fouten.push(`HTTP-status ${call.status}, spec verwacht ${call.expectedStatus}`);
    }

    fouten.push(...contract.validateResponse(call));

    // API Design Rules API-57: elke response meldt de volledige API-versie.
    if (call.apiVersion !== contract.spec.info.version) {
      fouten.push(`API-Version is ${call.apiVersion}, spec is ${contract.spec.info.version}`);
    }

    // Elke fout moet herleidbaar zijn: correlatieId en logReference zijn in de spec optioneel,
    // maar de referentie-implementatie vult ze altijd.
    if (call.status >= 400 && !(call.body.correlatieId && call.body.logReference)) {
      fouten.push('Fout mist correlatieId of logReference');
    }
    assert.deepEqual(fouten, [], `Afwijkingen van de spec:\n  - ${fouten.join('\n  - ')}`);
  });
}

async function runSequence() {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const recorded = [];

  const call = async (method, pathTemplate, params, { body, rawBody, query = '', headers = {}, expectedStatus, verwacht } = {}) => {
    const url = Object.entries(params).reduce(
      (current, [key, value]) => current.replace(`{${key}}`, encodeURIComponent(value)),
      pathTemplate
    );
    const response = await fetch(`${baseUrl}/v2${url}${query}`, {
      method,
      headers: { ...(body || rawBody ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}), ...headers },
      body: rawBody ?? (body ? JSON.stringify(body) : undefined)
    });
    const result = {
      method,
      pathTemplate,
      status: response.status,
      expectedStatus: expectedStatus ?? contract.successStatus(method, pathTemplate),
      verwacht: verwacht ?? 'succes',
      apiVersion: response.headers.get('api-version'),
      body: response.headers.get('content-type')?.includes('xml') ? await response.text() : await response.json()
    };
    recorded.push(result);
    return result;
  };

  try {
    const selectieStart = await call('POST', '/selecties', {}, { body: { peildatum: '2026-09-25' } });
    const selectieId = selectieStart.body.selectieId;
    const selectie = await pollTot(
      () => call('GET', '/selecties/{selectieId}', { selectieId }),
      (response) => ['READY', 'FAILED'].includes(selectieStatus(response.body))
    );
    assert.equal(selectieStatus(selectie.body), 'READY', 'Selectie werd niet READY; contractflow kan niet verder.');

    const pagina = await call('GET', '/selecties/{selectieId}/vernietigingskandidaten', { selectieId }, {});
    const kandidaten = (pagina.body.items ?? pagina.body.objecten).slice(0, 3);
    const objecten = kandidaten.map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));

    const vernietigingStart = await call('POST', '/vernietigingen', {}, {
      body: {
        selectieId,
        cockpitTaakId: 'taak-contracttest',
        vernietigingsdossierId: 'dossier-contracttest',
        besluitReferentie: 'besluit-contracttest'
      }
    });
    const vernietigingId = vernietigingStart.body.vernietigingId;

    await call('POST', '/vernietigingen/{vernietigingId}/batches', { vernietigingId }, {
      body: { batchNummer: 1, vernietigingskandidaten: objecten }
    });
    await call('POST', '/vernietigingen/{vernietigingId}/vrijgeven', { vernietigingId }, {
      body: { aantalBatches: 1, aantalKandidaten: objecten.length }
    });
    await pollTot(
      () => call('GET', '/vernietigingen/{vernietigingId}', { vernietigingId }),
      (response) => EINDSTATUSSEN.includes(response.body.status)
    );
    await call('GET', '/vernietigingen/{vernietigingId}/batches', { vernietigingId });
    await call('GET', '/vernietigingen/{vernietigingId}/batches/{batchNummer}', { vernietigingId, batchNummer: 1 });
    await call('GET', '/vernietigingen/{vernietigingId}/specificaties/{vernietigingskandidaatId}', {
      vernietigingId,
      vernietigingskandidaatId: kandidaten[0].vernietigingskandidaatId
    }, { verwacht: 'MDTO-XML-specificatie' });
    await call('POST', '/selecties', {}, {
      body: { peildatum: '2026-09-25' },
      headers: { 'Idempotency-Key': '' },
      expectedStatus: 400,
      verwacht: '400 Fout (Idempotency-Key ontbreekt)'
    });

    // Foutpaden: de stekker moet het Fout-schema met een gedocumenteerde status teruggeven.
    await call('GET', '/selecties/{selectieId}', { selectieId: 'bestaat-niet' }, { expectedStatus: 404, verwacht: '404 Fout' });
    await call('GET', '/vernietigingen/{vernietigingId}', { vernietigingId: 'bestaat-niet' }, { expectedStatus: 404, verwacht: '404 Fout' });
    await call('POST', '/vernietigingen', {}, { body: { selectieId }, expectedStatus: 400, verwacht: '400 Fout' });
    await call('POST', '/selecties', {}, { rawBody: '{"peildatum":', expectedStatus: 400, verwacht: '400 Fout (ongeldige JSON)' });
    await call('POST', '/selecties', {}, { body: { peildatum: '2026-13-40' }, expectedStatus: 400, verwacht: '400 Fout (ongeldige peildatum)' });
    await call('GET', '/selecties/{selectieId}/vernietigingskandidaten', { selectieId }, { query: '?limit=501', expectedStatus: 400, verwacht: '400 Fout (limit > 500)' });
    const eerstePagina = await call('GET', '/selecties/{selectieId}/vernietigingskandidaten', { selectieId }, { query: '?limit=50', verwacht: 'pagina met nextCursor' });
    assert.ok(eerstePagina.body.nextCursor, 'Een pagina met meer resultaten hoort een nextCursor te hebben.');
    await call('GET', '/selecties/{selectieId}/vernietigingskandidaten', { selectieId }, {
      query: `?limit=50&cursor=${eerstePagina.body.nextCursor}`,
      verwacht: 'pagina via cursor'
    });
    await call('GET', '/vernietigingen/{vernietigingId}/batches/{batchNummer}', { vernietigingId, batchNummer: 99 }, {
      expectedStatus: 404,
      verwacht: '404 Fout'
    });

    const tweede = await call('POST', '/vernietigingen', {}, {
      body: { selectieId, cockpitTaakId: 'taak-contracttest-2', besluitReferentie: 'besluit-contracttest-2' },
      verwacht: 'tweede vernietiging voor foutpaden'
    });
    const tweedeId = tweede.body.vernietigingId;

    const idempotentVerzoek = {
      body: { selectieId, cockpitTaakId: 'taak-contracttest-3', besluitReferentie: 'besluit-contracttest-3' },
      headers: { 'Idempotency-Key': 'taak-contracttest-3:vernietiging' }
    };
    const origineel = await call('POST', '/vernietigingen', {}, { ...idempotentVerzoek, verwacht: 'met Idempotency-Key' });
    const herhaling = await call('POST', '/vernietigingen', {}, { ...idempotentVerzoek, verwacht: 'herhaling met dezelfde Idempotency-Key' });
    assert.equal(herhaling.body.vernietigingId, origineel.body.vernietigingId, 'Herhaling met dezelfde key moet dezelfde vernietiging opleveren.');
    await call('POST', '/vernietigingen', {}, {
      body: { ...idempotentVerzoek.body, besluitReferentie: 'ander-besluit' },
      headers: idempotentVerzoek.headers,
      expectedStatus: 409,
      verwacht: '409 Fout (Idempotency-Key met andere inhoud)'
    });
    const [eerste, volgende] = (pagina.body.items ?? pagina.body.objecten).slice(3, 5)
      .map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));

    await call('POST', '/vernietigingen/{vernietigingId}/batches', { vernietigingId: tweedeId }, {
      body: { batchNummer: 1, vernietigingskandidaten: [{ ...eerste, identificatie: volgende.identificatie }] },
      expectedStatus: 400,
      verwacht: '400 Fout (identificatie hoort niet bij kandidaat)'
    });
    await call('POST', '/vernietigingen/{vernietigingId}/batches', { vernietigingId: tweedeId }, {
      body: { batchNummer: 1, vernietigingskandidaten: [eerste] },
      verwacht: 'geldige batch'
    });
    await call('POST', '/vernietigingen/{vernietigingId}/batches', { vernietigingId: tweedeId }, {
      body: { batchNummer: 2, vernietigingskandidaten: [volgende, eerste] },
      expectedStatus: 409,
      verwacht: '409 Fout (kandidaat al aangeleverd)'
    });
  } finally {
    server.close();
    await once(server, 'close');
  }

  // Polls tellen als één call: alleen de laatste response wordt getoetst.
  return dedupePolls(recorded);
}

function selectieStatus(body) {
  return body.status ?? body.selectiestatus;
}

async function pollTot(doCall, isKlaar) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const response = await doCall();

    if (response.status >= 400 || isKlaar(response)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Time-out tijdens pollen in contracttest.');
}

function dedupePolls(recorded) {
  return recorded.filter((call, index) => {
    const next = recorded[index + 1];
    return !(next && next.method === 'GET' && call.method === 'GET'
      && next.pathTemplate === call.pathTemplate && next.verwacht === call.verwacht
      && JSON.stringify(next.body.selectieId ?? next.body.vernietigingId) === JSON.stringify(call.body.selectieId ?? call.body.vernietigingId));
  });
}

async function startTestServer() {
  const bron = new GeheugenBron();
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: 50
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    processingDelayMs: 20,
    vernietigingRepository: new InMemoryVernietigingRepository()
  });
  const server = createHttpServer({ selectieService, vernietigingService, logRequests: false });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
