import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';

async function metServer(t, { selectieService, maxBodyBytes, logRequests = false } = {}) {
  // Foutlogging is in deze tests verwacht; houd de testuitvoer leesbaar.
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  const bron = new GeheugenBron();
  const selecties = selectieService ?? new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: 0
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService: selecties,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    processingDelayMs: 0
  });
  const server = createHttpServer({ selectieService: selecties, vernietigingService, maxBodyBytes, logRequests });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (pad, { method = 'GET', body, rawBody, headers = {} } = {}) => {
    // Stekker API v2: paden onder /v2 en een Idempotency-Key op elke POST (tenzij de test die zelf zet).
    const response = await fetch(`${baseUrl}/v2${pad}`, {
      method,
      headers: { ...(body || rawBody ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}), ...headers },
      body: rawBody ?? (body ? JSON.stringify(body) : undefined)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test('neemt X-Correlation-ID over in fout en response-header, met logReference', async (t) => {
  const request = await metServer(t);
  const response = await request('/selecties/onbekend', { headers: { 'X-Correlation-ID': 'taak-1:job-7' } });

  assert.equal(response.status, 404);
  assert.equal(response.body.correlatieId, 'taak-1:job-7');
  assert.equal(response.headers.get('x-correlation-id'), 'taak-1:job-7');
  assert.match(response.body.logReference, /^log-/);
});

test('genereert een correlatieId als de header ontbreekt of ongeldig is', async (t) => {
  const request = await metServer(t);
  const zonder = await request('/selecties/onbekend');
  const ongeldig = await request('/selecties/onbekend', { headers: { 'X-Correlation-ID': 'met spaties <script>' } });

  assert.ok(zonder.body.correlatieId);
  assert.ok(ongeldig.body.correlatieId);
  assert.notEqual(ongeldig.body.correlatieId, 'met spaties <script>');
  assert.equal(zonder.headers.get('x-correlation-id'), zonder.body.correlatieId);
});

test('geeft 400 bij ongeldige JSON, een niet-object of een te grote body', async (t) => {
  const request = await metServer(t, { maxBodyBytes: 200 });

  const ongeldig = await request('/selecties', { method: 'POST', rawBody: '{"peildatum":' });
  const lijst = await request('/selecties', { method: 'POST', rawBody: '[]' });
  const teGroot = await request('/vernietigingen', { method: 'POST', body: { selectieId: 'x'.repeat(500) } });

  assert.deepEqual([ongeldig.status, ongeldig.body.code], [400, 'INVALID_JSON']);
  assert.deepEqual([lijst.status, lijst.body.code], [400, 'VALIDATION_ERROR']);
  assert.deepEqual([teGroot.status, teGroot.body.code], [400, 'REQUEST_TOO_LARGE']);
});

test('valideert peildatum', async (t) => {
  const request = await metServer(t);

  for (const peildatum of ['2026-13-40', '25-09-2026', 20260925, '2026-02-30']) {
    const response = await request('/selecties', { method: 'POST', body: { peildatum } });
    assert.equal(response.status, 400, `peildatum ${peildatum}`);
  }

  const geldig = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const zonder = await request('/selecties', { method: 'POST', body: {} });
  assert.equal(geldig.status, 202);
  assert.equal(zonder.status, 202);
});

test('valideert offset en limit van de kandidatenpagina', async (t) => {
  const request = await metServer(t);
  const selectie = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const pad = `/selecties/${selectie.body.selectieId}/vernietigingskandidaten`;

  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=-1']) {
    const response = await request(`${pad}?${query}`);
    assert.equal(response.status, 400, query);
  }

  const maximaal = await request(`${pad}?offset=0&limit=500`);
  assert.equal(maximaal.status, 200);
  assert.equal(maximaal.body.limit, 500);
  assert.equal(maximaal.body.items.length, maximaal.body.totaal);
});

test('toont bij een 500 geen interne melding, wel een logReference', async (t) => {
  const kapotteSelectieService = {
    getSelectie() {
      throw new Error('geheim: https://openzaak.intern/zaken/api/v1/zaken?client_secret=x');
    }
  };
  const request = await metServer(t, { selectieService: kapotteSelectieService });
  const response = await request('/selecties/iets');

  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /geheim|openzaak|secret/);
  assert.match(response.body.logReference, /^log-/);
  assert.equal(console.error.mock.calls.length, 1);
  assert.match(console.error.mock.calls[0].arguments[0], new RegExp(response.body.logReference));
});

test('logt per request één regel met correlatieId, zonder body', async (t) => {
  const logregels = [];
  const request = await metServer(t, { logRequests: true });
  t.mock.method(console, 'log', (regel) => logregels.push(regel));

  await request('/selecties', {
    method: 'POST',
    body: { peildatum: '2026-09-25' },
    headers: { 'X-Correlation-ID': 'taak-9:job-1' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logregels.length, 1);
  const regel = JSON.parse(logregels[0]);
  assert.equal(regel.correlatieId, 'taak-9:job-1');
  assert.equal(regel.methode, 'POST');
  assert.equal(regel.pad, '/v2/selecties');
  assert.equal(regel.status, 202);
  assert.equal(typeof regel.duurMs, 'number');
  assert.doesNotMatch(logregels[0], /peildatum|2026-09-25/);
});

test('pagineert met een cursor: alle kandidaten precies één keer, laatste pagina zonder nextCursor', async (t) => {
  const request = await metServer(t);
  const selectie = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const pad = `/selecties/${selectie.body.selectieId}/vernietigingskandidaten`;
  const ids = [];
  let pagina = await request(`${pad}?limit=40`);
  let paginas = 1;

  ids.push(...pagina.body.items.map((kandidaat) => kandidaat.vernietigingskandidaatId));

  while (pagina.body.nextCursor) {
    pagina = await request(`${pad}?limit=40&cursor=${pagina.body.nextCursor}`);
    assert.equal(pagina.status, 200);
    ids.push(...pagina.body.items.map((kandidaat) => kandidaat.vernietigingskandidaatId));
    paginas += 1;
  }

  assert.equal(paginas, Math.ceil(pagina.body.totaal / 40));
  assert.equal(ids.length, pagina.body.totaal);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(pagina.body.cursor, 'pagina opgevraagd met cursor noemt die cursor');
});

test('weigert een ongeldige cursor, een cursor van een andere selectie en cursor samen met offset', async (t) => {
  const request = await metServer(t);
  const selectieA = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const selectieB = await request('/selecties', { method: 'POST', body: { peildatum: '2026-09-25' } });
  const padA = `/selecties/${selectieA.body.selectieId}/vernietigingskandidaten`;
  const cursorA = (await request(`${padA}?limit=10`)).body.nextCursor;
  const gemanipuleerd = Buffer.from(JSON.stringify({ s: selectieA.body.selectieId, o: -5 })).toString('base64url');

  for (const query of ['cursor=onzin', `cursor=${gemanipuleerd}`, `cursor=${cursorA}&offset=0`]) {
    assert.equal((await request(`${padA}?${query}`)).status, 400, query);
  }

  assert.equal((await request(`/selecties/${selectieB.body.selectieId}/vernietigingskandidaten?cursor=${cursorA}`)).status, 400);
});
