import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { createAuthenticator } from '../src/api/jwt-auth.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { parseAuthConfig } from '../src/config/auth-config.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';

const ISSUER = 'https://idp.test/realms/vernietigingscockpit';
const AUDIENCE = 'teststekker';
const ALLE_SCOPES = 'selectie.read selectie.write vernietiging.read vernietiging.write';

function maakSleutel(kid, type = 'rsa') {
  const { privateKey, publicKey } = type === 'rsa'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, alg: type === 'rsa' ? 'RS256' : 'ES256', jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

function maakToken(sleutel, claims = {}, headerExtra = {}) {
  const nu = Math.floor(Date.now() / 1000);
  const header = { alg: sleutel.alg, typ: 'JWT', kid: sleutel.kid, ...headerExtra };
  const payload = { iss: ISSUER, aud: AUDIENCE, exp: nu + 300, iat: nu, scope: ALLE_SCOPES, ...claims };
  const ondertekend = `${base64url(header)}.${base64url(payload)}`;
  const handtekening = crypto.sign('sha256', Buffer.from(ondertekend), {
    key: sleutel.privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${ondertekend}.${handtekening.toString('base64url')}`;
}

function base64url(waarde) {
  return Buffer.from(JSON.stringify(waarde)).toString('base64url');
}

// Tijdelijke identity provider die alleen een JWKS serveert.
async function startJwks(t, sleutels) {
  const idp = { sleutels, aantalOpvragingen: 0 };
  const server = http.createServer((request, response) => {
    idp.aantalOpvragingen += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: idp.sleutels.map((sleutel) => sleutel.jwk) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  idp.url = `http://127.0.0.1:${server.address().port}/certs`;
  return idp;
}

async function startStekker(t, authenticator) {
  t.mock.method(console, 'warn', () => {});
  const bron = new GeheugenBron();
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    processingDelayMs: 0
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    processingDelayMs: 0
  });
  const server = createHttpServer({ selectieService, vernietigingService, authenticator, logRequests: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (pad, { method = 'GET', token, body } = {}) => {
    const response = await fetch(pad === '/health' ? `${baseUrl}${pad}` : `${baseUrl}/v2${pad}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

async function opzet(t, sleutels = [maakSleutel('rsa-1')], opties = {}) {
  const idp = await startJwks(t, sleutels);
  const authenticator = createAuthenticator({ enabled: true, issuer: ISSUER, jwksUrl: idp.url, audience: AUDIENCE, ...opties });
  return { idp, request: await startStekker(t, authenticator) };
}

test('parseAuthConfig: standaard uit, en aan zonder issuer of JWKS-URL faalt bij opstarten', () => {
  assert.equal(parseAuthConfig({}).enabled, false);
  assert.throws(() => parseAuthConfig({ AUTH_ENABLED: 'true' }), /AUTH_ISSUER en AUTH_JWKS_URL/);
  assert.throws(() => parseAuthConfig({ AUTH_ENABLED: 'true', AUTH_ISSUER: ISSUER }), /AUTH_JWKS_URL/);
  assert.deepEqual(
    parseAuthConfig({ AUTH_ENABLED: 'true', AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: 'https://idp.test/certs' }),
    { enabled: true, issuer: ISSUER, jwksUrl: 'https://idp.test/certs', audience: undefined }
  );
});

test('geldig RS256- en ES256-token geeft toegang; /health blijft openbaar', async (t) => {
  const rsa = maakSleutel('rsa-1');
  const ec = maakSleutel('ec-1', 'ec');
  const { request } = await opzet(t, [rsa, ec]);

  assert.equal((await request('/selecties', { method: 'POST', token: maakToken(rsa), body: {} })).status, 202);
  assert.equal((await request('/selecties', { method: 'POST', token: maakToken(ec), body: {} })).status, 202);
  assert.equal((await request('/health')).status, 200);
});

test('zonder of met een ongeldig token volgt 401 met WWW-Authenticate', async (t) => {
  const sleutel = maakSleutel('rsa-1');
  const vreemdeSleutel = maakSleutel('rsa-1');
  const { request } = await opzet(t, [sleutel]);
  const [kop, inhoud] = maakToken(sleutel).split('.');
  const nu = Math.floor(Date.now() / 1000);

  const gevallen = {
    'geen token': undefined,
    'geen JWT': 'abc.def',
    'andere ondertekenaar': maakToken(vreemdeSleutel),
    'alg none': `${base64url({ alg: 'none', kid: 'rsa-1' })}.${inhoud}.`,
    'alg HS256': `${base64url({ alg: 'HS256', kid: 'rsa-1' })}.${inhoud}.${crypto.createHmac('sha256', 'x').update(`${kop}.${inhoud}`).digest('base64url')}`,
    'verlopen': maakToken(sleutel, { exp: nu - 120 }),
    'nog niet geldig': maakToken(sleutel, { nbf: nu + 120 }),
    'zonder exp': maakToken(sleutel, { exp: undefined }),
    'verkeerde issuer': maakToken(sleutel, { iss: 'https://andere-idp.test' }),
    'verkeerde audience': maakToken(sleutel, { aud: 'cockpit-api' }),
    'onbekende kid': maakToken(sleutel, {}, { kid: 'bestaat-niet' })
  };

  for (const [geval, token] of Object.entries(gevallen)) {
    const response = await request('/selecties/iets', { token });
    assert.equal(response.status, 401, geval);
    assert.equal(response.body.code, 'UNAUTHORIZED', geval);
    assert.match(response.headers.get('www-authenticate'), /^Bearer error="invalid_(token|request)"$/, geval);
  }
});

test('ontbrekende scope geeft 403 insufficient_scope, per endpoint', async (t) => {
  const sleutel = maakSleutel('rsa-1');
  const { request } = await opzet(t, [sleutel]);
  const alleenLezen = maakToken(sleutel, { scope: 'selectie.read vernietiging.read' });
  const scpArray = maakToken(sleutel, { scope: undefined, scp: ['selectie.write'] });

  const schrijven = await request('/selecties', { method: 'POST', token: alleenLezen, body: {} });
  assert.equal(schrijven.status, 403);
  assert.equal(schrijven.body.code, 'FORBIDDEN');
  assert.equal(schrijven.headers.get('www-authenticate'), 'Bearer error="insufficient_scope"');

  assert.equal((await request('/vernietigingen/bestaat-niet', { token: alleenLezen })).status, 404);
  assert.equal((await request('/vernietigingen', { method: 'POST', token: alleenLezen, body: {} })).status, 403);
  assert.equal((await request('/selecties', { method: 'POST', token: scpArray, body: {} })).status, 202);
});

test('sleutelrotatie: een nieuwe kid leidt tot opnieuw ophalen, maar niet vaker dan toegestaan', async (t) => {
  const oud = maakSleutel('rsa-oud');
  const nieuw = maakSleutel('rsa-nieuw');
  let nu = Date.now();
  const { idp, request } = await opzet(t, [oud], { now: () => nu, jwksMinRefreshMs: 30000 });

  assert.equal((await request('/selecties/iets', { token: maakToken(oud) })).status, 404);
  assert.equal(idp.aantalOpvragingen, 1);

  // De IdP roteert; binnen 30 s na de vorige opvraging wordt de JWKS niet opnieuw opgehaald.
  idp.sleutels = [oud, nieuw];
  assert.equal((await request('/selecties/iets', { token: maakToken(nieuw) })).status, 401);
  assert.equal(idp.aantalOpvragingen, 1);

  nu += 31000;
  assert.equal((await request('/selecties/iets', { token: maakToken(nieuw) })).status, 404);
  assert.equal(idp.aantalOpvragingen, 2);
});

test('met auth uit is alles toegankelijk zonder token', async (t) => {
  const request = await startStekker(t, createAuthenticator({ enabled: false }));
  assert.equal((await request('/selecties', { method: 'POST', body: {} })).status, 202);
});

test('een hangende identity provider leidt binnen de time-out tot 401, niet tot een hangend request', async (t) => {
  const hangendeIdp = http.createServer(() => {
    // Antwoordt nooit.
  });
  hangendeIdp.listen(0, '127.0.0.1');
  await once(hangendeIdp, 'listening');
  t.after(() => {
    hangendeIdp.closeAllConnections();
    hangendeIdp.close();
  });

  const authenticator = createAuthenticator({
    enabled: true,
    issuer: ISSUER,
    jwksUrl: `http://127.0.0.1:${hangendeIdp.address().port}/certs`,
    jwksTimeoutMs: 200
  });
  const request = await startStekker(t, authenticator);

  const start = Date.now();
  const response = await request('/selecties/iets', { token: maakToken(maakSleutel('rsa-1')) });

  assert.equal(response.status, 401);
  assert.ok(Date.now() - start < 2000, `request duurde ${Date.now() - start} ms`);
});

test('gelijktijdige requests delen één JWKS-opvraging', async (t) => {
  const sleutel = maakSleutel('rsa-1');
  const { idp, request } = await opzet(t, [sleutel]);
  const token = maakToken(sleutel);

  const antwoorden = await Promise.all(Array.from({ length: 10 }, () => request('/selecties/iets', { token })));

  assert.equal(antwoorden.every((antwoord) => antwoord.status === 404), true);
  assert.equal(idp.aantalOpvragingen, 1);
});
