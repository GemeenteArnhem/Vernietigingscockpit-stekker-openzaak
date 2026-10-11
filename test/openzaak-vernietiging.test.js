import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/api/http-server.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { OpenZaakBron } from '../src/infrastructure/openzaak/openzaak-bron.js';
import { ZgwClient } from '../src/infrastructure/openzaak/zgw-client.js';
import { InMemoryJournaalRepository } from '../src/infrastructure/repositories/in-memory-journaal-repository.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';
import { loadContract } from './contract/openapi-contract.js';
import { CLIENT_ID, NepOpenZaak, SECRET } from './helpers/nep-openzaak.js';
import { valideerTegenXsd } from './helpers/xsd.js';

const VANDAAG = new Date('2026-10-10T09:00:00.000Z');

// Het voorbeeld uit de analyse: ZAAK-2018-0042 met D1–D3, besluit B1 met besluitbrief; D2 hoort
// ook bij ZAAK-2019-0107. Plus een paar losse zaken om fout- en wijzigpaden op te testen.
async function maakContext(t, { maxPogingen = 3 } = {}) {
  const openZaak = await new NepOpenZaak().start();
  t.after(() => openZaak.stop());
  const voorbeeld = openZaak.voegZaakToe({
    identificatie: 'ZAAK-2018-0042',
    omschrijving: 'Aanvraag traplift',
    documenten: ['Aanvraagformulier', 'Medisch advies', 'Offerte'],
    besluiten: [{ documenten: ['Besluitbrief'] }]
  });
  const herindicatie = openZaak.voegZaakToe({ identificatie: 'ZAAK-2019-0107', archiefactiedatum: '2030-07-01', documenten: 0 });
  openZaak.koppelDocument(herindicatie.zaak, voorbeeld.documenten[1]);
  const overig = ['0001', '0002', '0003', '0004', '0005'].map((nummer) => openZaak.voegZaakToe({ identificatie: `ZAAK-2018-${nummer}`, documenten: 1 }));

  let tik = 0;
  const klok = () => new Date(VANDAAG.getTime() + tik++);
  const client = new ZgwClient({ diensten: openZaak.diensten, clientId: CLIENT_ID, secret: SECRET, wachttijdMs: 0, maxPogingen: 1 });
  const bron = new OpenZaakBron({ client, parallel: 4, klok });
  const vernietigingRepository = new InMemoryVernietigingRepository();
  const selectieService = new SelectieService({ bron, selectieRepository: new InMemorySelectieRepository(), clock: klok, processingDelayMs: 0 });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository,
    journaalRepository: new InMemoryJournaalRepository(),
    clock: klok,
    processingDelayMs: 0,
    maxPogingen,
    wachttijdPogingMs: 0
  });
  const selecteer = (peildatum = '2026-09-25') => selectieService.startSelectie({ peildatum });
  const kandidaatVoor = (selectie, zaakUrl) => selectie.kandidaten.find((kandidaat) => kandidaat.bronId === zaakUrl);
  const object = (kandidaat) => ({ vernietigingskandidaatId: kandidaat.vernietigingskandidaatId, identificatie: kandidaat.identificatie });
  const vernietig = async (selectie, kandidaten) => {
    const { vernietigingId } = vernietigingService.startVernietiging({ selectieId: selectie.selectieId, cockpitTaakId: 'taak-oz', besluitReferentie: 'besluit-oz' });
    vernietigingService.voegBatchToe(vernietigingId, { batchNummer: 1, vernietigingskandidaten: kandidaten.map(object) });
    return vernietigingService.vrijgeven(vernietigingId, { aantalBatches: 1, aantalKandidaten: kandidaten.length });
  };

  return { openZaak, voorbeeld, herindicatie, overig, selectieService, vernietigingService, vernietigingRepository, selecteer, kandidaatVoor, object, vernietig };
}

const verwijderingen = (openZaak) => openZaak.log
  .filter((regel) => regel.startsWith('DELETE'))
  .map((regel) => regel.replace(/^DELETE \/(\w+)\/api\/v1\/(\w+)\/.*$/, '$2'));

test('vernietigt ZAAK-2018-0042 in de volgorde van Open Archiefbeheer; het gedeelde document blijft bestaan', async (t) => {
  const { openZaak, voorbeeld, herindicatie, selecteer, kandidaatVoor, vernietig, vernietigingService } = await maakContext(t);
  const selectie = await selecteer();
  const kandidaat = kandidaatVoor(selectie, voorbeeld.zaak);
  const afgerond = await vernietig(selectie, [kandidaat]);
  const [resultaat] = afgerond.resultaten;
  const [d1, d2, d3] = voorbeeld.documenten;
  const besluitbrief = voorbeeld.besluiten[0].documenten[0];

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(resultaat.resultaat, 'SUCCESS');
  assert.equal(resultaat.event.eventTijd.slice(0, 10), '2026-10-10');

  // Volgorde: besluitinformatieobject, besluit, zaakinformatieobjecten, documenten, zaak.
  assert.deepEqual(verwijderingen(openZaak), [
    'besluitinformatieobjecten',
    'besluiten',
    'zaakinformatieobjecten', 'zaakinformatieobjecten', 'zaakinformatieobjecten',
    'enkelvoudiginformatieobjecten', 'enkelvoudiginformatieobjecten', 'enkelvoudiginformatieobjecten', 'enkelvoudiginformatieobjecten',
    'zaken'
  ]);

  assert.equal(openZaak.bestaat(voorbeeld.zaak), false);
  assert.equal(openZaak.bestaat(voorbeeld.besluiten[0].besluit), false);
  assert.equal([d1, d3, besluitbrief].some((url) => openZaak.bestaat(url)), false);
  assert.equal(openZaak.bestaat(d2), true, 'D2 hoort ook bij ZAAK-2019-0107');
  assert.equal(openZaak.bestaat(herindicatie.zaak), true);

  assert.deepEqual(resultaat.onderdeelUitkomsten, [
    { identificatieKenmerk: 'ZAAK-2018-0042-D1', uitkomst: 'vernietigd' },
    { identificatieKenmerk: 'ZAAK-2018-0042-D2', uitkomst: 'ontkoppeld' },
    { identificatieKenmerk: 'ZAAK-2018-0042-D3', uitkomst: 'vernietigd' },
    { identificatieKenmerk: 'ZAAK-2018-0042-B1', uitkomst: 'vernietigd' },
    { identificatieKenmerk: 'ZAAK-2018-0042-B1-D1', uitkomst: 'vernietigd' }
  ]);

  const xml = vernietigingService.getSpecificatie(afgerond.vernietigingId, kandidaat.vernietigingskandidaatId);
  assert.equal(xml.match(/<bevatOnderdeel>/g).length, 5);
  assert.match(xml, /Ontkoppeld en niet vernietigd, blijft bestaan bij een ander object: ZAAK-2018-0042-D2\./);
  valideerTegenXsd(t, xml);
});

test('een document dat na de selectie is toegevoegd: CHANGED, er wordt niets verwijderd', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const selectie = await selecteer();
  const nieuw = openZaak.maakDocument({ identificatie: 'LATER-1', titel: 'Later toegevoegd' });
  openZaak.koppelDocument(overig[0].zaak, nieuw);

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, overig[0].zaak)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'CHANGED');
  assert.equal(afgerond.resultaten[0].foutcode, 'ONDERDELEN_GEWIJZIGD');
  assert.match(afgerond.resultaten[0].foutmelding, /1 bijgekomen, 0 verdwenen/);
  assert.deepEqual(verwijderingen(openZaak), []);
});

test('gewijzigde archiefgegevens geven CHANGED; een andere omschrijving niet', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const selectie = await selecteer();
  openZaak.wijzigZaak(overig[0].zaak, { archiefactiedatum: '2025-08-01' });
  openZaak.wijzigZaak(overig[1].zaak, { archiefnominatie: 'blijvend_bewaren' });
  openZaak.wijzigZaak(overig[2].zaak, { archiefstatus: 'overgedragen' });
  openZaak.wijzigZaak(overig[3].zaak, { omschrijving: 'Nieuwe omschrijving' });

  const afgerond = await vernietig(selectie, overig.slice(0, 4).map((zaak) => kandidaatVoor(selectie, zaak.zaak)));

  assert.deepEqual(afgerond.resultaten.map((resultaat) => [resultaat.resultaat, resultaat.foutcode ?? '']), [
    ['CHANGED', 'ARCHIEFACTIEDATUM_GEWIJZIGD'],
    ['CHANGED', 'ARCHIEFNOMINATIE_GEWIJZIGD'],
    ['CHANGED', 'OVERGEDRAGEN'],
    ['SUCCESS', '']
  ]);
  assert.equal(openZaak.bestaat(overig[0].zaak), true);
  assert.equal(openZaak.bestaat(overig[3].zaak), false);
});

test('een zaak die al weg is geeft NOT_FOUND', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const selectie = await selecteer();
  openZaak.tabellen.zaken.delete(overig[0].zaak);

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, overig[0].zaak)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'NOT_FOUND');
  assert.deepEqual(verwijderingen(openZaak), []);
});

test('een zaak waarvan de archiefactiedatum na vandaag ligt wordt overgeslagen (SKIPPED)', async (t) => {
  const { openZaak, herindicatie, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  // De Cockpit kiest een peildatum in de toekomst; de stekker vernietigt toch niet te vroeg.
  const selectie = await selecteer('2030-12-31');
  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, herindicatie.zaak)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'SKIPPED');
  assert.equal(afgerond.resultaten[0].foutcode, 'NOG_NIET_VERNIETIGBAAR');
  assert.equal(openZaak.bestaat(herindicatie.zaak), true);
});

test('een tijdelijke storing bij het verwijderen van de zaak: nieuwe poging, dan SUCCESS', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const selectie = await selecteer();
  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 503, keer: 1 });

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, overig[0].zaak)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'SUCCESS');
  assert.equal(verwijderingen(openZaak).filter((soort) => soort === 'zaken').length, 2);
  assert.equal(verwijderingen(openZaak).filter((soort) => soort === 'enkelvoudiginformatieobjecten').length, 1, 'afgeronde stappen niet opnieuw');
});

test('verloren antwoord: de zaak is al verwijderd, de nieuwe poging krijgt 404 en meldt SUCCESS', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const selectie = await selecteer();
  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 504, naUitvoeren: true });

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, overig[0].zaak)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'SUCCESS');
  assert.equal(openZaak.bestaat(overig[0].zaak), false);
});

test('blijft het verwijderen van de zaak mislukken: FAILED DEELS_VERNIETIGD, documenten al weg (B-OZ3)', async (t) => {
  const { openZaak, voorbeeld, selecteer, kandidaatVoor, vernietig } = await maakContext(t, { maxPogingen: 3 });
  const selectie = await selecteer();
  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 503, keer: 3 });

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, voorbeeld.zaak)]);
  const [resultaat] = afgerond.resultaten;

  assert.equal(resultaat.resultaat, 'FAILED');
  assert.equal(resultaat.foutcode, 'DEELS_VERNIETIGD');
  assert.match(resultaat.foutmelding, /na 3 poging\(en\); het object bestaat nog\. Al vernietigd of ontkoppeld: 5 van 5 onderdelen\./);
  assert.match(resultaat.foutmelding, /HTTP 503/);
  assert.equal(openZaak.bestaat(voorbeeld.zaak), true);
  assert.equal(openZaak.bestaat(voorbeeld.documenten[0]), false);
});

test('mislukt de eerste verwijdering, dan VERNIETIGING_MISLUKT: er is niets veranderd', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t, { maxPogingen: 2 });
  const selectie = await selecteer();
  openZaak.storing({ methode: 'DELETE', status: 500, keer: 2 });

  const afgerond = await vernietig(selectie, [kandidaatVoor(selectie, overig[0].zaak)]);

  assert.equal(afgerond.resultaten[0].foutcode, 'VERNIETIGING_MISLUKT');
  assert.equal(openZaak.bestaat(overig[0].zaak), true);
  assert.equal(openZaak.bestaat(overig[0].documenten[0]), true);
});

test('hervatting na gedeeltelijke vernietiging maakt het af, zonder de controle opnieuw te doen', async (t) => {
  const { openZaak, voorbeeld, selecteer, kandidaatVoor, object, vernietigingService, vernietigingRepository } = await maakContext(t, { maxPogingen: 1 });
  const selectie = await selecteer();
  const kandidaat = kandidaatVoor(selectie, voorbeeld.zaak);
  const { vernietigingId } = vernietigingService.startVernietiging({ selectieId: selectie.selectieId, cockpitTaakId: 'taak-h', besluitReferentie: 'besluit-h' });
  vernietigingService.voegBatchToe(vernietigingId, { batchNummer: 1, vernietigingskandidaten: [object(kandidaat)] });
  vernietigingRepository.save({ ...vernietigingRepository.findById(vernietigingId), status: 'RUNNING', totaalBatches: 1 });

  // Eerste keer: alles weg behalve de zaak, en de resultaten worden niet bewaard (zoals bij een crash).
  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 503, keer: 1 });
  const eerste = await vernietigingService.verwerkKandidaat({
    vernietiging: vernietigingRepository.findById(vernietigingId),
    batchNummer: 1,
    object: { ...object(kandidaat), bronId: kandidaat.bronId },
    kandidaat
  });
  assert.equal(eerste.foutcode, 'DEELS_VERNIETIGD');
  // De controle haalt elk document op; het vangnet vóór het verwijderen van de zaak niet.
  const documentGets = () => openZaak.log.filter((regel) => regel.startsWith('GET /documenten/')).length;
  const gets = documentGets();

  const afgerond = await vernietigingService.verwerkVernietiging(vernietigingId);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(documentGets(), gets, 'geen nieuwe controle');
  assert.equal(openZaak.bestaat(voorbeeld.zaak), false);
  assert.equal(afgerond.resultaten[0].onderdeelUitkomsten.find((item) => item.identificatieKenmerk === 'ZAAK-2018-0042-D2').uitkomst, 'ontkoppeld');
});

test('hangt er na een gedeeltelijke vernietiging iets nieuws aan de zaak, dan wordt de zaak niet verwijderd', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, object, vernietigingService, vernietigingRepository } = await maakContext(t, { maxPogingen: 1 });
  const selectie = await selecteer();
  const kandidaat = kandidaatVoor(selectie, overig[0].zaak);
  const { vernietigingId } = vernietigingService.startVernietiging({ selectieId: selectie.selectieId, cockpitTaakId: 'taak-n', besluitReferentie: 'besluit-n' });
  vernietigingService.voegBatchToe(vernietigingId, { batchNummer: 1, vernietigingskandidaten: [object(kandidaat)] });
  vernietigingRepository.save({ ...vernietigingRepository.findById(vernietigingId), status: 'RUNNING', totaalBatches: 1 });
  const verwerk = () => vernietigingService.verwerkKandidaat({
    vernietiging: vernietigingRepository.findById(vernietigingId),
    batchNummer: 1,
    object: { ...object(kandidaat), bronId: kandidaat.bronId },
    kandidaat
  });

  openZaak.storing({ methode: 'DELETE', pad: /\/zaken\/api\/v1\/zaken\//, status: 503, keer: 1 });
  assert.equal((await verwerk()).foutcode, 'DEELS_VERNIETIGD');

  openZaak.koppelDocument(overig[0].zaak, openZaak.maakDocument({ identificatie: 'LATER-2', titel: 'Tussendoor toegevoegd' }));
  const tweede = await verwerk();

  assert.equal(tweede.foutcode, 'DEELS_VERNIETIGD');
  assert.match(tweede.foutmelding, /1 nieuwe onderdelen .* de zaak is niet verwijderd/);
  assert.equal(openZaak.bestaat(overig[0].zaak), true);
});

test('een hoofdzaak met deelzaak: alleen de hoofdzaak = SKIPPED; samen in een batch = eerst de deelzaak', async (t) => {
  const { openZaak, overig, selecteer, kandidaatVoor, vernietig } = await maakContext(t);
  const [hoofdzaak, deelzaak] = overig;
  openZaak.wijzigZaak(hoofdzaak.zaak, { deelzaken: [deelzaak.zaak] });
  openZaak.wijzigZaak(deelzaak.zaak, { hoofdzaak: hoofdzaak.zaak });
  const selectie = await selecteer();

  const alleen = await vernietig(selectie, [kandidaatVoor(selectie, hoofdzaak.zaak)]);
  assert.equal(alleen.resultaten[0].resultaat, 'SKIPPED');
  assert.equal(alleen.resultaten[0].foutcode, 'DEELZAKEN_AANWEZIG');
  assert.equal(openZaak.bestaat(deelzaak.zaak), true, 'de deelzaak is niet stil meeverwijderd');
  assert.deepEqual(verwijderingen(openZaak), []);

  // Hoofdzaak eerst aangeboden; de stekker doet de deelzaak eerst. Resultaten in batchvolgorde.
  const samen = await vernietig(selectie, [kandidaatVoor(selectie, hoofdzaak.zaak), kandidaatVoor(selectie, deelzaak.zaak)]);
  assert.deepEqual(samen.resultaten.map((resultaat) => [resultaat.vernietigingskandidaatId, resultaat.resultaat]), [
    [kandidaatVoor(selectie, hoofdzaak.zaak).vernietigingskandidaatId, 'SUCCESS'],
    [kandidaatVoor(selectie, deelzaak.zaak).vernietigingskandidaatId, 'SUCCESS']
  ]);
  assert.equal(openZaak.bestaat(hoofdzaak.zaak), false);
  assert.equal(openZaak.bestaat(deelzaak.zaak), false);
});

test('volledige ronde via de HTTP-API: alle antwoorden volgen de Stekker API', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { voorbeeld, selectieService, vernietigingService } = await maakContext(t);
  const server = createHttpServer({ selectieService, vernietigingService, logRequests: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const basis = `http://127.0.0.1:${server.address().port}/v2`;
  const contract = loadContract();
  const fouten = [];
  const verzoek = async (method, pathTemplate, pad, body) => {
    const response = await fetch(`${basis}${pad}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const tekst = await response.text();
    const json = response.headers.get('content-type')?.includes('json') ? JSON.parse(tekst) : tekst;
    fouten.push(...contract.validateResponse({ method, pathTemplate, status: response.status, body: json }).map((fout) => `${method} ${pathTemplate}: ${fout}`));
    return { status: response.status, body: json };
  };

  const selectie = await verzoek('POST', '/selecties', '/selecties', { peildatum: '2026-09-25' });
  const pagina = await verzoek('GET', '/selecties/{selectieId}/vernietigingskandidaten', `/selecties/${selectie.body.selectieId}/vernietigingskandidaten`);
  const kandidaten = pagina.body.items.map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));
  const vernietiging = await verzoek('POST', '/vernietigingen', '/vernietigingen', { selectieId: selectie.body.selectieId, cockpitTaakId: 'taak-http', besluitReferentie: 'besluit-http' });
  const pad = `/vernietigingen/${vernietiging.body.vernietigingId}`;
  await verzoek('POST', '/vernietigingen/{vernietigingId}/batches', `${pad}/batches`, { batchNummer: 1, vernietigingskandidaten: kandidaten });
  await verzoek('POST', '/vernietigingen/{vernietigingId}/vrijgeven', `${pad}/vrijgeven`, { aantalBatches: 1, aantalKandidaten: kandidaten.length });
  const afgerond = await verzoek('GET', '/vernietigingen/{vernietigingId}', pad);
  const batch = await verzoek('GET', '/vernietigingen/{vernietigingId}/batches/{batchNummer}', `${pad}/batches/1`);
  const voorbeeldId = pagina.body.items.find((item) => item.identificatie[0].identificatieKenmerk === voorbeeld.zaak).vernietigingskandidaatId;
  const specificatie = await fetch(`${basis}${pad}/specificaties/${voorbeeldId}`);

  assert.deepEqual(fouten, []);
  assert.equal(pagina.body.totaal, 6);
  assert.equal(afgerond.body.status, 'COMPLETED');
  assert.equal(afgerond.body.succesvolVernietigd, 6);
  assert.equal(afgerond.body.vernietigingsmethode.begripLabel, 'Verwijderd via bronfunctie');
  assert.equal(batch.body.resultaten.every((resultaat) => resultaat.onderdeelUitkomsten === undefined), true, 'interne velden lekken niet');
  assert.equal(specificatie.status, 200);
  valideerTegenXsd(t, await specificatie.text());
});
