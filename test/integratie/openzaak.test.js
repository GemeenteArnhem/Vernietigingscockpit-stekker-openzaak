import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpServer } from '../../src/api/http-server.js';
import { SelectieService } from '../../src/application/selectie-service.js';
import { VernietigingService } from '../../src/application/vernietiging-service.js';
import { parseOpenZaakConfig } from '../../src/config/openzaak-config.js';
import { OpenZaakBron } from '../../src/infrastructure/openzaak/openzaak-bron.js';
import { maakZgwToken, ZgwClient } from '../../src/infrastructure/openzaak/zgw-client.js';
import { FileJournaalRepository } from '../../src/infrastructure/repositories/file-journaal-repository.js';
import { FileSelectieRepository } from '../../src/infrastructure/repositories/file-selectie-repository.js';
import { FileVernietigingRepository } from '../../src/infrastructure/repositories/file-vernietiging-repository.js';
import { loadContract } from '../contract/openapi-contract.js';
import { valideerTegenXsd } from '../helpers/xsd.js';

// Integratietest tegen een echte Open Zaak 1.30.0, gevuld door scripts/seed-openzaak.mjs.
// Draait via `npm run test:openzaak` (scripts/openzaak-test.mjs); de tests bouwen op elkaar
// voort en draaien daarom na elkaar.

const seed = JSON.parse(fs.readFileSync(process.env.OPENZAAK_SEED_BESTAND, 'utf8'));
const basis = process.env.OPENZAAK_URL;
const config = parseOpenZaakConfig({
  OPENZAAK_ZAKEN_URL: `${basis}/zaken/api/v1/`,
  OPENZAAK_DOCUMENTEN_URL: `${basis}/documenten/api/v1/`,
  OPENZAAK_BESLUITEN_URL: `${basis}/besluiten/api/v1/`,
  OPENZAAK_CATALOGI_URL: `${basis}/catalogi/api/v1/`,
  OPENZAAK_CLIENT_ID: process.env.OPENZAAK_CLIENT_ID,
  OPENZAAK_SECRET: process.env.OPENZAAK_SECRET
});
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'stekker-oz-runtime-'));
const client = new ZgwClient({ ...config, wachttijdMs: 200 });
const bron = new OpenZaakBron({ client, parallel: config.parallel });
const selectieService = new SelectieService({ bron, selectieRepository: new FileSelectieRepository(path.join(runtime, 'selecties')), processingDelayMs: 0 });
const vernietigingService = new VernietigingService({
  bron,
  selectieService,
  vernietigingRepository: new FileVernietigingRepository(path.join(runtime, 'vernietigingen')),
  journaalRepository: new FileJournaalRepository(path.join(runtime, 'journaal')),
  processingDelayMs: 0,
  maxPogingen: 3,
  wachttijdPogingMs: 200
});
const z = seed.zaken;
let selectie;

test.after(() => fs.rmSync(runtime, { recursive: true, force: true }));

const nummer = (kandidaat) => kandidaat.identificatie[1].identificatieKenmerk;
const kandidaat = (zaak) => selectie.kandidaten.find((item) => item.bronId === zaak.url);
const object = (item) => ({ vernietigingskandidaatId: item.vernietigingskandidaatId, identificatie: item.identificatie });

async function vernietig(zaken) {
  const { vernietigingId } = vernietigingService.startVernietiging({ selectieId: selectie.selectieId, cockpitTaakId: 'taak-int', besluitReferentie: 'besluit-int' });
  vernietigingService.voegBatchToe(vernietigingId, { batchNummer: 1, vernietigingskandidaten: zaken.map((zaak) => object(kandidaat(zaak))) });
  return vernietigingService.vrijgeven(vernietigingId, { aantalBatches: 1, aantalKandidaten: zaken.length });
}

// Met het seed-account (alle rechten) zoals een medewerker in het zaaksysteem.
async function alsSeed(methode, url, body) {
  const response = await fetch(url.startsWith('http') ? url : `${basis}${url}`, {
    method: methode,
    headers: {
      Authorization: `Bearer ${maakZgwToken({ clientId: process.env.OPENZAAK_SEED_CLIENT_ID, secret: process.env.OPENZAAK_SEED_SECRET })}`,
      'Accept-Crs': 'EPSG:4326',
      'Content-Crs': 'EPSG:4326',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const tekst = await response.text();
  return { status: response.status, body: tekst ? JSON.parse(tekst) : undefined };
}

const bestaat = async (url) => (await alsSeed('GET', url)).status === 200;

test('selectie: de vernietigbare zaken, met waarschuwing voor de zaak zonder archiefnominatie', async () => {
  selectie = await selectieService.startSelectie({});
  const verwacht = ['ZAAK-2018-0042', 'ZAAK-2018-0200', 'ZAAK-2018-0201', ...Object.values(z).map((zaak) => zaak.identificatie).filter((id) => id.startsWith('ZAAK-2018-1'))];

  assert.equal(selectie.status, 'READY', selectie.foutmelding);
  assert.deepEqual(selectie.kandidaten.map(nummer).sort(), verwacht.sort());
  assert.equal(selectie.waarschuwingen.length, 1);
  assert.match(selectie.waarschuwingen[0], /ZAAK-2018-0101: .* archiefnominatie ontbreekt/);

  const voorbeeld = kandidaat(z.voorbeeld);
  assert.equal(voorbeeld.aantalObjecten, 5);
  assert.equal(voorbeeld.aantalBetrokkenen, 2);
  assert.equal(voorbeeld.bewaartermijn.termijnLooptijd, 'P7Y');
  assert.equal(voorbeeld.bewaartermijn.termijnEinddatum, '2025-06-30');
  assert.equal(voorbeeld.bewaartermijn.termijnTriggerStartLooptijd.begripCode, 'afgehandeld');
  assert.match(voorbeeld.informatiecategorie.begripBegrippenlijst.verwijzingNaam, /Selectielijst gemeenten en intergemeentelijke organen 2020/);
  assert.equal(voorbeeld.informatiecategorie.begripBegrippenlijst.verwijzingIdentificatie.identificatieKenmerk, 'GEM-2020');

  const contract = loadContract();
  const pagina = { selectieId: selectie.selectieId, offset: 0, limit: 500, totaal: selectie.kandidaten.length, items: selectie.kandidaten };
  const { toKandidatenPaginaResponse } = await import('../../src/api/response-mappers.js');
  assert.deepEqual(contract.validateResponse({ method: 'GET', pathTemplate: '/selecties/{selectieId}/vernietigingskandidaten', status: 200, body: toKandidatenPaginaResponse(pagina) }), []);
});

test('het account van de stekker mag lezen en verwijderen, maar niets aanmaken', async () => {
  const response = await fetch(`${basis}/zaken/api/v1/zaken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.token()}`, 'Content-Type': 'application/json', 'Accept-Crs': 'EPSG:4326', 'Content-Crs': 'EPSG:4326' },
    body: JSON.stringify({ bronorganisatie: '002220647', verantwoordelijkeOrganisatie: '002220647', zaaktype: seed.typen.zaaktype, startdatum: '2026-01-01' })
  });

  assert.equal(response.status, 403);
});

test('ZAAK-2018-0042: vernietigd in OAB-volgorde, het gedeelde document blijft bij ZAAK-2019-0107', async (t) => {
  const afgerond = await vernietig([z.voorbeeld]);
  const [resultaat] = afgerond.resultaten;

  assert.equal(resultaat.resultaat, 'SUCCESS', resultaat.foutmelding);
  assert.equal(await bestaat(z.voorbeeld.url), false);
  assert.equal(await bestaat(z.voorbeeld.besluiten[0]), false);
  assert.equal(await bestaat(z.voorbeeld.documenten[0]), false);
  assert.equal(await bestaat(z.voorbeeld.documenten[1]), true, 'D2 hoort ook bij de herindicatie');
  assert.equal(await bestaat(z.herindicatie.url), true);
  assert.deepEqual(resultaat.onderdeelUitkomsten.map((item) => item.uitkomst), ['vernietigd', 'ontkoppeld', 'vernietigd', 'vernietigd', 'vernietigd']);

  const xml = vernietigingService.getSpecificatie(afgerond.vernietigingId, resultaat.vernietigingskandidaatId);
  assert.equal(xml.match(/<bevatOnderdeel>/g).length, 5);
  valideerTegenXsd(t, xml);
});

test('hoofdzaak alleen: SKIPPED, de deelzaak blijft; samen: eerst de deelzaak, dan de hoofdzaak', async () => {
  const alleen = await vernietig([z.hoofdzaak]);
  assert.equal(alleen.resultaten[0].foutcode, 'DEELZAKEN_AANWEZIG');
  assert.equal(await bestaat(z.deelzaak.url), true);

  const samen = await vernietig([z.hoofdzaak, z.deelzaak]);
  assert.deepEqual(samen.resultaten.map((resultaat) => resultaat.resultaat), ['SUCCESS', 'SUCCESS'], JSON.stringify(samen.resultaten.map((r) => r.foutmelding)));
  assert.equal(await bestaat(z.hoofdzaak.url), false);
  assert.equal(await bestaat(z.deelzaak.url), false);
});

test('na de selectie gewijzigd: document toegevoegd of archiefactiedatum aangepast = CHANGED, niets verwijderd', async () => {
  const [eerste, tweede] = [z.zaak0001, z.zaak0002];
  const document = (await alsSeed('POST', '/documenten/api/v1/enkelvoudiginformatieobjecten', {
    identificatie: `${eerste.identificatie}-LATER`, bronorganisatie: '002220647', creatiedatum: '2026-10-01', titel: 'Later toegevoegd', auteur: 'Test', taal: 'nld',
    informatieobjecttype: seed.typen.documenttype, indicatieGebruiksrecht: false, inhoud: Buffer.from('x').toString('base64'), bestandsnaam: 'later.txt'
  })).body.url;
  assert.equal((await alsSeed('POST', '/zaken/api/v1/zaakinformatieobjecten', { zaak: eerste.url, informatieobject: document })).status, 201);
  assert.equal((await alsSeed('PATCH', tweede.url, { archiefactiedatum: '2025-12-31' })).status, 200);

  const afgerond = await vernietig([eerste, tweede]);

  assert.deepEqual(afgerond.resultaten.map((resultaat) => resultaat.foutcode), ['ONDERDELEN_GEWIJZIGD', 'ARCHIEFACTIEDATUM_GEWIJZIGD']);
  assert.equal(await bestaat(eerste.url), true);
  assert.equal(await bestaat(tweede.url), true);
  assert.equal(await bestaat(document), true);
});

test('de overige zaken via de HTTP-API in twee batches: alle antwoorden volgen de Stekker API', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const server = createHttpServer({ selectieService, vernietigingService, logRequests: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const api = `http://127.0.0.1:${server.address().port}/v2`;
  const contract = loadContract();
  const fouten = [];
  const verzoek = async (method, pathTemplate, pad, body) => {
    const response = await fetch(`${api}${pad}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await response.json();
    fouten.push(...contract.validateResponse({ method, pathTemplate, status: response.status, body: json }).map((fout) => `${method} ${pathTemplate}: ${fout}`));
    return json;
  };
  const rest = Object.entries(z).filter(([naam]) => naam.startsWith('zaak') && !['zaak0001', 'zaak0002'].includes(naam)).map(([, zaak]) => object(kandidaat(zaak)));
  const vernietiging = await verzoek('POST', '/vernietigingen', '/vernietigingen', { selectieId: selectie.selectieId, cockpitTaakId: 'taak-http', besluitReferentie: 'besluit-http' });
  const pad = `/vernietigingen/${vernietiging.vernietigingId}`;
  const helft = Math.ceil(rest.length / 2);
  await verzoek('POST', '/vernietigingen/{vernietigingId}/batches', `${pad}/batches`, { batchNummer: 1, vernietigingskandidaten: rest.slice(0, helft) });
  await verzoek('POST', '/vernietigingen/{vernietigingId}/batches', `${pad}/batches`, { batchNummer: 2, vernietigingskandidaten: rest.slice(helft) });
  await verzoek('POST', '/vernietigingen/{vernietigingId}/vrijgeven', `${pad}/vrijgeven`, { aantalBatches: 2, aantalKandidaten: rest.length });
  const afgerond = await verzoek('GET', '/vernietigingen/{vernietigingId}', pad);
  const batches = await verzoek('GET', '/vernietigingen/{vernietigingId}/batches', `${pad}/batches`);

  assert.deepEqual(fouten, []);
  assert.equal(afgerond.status, 'COMPLETED', JSON.stringify(batches.flatMap((batch) => batch.resultaten).filter((r) => r.resultaat !== 'SUCCESS')));
  assert.equal(afgerond.succesvolVernietigd, rest.length);
});

test('een tweede vernietiging van een al vernietigde zaak geeft NOT_FOUND', async () => {
  const afgerond = await vernietig([z.voorbeeld]);

  assert.equal(afgerond.resultaten[0].resultaat, 'NOT_FOUND');
});
