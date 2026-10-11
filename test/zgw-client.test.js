import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { parseOpenZaakConfig, STANDAARD_SELECTIELIJST_URL } from '../src/config/openzaak-config.js';
import { uuidUitUrl, ZgwClient, ZgwFout } from '../src/infrastructure/openzaak/zgw-client.js';
import { CLIENT_ID, NepOpenZaak, SECRET } from './helpers/nep-openzaak.js';

async function metOpenZaak(t, opties) {
  const openZaak = await new NepOpenZaak(opties).start();
  t.after(() => openZaak.stop());
  const client = new ZgwClient({ diensten: openZaak.diensten, clientId: CLIENT_ID, secret: SECRET, wachttijdMs: 0, timeoutMs: 2000 });
  return { openZaak, client };
}

test('ondertekent elk verzoek met een geldig ZGW-JWT (HS256, client-id, iat)', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042' });

  const opgehaald = await client.get(zaak);
  const [kop, inhoud, handtekening] = client.token().split('.');

  assert.equal(opgehaald.identificatie, 'ZAAK-2018-0042');
  assert.equal(openZaak.laatsteClaims.client_id, CLIENT_ID);
  assert.equal(openZaak.laatsteClaims.iss, CLIENT_ID);
  assert.ok(Number.isInteger(openZaak.laatsteClaims.iat));
  assert.deepEqual(JSON.parse(Buffer.from(kop, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.equal(handtekening, crypto.createHmac('sha256', SECRET).update(`${kop}.${inhoud}`).digest('base64url'));
});

test('een verkeerd secret geeft een ZgwFout 403, zonder token in de melding', async (t) => {
  const { openZaak } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0001' });
  const client = new ZgwClient({ diensten: openZaak.diensten, clientId: CLIENT_ID, secret: 'fout', wachttijdMs: 0 });

  await assert.rejects(client.get(zaak), (error) => {
    assert.ok(error instanceof ZgwFout);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'permission_denied');
    assert.doesNotMatch(error.message, /Bearer|eyJ|fout/);
    return true;
  });
});

test('volgt de paginering tot de laatste pagina en stuurt Accept-Crs mee', async (t) => {
  const { openZaak, client } = await metOpenZaak(t, { paginaGrootte: 3 });

  for (let nummer = 1; nummer <= 8; nummer += 1) {
    openZaak.voegZaakToe({ identificatie: `ZAAK-2018-${String(nummer).padStart(4, '0')}`, documenten: 0 });
  }

  const zaken = await client.alle(client.url('zaken', 'zaken'), { params: { archiefnominatie: 'vernietigen' } });

  assert.equal(zaken.length, 8);
  assert.equal(new Set(zaken.map((zaak) => zaak.url)).size, 8);
  assert.equal(openZaak.log.filter((regel) => regel === 'GET /zaken/api/v1/zaken').length, 3);
});

test('ongepagineerde lijsten (zaakinformatieobjecten) komen in één keer', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042', documenten: 3 });

  const zios = await client.alle(client.url('zaken', 'zaakinformatieobjecten'), { params: { zaak } });

  assert.equal(zios.length, 3);
  assert.equal(zios.every((zio) => zio.zaak === zaak), true);
});

test('expand levert zaaktype, resultaat en resultaattype in _expand', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042' });

  const [zaak] = await client.alle(client.url('zaken', 'zaken'), {
    params: { expand: 'resultaat,resultaat.resultaattype,zaaktype,rollen' }
  });

  assert.equal(zaak._expand.zaaktype.identificatie, 'WMO-AANVRAAG');
  assert.equal(zaak._expand.resultaat._expand.resultaattype.archiefactietermijn, 'P7Y');
  assert.equal(zaak._expand.rollen.length, 1);
});

test('weigert URL\'s buiten de ingestelde API-roots, ook als Open Zaak ze aanlevert', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  // Een gemanipuleerd antwoord met een `next` naar een andere host.
  openZaak.storing({ methode: 'GET', pad: /\/zaken$/, status: 200, body: { count: 2, next: 'https://elders.example/zaken/api/v1/zaken?page=2', results: [{}] } });

  await assert.rejects(client.alle(client.url('zaken', 'zaken')), (error) => error.code === 'ONBEKENDE_URL');
  await assert.rejects(client.verwijder('https://elders.example/documenten/api/v1/enkelvoudiginformatieobjecten/1'), (error) => error.code === 'ONBEKENDE_URL');
  await assert.rejects(client.get(`${openZaak.basis}/andere-api/v1/x`), (error) => error.code === 'ONBEKENDE_URL');
});

test('herhaalt een GET bij een tijdelijke fout, maar niet bij een blijvende', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042' });

  openZaak.storing({ methode: 'GET', pad: /\/zaken\//, status: 503, keer: 2 });
  assert.equal((await client.get(zaak)).identificatie, 'ZAAK-2018-0042');

  openZaak.storing({ methode: 'GET', pad: /\/zaken\//, status: 500, keer: 1 });
  await assert.rejects(client.get(zaak), (error) => error.status === 500);
  assert.equal((await client.get(zaak)).identificatie, 'ZAAK-2018-0042');
});

test('een DELETE wordt door de client niet herhaald', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { documenten } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042', documenten: 1 });
  openZaak.storing({ methode: 'DELETE', status: 503, keer: 1 });

  await assert.rejects(client.verwijder(documenten[0]), (error) => error.status === 503 && error.tijdelijk);
  assert.equal(openZaak.log.filter((regel) => regel.startsWith('DELETE')).length, 1);
});

test('verwijder: 204 = verwijderd, 404 = niet-gevonden, pending-relations = blijft bestaan', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak, documenten } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042', documenten: 1 });
  const zio = (await client.alle(client.url('zaken', 'zaakinformatieobjecten'), { params: { zaak } }))[0].url;

  assert.equal(await client.verwijder(documenten[0]), 'pending-relations');
  assert.equal(openZaak.bestaat(documenten[0]), true);
  assert.equal(await client.verwijder(zio), 'verwijderd');
  assert.equal(await client.verwijder(documenten[0]), 'verwijderd');
  assert.equal(await client.verwijder(documenten[0]), 'niet-gevonden');
});

test('een 500 nádat de DELETE is uitgevoerd (Open Zaak 1.30.0) telt als verwijderd', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak, documenten } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042', documenten: 1 });
  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 500, naUitvoeren: true });

  assert.equal(await client.verwijder(zaak), 'verwijderd');
  assert.equal(openZaak.bestaat(zaak), false);

  // Een 500 waarbij de resource nog bestaat, blijft een fout.
  openZaak.storing({ methode: 'DELETE', status: 500 });
  await assert.rejects(client.verwijder(documenten[0]), (error) => error.status === 500);
  assert.equal(openZaak.bestaat(documenten[0]), true);
});

test('een andere 400 dan pending-relations is een fout', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042' });
  openZaak.storing({ methode: 'DELETE', status: 400, body: { code: 'invalid', detail: 'Iets anders', invalidParams: [{ name: 'x', code: 'invalid' }] } });

  await assert.rejects(client.verwijder(zaak), (error) => error.status === 400 && /Iets anders/.test(error.message));
});

test('geen antwoord binnen de time-out geeft een tijdelijke ZgwFout TIMEOUT', async (t) => {
  const { openZaak } = await metOpenZaak(t);
  const { zaak } = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0042' });
  const client = new ZgwClient({ diensten: openZaak.diensten, clientId: CLIENT_ID, secret: SECRET, timeoutMs: 50, maxPogingen: 1 });
  openZaak.vertragingMs = 500;

  await assert.rejects(client.get(zaak), (error) => error.code === 'TIMEOUT' && error.tijdelijk);
});

test('een onbereikbare Open Zaak geeft een tijdelijke ZgwFout NETWERKFOUT', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const client = new ZgwClient({ diensten: { zaken: `http://127.0.0.1:${port}/zaken/api/v1/` }, clientId: 'x', secret: 'y', maxPogingen: 1 });

  await assert.rejects(client.get(client.url('zaken', 'zaken')), (error) => error.code === 'NETWERKFOUT' && error.tijdelijk);
});

test('de Selectielijst API krijgt geen token', async (t) => {
  const { openZaak, client } = await metOpenZaak(t);
  const { procestype } = openZaak.maakZaaktype();
  openZaak.laatsteClaims = undefined;

  const opgehaald = await client.get(procestype);

  assert.equal(opgehaald.jaar, 2020);
  assert.equal(openZaak.laatsteClaims, undefined);
});

test('uuidUitUrl geeft het laatste padsegment', () => {
  assert.equal(uuidUitUrl('https://oz.test/zaken/api/v1/zaken/abc-123'), 'abc-123');
  assert.equal(uuidUitUrl('https://oz.test/zaken/api/v1/zaken/abc-123/'), 'abc-123');
});

test('configuratie: alle verplichte instellingen in één melding, URL\'s genormaliseerd', () => {
  assert.throws(() => parseOpenZaakConfig({}), (error) => {
    for (const naam of ['OPENZAAK_ZAKEN_URL', 'OPENZAAK_DOCUMENTEN_URL', 'OPENZAAK_BESLUITEN_URL', 'OPENZAAK_CATALOGI_URL', 'OPENZAAK_CLIENT_ID', 'OPENZAAK_SECRET']) {
      assert.match(error.message, new RegExp(naam));
    }
    return true;
  });

  const config = parseOpenZaakConfig({
    OPENZAAK_ZAKEN_URL: 'http://openzaak:8000/zaken/api/v1',
    OPENZAAK_DOCUMENTEN_URL: 'http://openzaak:8000/documenten/api/v1/',
    OPENZAAK_BESLUITEN_URL: 'http://openzaak:8000/besluiten/api/v1/',
    OPENZAAK_CATALOGI_URL: 'http://openzaak:8000/catalogi/api/v1/',
    OPENZAAK_CLIENT_ID: 'stekker',
    OPENZAAK_SECRET: 'geheim'
  });

  assert.equal(config.diensten.zaken, 'http://openzaak:8000/zaken/api/v1/');
  assert.equal(config.diensten.selectielijst, STANDAARD_SELECTIELIJST_URL);
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.parallel, 8);

  assert.throws(
    () => parseOpenZaakConfig({ ...{ OPENZAAK_CLIENT_ID: 'a', OPENZAAK_SECRET: 'b' }, OPENZAAK_ZAKEN_URL: 'ftp://x/', OPENZAAK_DOCUMENTEN_URL: 'https://u:p@x/', OPENZAAK_BESLUITEN_URL: 'https://x/?a=1', OPENZAAK_CATALOGI_URL: 'geen url' }),
    /OPENZAAK_ZAKEN_URL moet een http\(s\)-URL zijn.*OPENZAAK_DOCUMENTEN_URL mag geen.*OPENZAAK_BESLUITEN_URL mag geen.*OPENZAAK_CATALOGI_URL is geen geldige URL/
  );
});
