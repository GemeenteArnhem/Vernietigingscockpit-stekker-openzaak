import assert from 'node:assert/strict';
import test from 'node:test';
import { toKandidatenPaginaResponse } from '../src/api/response-mappers.js';
import { SelectieService } from '../src/application/selectie-service.js';
import { OpenZaakBron } from '../src/infrastructure/openzaak/openzaak-bron.js';
import { ZgwClient } from '../src/infrastructure/openzaak/zgw-client.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { loadContract } from './contract/openapi-contract.js';
import { CLIENT_ID, NepOpenZaak, SECRET } from './helpers/nep-openzaak.js';

const PEILDATUM = '2026-09-25';

// Het voorbeeld uit de analyse plus randgevallen:
// - ZAAK-2018-0042: drie documenten, besluit B1 met besluitbrief; D2 hoort ook bij ZAAK-2019-0107;
// - ZAAK-2019-0107: archiefactiedatum in de toekomst (niet vernietigbaar);
// - blijvend te bewaren, zonder nominatie, overgedragen, niet afgehandeld, zonder selectielijstklasse;
// - hoofdzaak met deelzaak, en een besluitbrief die ook direct aan de zaak hangt.
async function voorbeeld(t, { paginaGrootte = 100 } = {}) {
  const openZaak = await new NepOpenZaak({ paginaGrootte }).start();
  t.after(() => openZaak.stop());
  const zaken = {};

  zaken.voorbeeld = openZaak.voegZaakToe({
    identificatie: 'ZAAK-2018-0042',
    omschrijving: 'Aanvraag traplift',
    documenten: ['Aanvraagformulier', 'Medisch advies', 'Offerte'],
    besluiten: [{ documenten: ['Besluitbrief'] }],
    rollen: 2
  });
  zaken.herindicatie = openZaak.voegZaakToe({ identificatie: 'ZAAK-2019-0107', archiefactiedatum: '2030-07-01', documenten: 0 });
  openZaak.koppelDocument(zaken.herindicatie.zaak, zaken.voorbeeld.documenten[1]);

  zaken.bewaren = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0100', archiefnominatie: 'blijvend_bewaren', documenten: 1 });
  zaken.zonderNominatie = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0101', archiefnominatie: null, documenten: 1 });
  zaken.overgedragen = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0102', archiefstatus: 'overgedragen', documenten: 1 });
  zaken.lopend = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0103', einddatum: null, documenten: 1 });
  zaken.opPeildatum = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0104', archiefactiedatum: PEILDATUM, documenten: 0 });
  zaken.dagNaPeildatum = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0105', archiefactiedatum: '2026-09-26', documenten: 0 });

  const zonderKlasse = openZaak.maakZaaktype({ identificatie: 'ZONDER-SELECTIELIJST' });
  openZaak.tabellen.resultaattypen.get(zonderKlasse.resultaattype).selectielijstklasse = null;
  zaken.zonderKlasse = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0106', zaaktype: zonderKlasse, documenten: 0 });
  openZaak.wijzigZaak(zaken.zonderKlasse.zaak, { selectielijstklasse: null });

  zaken.hoofdzaak = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0200', documenten: 1 });
  zaken.deelzaak = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0201', documenten: 0 });
  openZaak.wijzigZaak(zaken.hoofdzaak.zaak, { deelzaken: [zaken.deelzaak.zaak], relevanteAndereZaken: [{ url: zaken.herindicatie.zaak, aardRelatie: 'vervolg' }] });
  openZaak.wijzigZaak(zaken.deelzaak.zaak, { hoofdzaak: zaken.hoofdzaak.zaak });

  zaken.dubbel = openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0300', documenten: 1, besluiten: [{ documenten: ['Besluitbrief'] }] });
  openZaak.koppelDocument(zaken.dubbel.zaak, zaken.dubbel.besluiten[0].documenten[0]);

  const client = new ZgwClient({ diensten: openZaak.diensten, clientId: CLIENT_ID, secret: SECRET, wachttijdMs: 0 });
  const maakBron = (opties = {}) => new OpenZaakBron({ client, parallel: 4, ...opties });
  return { openZaak, zaken, maakBron };
}

const nummers = (kandidaten) => kandidaten.map((kandidaat) => kandidaat.identificatie[1].identificatieKenmerk).sort();

test('selecteert de vernietigbare zaken en meldt zaken zonder archiefnominatie', async (t) => {
  const { maakBron } = await voorbeeld(t);
  const { kandidaten, waarschuwingen, bronRecords } = await maakBron().selecteer({ peildatum: PEILDATUM });

  assert.deepEqual(nummers(kandidaten), ['ZAAK-2018-0042', 'ZAAK-2018-0104', 'ZAAK-2018-0200', 'ZAAK-2018-0201', 'ZAAK-2018-0300']);
  assert.equal(bronRecords, 9, 'afgehandeld en archiefactiedatum op of vóór de peildatum');
  assert.equal(waarschuwingen.length, 2);
  assert.match(waarschuwingen.find((tekst) => tekst.includes('0101')), /archiefnominatie ontbreekt; niet geselecteerd/);
  assert.match(waarschuwingen.find((tekst) => tekst.includes('0106')), /geen selectielijstklasse/);
});

test('met leverNietV komt ook de blijvend te bewaren zaak mee, als waardering B', async (t) => {
  const { maakBron } = await voorbeeld(t);
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM, leverNietV: true });
  const bewaren = kandidaten.find((kandidaat) => kandidaat.identificatie[1].identificatieKenmerk === 'ZAAK-2018-0100');

  assert.equal(kandidaten.length, 6);
  assert.equal(bewaren.waardering.begripCode, 'B');
  assert.equal(bewaren.waardering.begripLabel, 'Blijvend te bewaren');
});

test('het voorbeeld ZAAK-2018-0042 wordt een MDTO-dossier met vijf onderdelen', async (t) => {
  const { maakBron, zaken } = await voorbeeld(t);
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM });
  const kandidaat = kandidaten.find((item) => item.bronId === zaken.voorbeeld.zaak);

  assert.match(kandidaat.vernietigingskandidaatId, /^vk-[0-9a-f-]{36}$/);
  assert.deepEqual(kandidaat.identificatie, [
    { identificatieKenmerk: zaken.voorbeeld.zaak, identificatieBron: 'Open Zaak Zaken API (zaak-URL)' },
    { identificatieKenmerk: 'ZAAK-2018-0042', identificatieBron: 'Zaaknummering gemeente Voorbeeld' }
  ]);
  assert.equal(kandidaat.naam, 'Aanvraag traplift');
  assert.equal(kandidaat.aggregatieniveau.begripLabel, 'Dossier');
  assert.deepEqual(kandidaat.classificatie[0].begripLabel, 'Aanvraag Wmo-voorziening');
  assert.equal(kandidaat.classificatie[0].begripCode, 'WMO-AANVRAAG');
  assert.deepEqual(kandidaat.dekkingInTijd[0], {
    dekkingInTijdType: { begripLabel: 'Looptijd', begripCode: 'looptijd', begripBegrippenlijst: { verwijzingNaam: 'Cockpit-dekkingInTijdtypen' } },
    dekkingInTijdBegindatum: '2018-01-15',
    dekkingInTijdEinddatum: '2018-06-30'
  });
  assert.equal(kandidaat.waardering.begripCode, 'V');
  assert.deepEqual(kandidaat.bewaartermijn, {
    termijnTriggerStartLooptijd: { begripLabel: 'Afgehandeld', begripCode: 'afgehandeld', begripBegrippenlijst: { verwijzingNaam: 'Cockpit-termijntriggers' } },
    termijnStartdatumLooptijd: '2018-07-01',
    termijnLooptijd: 'P7Y',
    termijnEinddatum: '2025-07-01'
  });
  assert.equal(kandidaat.informatiecategorie.begripLabel, 'Toegekend');
  assert.equal(kandidaat.informatiecategorie.begripCode, '7.1.2');
  assert.equal(kandidaat.informatiecategorie.begripBegrippenlijst.verwijzingNaam, 'Selectielijst gemeenten en intergemeentelijke organen 2020');
  // Selectielijstcode uit Cockpit-selectielijsten op basis van het jaar van het procestype (ADR-0008).
  assert.deepEqual(kandidaat.informatiecategorie.begripBegrippenlijst.verwijzingIdentificatie, {
    identificatieKenmerk: 'GEM-2020',
    identificatieBron: 'Cockpit-selectielijsten'
  });
  assert.equal(kandidaat.activiteit.verwijzingNaam, 'Verstrekken van een voorziening');
  assert.equal(kandidaat.aantalBetrokkenen, 2);

  // Onderdelen: drie zaakdocumenten, het besluit en de besluitbrief (B-OZ4).
  assert.equal(kandidaat.aantalObjecten, 5);
  assert.deepEqual(kandidaat.momentopname.onderdelen.map(({ soort, kenmerk }) => [soort, kenmerk]), [
    ['document', 'ZAAK-2018-0042-D1'],
    ['document', 'ZAAK-2018-0042-D2'],
    ['document', 'ZAAK-2018-0042-D3'],
    ['besluit', 'ZAAK-2018-0042-B1'],
    ['document', 'ZAAK-2018-0042-B1-D1']
  ]);
  assert.deepEqual(kandidaat.onderdelen[1], {
    verwijzingNaam: 'Medisch advies',
    verwijzingIdentificatie: { identificatieKenmerk: 'ZAAK-2018-0042-D2', identificatieBron: 'Documentnummering gemeente Voorbeeld' }
  });
  assert.equal(kandidaat.onderdelen[3].verwijzingIdentificatie.identificatieBron, 'Besluitnummering gemeente Voorbeeld');
  assert.equal(kandidaat.momentopname.archiefactiedatum, '2025-07-01');
});

test('een procestype zonder jaar geeft geen selectielijstcode: waarschuwing en niet geselecteerd', async (t) => {
  const { openZaak, maakBron } = await voorbeeld(t);
  const zonderJaar = openZaak.maakZaaktype({ identificatie: 'ZONDER-JAAR' });
  openZaak.tabellen.procestypen.get(zonderJaar.procestype).jaar = null;
  openZaak.voegZaakToe({ identificatie: 'ZAAK-2018-0400', zaaktype: zonderJaar, documenten: 0 });

  const { kandidaten, waarschuwingen } = await maakBron().selecteer({ peildatum: PEILDATUM });

  assert.ok(!nummers(kandidaten).includes('ZAAK-2018-0400'));
  assert.match(waarschuwingen.find((tekst) => tekst.includes('0400')), /geen selectielijstjaar.*niet geselecteerd/);
});

test('een document dat via zaak én besluit aan de zaak hangt telt één keer', async (t) => {
  const { maakBron, zaken } = await voorbeeld(t);
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM });
  const kandidaat = kandidaten.find((item) => item.bronId === zaken.dubbel.zaak);

  assert.equal(kandidaat.aantalObjecten, 3);
  assert.deepEqual(kandidaat.momentopname.onderdelen.map((onderdeel) => onderdeel.kenmerk), [
    'ZAAK-2018-0300-D1',
    'ZAAK-2018-0300-B1-D1',
    'ZAAK-2018-0300-B1'
  ]);
});

test('hoofdzaak en deelzaak zijn elk een kandidaat met de relatie als gerelateerd informatieobject', async (t) => {
  const { maakBron, zaken } = await voorbeeld(t);
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM });
  const hoofdzaak = kandidaten.find((item) => item.bronId === zaken.hoofdzaak.zaak);
  const deelzaak = kandidaten.find((item) => item.bronId === zaken.deelzaak.zaak);
  const namen = (kandidaat) => kandidaat.gerelateerdInformatieobject.map((item) => item.gerelateerdInformatieobjectVerwijzing.verwijzingNaam);

  assert.deepEqual(namen(hoofdzaak), ['Deelzaak ZAAK-2018-0201', 'Gerelateerde zaak (vervolg) ZAAK-2019-0107']);
  assert.deepEqual(namen(deelzaak), ['Hoofdzaak ZAAK-2018-0200']);
  assert.equal(deelzaak.gerelateerdInformatieobject[0].gerelateerdInformatieobjectVerwijzing.verwijzingIdentificatie.identificatieKenmerk, zaken.hoofdzaak.zaak);
  assert.equal(deelzaak.gerelateerdInformatieobject[0].gerelateerdInformatieobjectTypeRelatie.begripLabel, 'Refereert aan');
});

test('een filter op zaaktype beperkt de selectie', async (t) => {
  const { maakBron } = await voorbeeld(t);
  const { kandidaten, waarschuwingen } = await maakBron({ zaaktypen: ['ANDER-ZAAKTYPE'] }).selecteer({ peildatum: PEILDATUM });

  assert.equal(kandidaten.length, 0);
  assert.equal(waarschuwingen.length, 0);
});

test('volgt de paginering van de Zaken API en haalt de selectielijst één keer op', async (t) => {
  const { maakBron, openZaak } = await voorbeeld(t, { paginaGrootte: 2 });
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM });

  assert.equal(kandidaten.length, 5);
  assert.equal(openZaak.log.filter((regel) => regel === 'GET /zaken/api/v1/zaken').length, 5);
  assert.equal(openZaak.log.filter((regel) => regel.startsWith('GET /selectielijst/api/v1/resultaten/')).length, 1);
  assert.equal(openZaak.log.filter((regel) => regel.startsWith('GET /selectielijst/api/v1/procestypen/')).length, 1);
});

test('kandidaten voldoen aan het schema van de Stekker API', async (t) => {
  const { maakBron } = await voorbeeld(t);
  const { kandidaten } = await maakBron().selecteer({ peildatum: PEILDATUM, leverNietV: true });
  const contract = loadContract();
  const fouten = contract.validateResponse({
    method: 'GET',
    pathTemplate: '/selecties/{selectieId}/vernietigingskandidaten',
    status: 200,
    body: toKandidatenPaginaResponse({ selectieId: 'sel-x', offset: 0, limit: 100, totaal: kandidaten.length, items: kandidaten })
  });

  assert.deepEqual(fouten, []);
});

test('een storing in Open Zaak tijdens de selectie geeft een selectie met status FAILED', async (t) => {
  const { maakBron, openZaak } = await voorbeeld(t);
  openZaak.storing({ methode: 'GET', pad: /\/zaakinformatieobjecten$/, status: 500, keer: 1 });
  const service = new SelectieService({ bron: maakBron(), selectieRepository: new InMemorySelectieRepository(), processingDelayMs: 0 });
  const selectie = await service.startSelectie({ peildatum: PEILDATUM });

  assert.equal(selectie.status, 'FAILED');
  assert.match(selectie.foutmelding, /GET .*zaakinformatieobjecten: HTTP 500/);
});

test('een onbereikbare Selectielijst API laat de selectie mislukken en wordt bij een nieuwe selectie opnieuw geprobeerd', async (t) => {
  const { maakBron, openZaak } = await voorbeeld(t);
  const bron = maakBron();
  openZaak.storing({ methode: 'GET', pad: /^\/selectielijst\/api\/v1\/resultaten\//, status: 500, keer: 1 });

  await assert.rejects(bron.selecteer({ peildatum: PEILDATUM }), /HTTP 500/);
  assert.equal((await bron.selecteer({ peildatum: PEILDATUM })).kandidaten.length, 5);
});
