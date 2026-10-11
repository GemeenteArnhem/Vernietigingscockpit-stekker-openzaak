#!/usr/bin/env node
// Vult een (test)Open Zaak via de gewone API's met een catalogus, zaaktype en voorbeeldzaken,
// en maakt het account van de stekker aan met alleen de rechten die hij nodig heeft.
//
//   node scripts/seed-openzaak.mjs [--aantal 20] [--uitvoer seed.json]
//
// Omgeving: OPENZAAK_URL (bijv. http://localhost:8490), OPENZAAK_SEED_CLIENT_ID en
// OPENZAAK_SEED_SECRET (account met alle rechten, zie compose.openzaak.yaml) en
// OPENZAAK_CLIENT_ID (account van de stekker; het secret daarvan zet openzaak-init).
//
// Herhaalbaar: catalogus, typen en zaken met hetzelfde nummer worden hergebruikt. Zaken worden
// afgesloten met een eindstatus in het verleden; Open Zaak berekent dan zelf de archiefactiedatum
// (einddatum + archiefactietermijn). Afwijkende archiefgegevens worden daarna gezet.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { maakZgwToken } from '../src/infrastructure/openzaak/zgw-client.js';

const RSIN = '002220647';
const DOMEIN = 'VCKPT';
const SELECTIELIJST = process.env.SELECTIELIJST_URL || 'https://selectielijst.openzaak.nl/api/v1/';
// Open Zaak staat wijzigingen aan een gesloten zaak (ook verwijderen van koppelingen en besluiten)
// alleen toe met zaken.geforceerd-bijwerken.
const SCOPES = {
  zrc: ['zaken.lezen', 'zaken.verwijderen', 'zaken.geforceerd-bijwerken'],
  drc: ['documenten.lezen', 'documenten.verwijderen'],
  brc: ['besluiten.lezen', 'besluiten.verwijderen'],
  ztc: ['catalogi.lezen']
};

const { values: opties } = parseArgs({
  options: {
    aantal: { type: 'string', default: '20' },
    uitvoer: { type: 'string' }
  }
});

const basis = verplicht('OPENZAAK_URL').replace(/\/$/, '');
const seedClientId = process.env.OPENZAAK_SEED_CLIENT_ID || 'vernietigingscockpit-seed';
const seedSecret = verplicht('OPENZAAK_SEED_SECRET');
const stekkerClientId = verplicht('OPENZAAK_CLIENT_ID');

const api = {
  catalogi: `${basis}/catalogi/api/v1/`,
  zaken: `${basis}/zaken/api/v1/`,
  documenten: `${basis}/documenten/api/v1/`,
  besluiten: `${basis}/besluiten/api/v1/`,
  autorisaties: `${basis}/autorisaties/api/v1/`
};

const typen = await zorgVoorTypen();
const zaken = await maakVoorbeeldzaken(typen, Number.parseInt(opties.aantal, 10));
await zorgVoorStekkerAccount(typen);

const overzicht = { openzaak: basis, stekkerClientId, typen, zaken };

if (opties.uitvoer) {
  fs.writeFileSync(opties.uitvoer, `${JSON.stringify(overzicht, null, 2)}\n`);
}

console.log(`Open Zaak gevuld: ${Object.keys(zaken).length} zaken; account ${stekkerClientId} heeft lees- en verwijderrechten.`);

// --- Catalogus en typen ---

async function zorgVoorTypen() {
  const catalogus = (await lijst('catalogi', 'catalogussen', { domein: DOMEIN, rsin: RSIN }))[0]
    ?? await post('catalogi', 'catalogussen', {
      domein: DOMEIN,
      rsin: RSIN,
      naam: 'Vernietigingscockpit testcatalogus',
      contactpersoonBeheerNaam: 'Functioneel beheer'
    });
  const bestaand = (await lijst('catalogi', 'zaaktypen', { catalogus: catalogus.url, identificatie: 'VCKPT-WMO' }))[0];

  if (bestaand) {
    return JSON.parse(bestaand.toelichting);
  }

  const procestype = (await haal(`${SELECTIELIJST}procestypen?jaar=2020`)).find((item) => item.nummer === 7) ?? (await haal(`${SELECTIELIJST}procestypen?jaar=2020`))[0];
  const klassen = await haal(`${SELECTIELIJST}resultaten?procesType=${encodeURIComponent(procestype.url)}`);
  const resultaten = klassen.results ?? klassen;
  const vernietigen = resultaten.find((item) => item.waardering === 'vernietigen' && item.bewaartermijn);
  const omschrijving = (await haal(`${SELECTIELIJST}resultaattypeomschrijvingen`))[0];

  const documenttype = await post('catalogi', 'informatieobjecttypen', {
    catalogus: catalogus.url,
    omschrijving: 'Zaakdocument',
    vertrouwelijkheidaanduiding: 'openbaar',
    informatieobjectcategorie: 'Document',
    beginGeldigheid: '2010-01-01'
  });
  await publiceer(documenttype.url);

  const besluittype = await post('catalogi', 'besluittypen', {
    catalogus: catalogus.url,
    omschrijving: 'Toekenning voorziening',
    publicatieIndicatie: false,
    informatieobjecttypen: [documenttype.url],
    beginGeldigheid: '2010-01-01'
  });
  await publiceer(besluittype.url);

  const zaaktype = await post('catalogi', 'zaaktypen', {
    catalogus: catalogus.url,
    identificatie: 'VCKPT-WMO',
    omschrijving: 'Aanvraag Wmo-voorziening',
    vertrouwelijkheidaanduiding: 'openbaar',
    doel: 'Testgegevens Vernietigingscockpit',
    aanleiding: 'Aanvraag van een inwoner',
    indicatieInternOfExtern: 'extern',
    handelingInitiator: 'Aanvragen',
    onderwerp: 'Wmo-voorziening',
    handelingBehandelaar: 'Behandelen',
    doorlooptijd: 'P8W',
    opschortingEnAanhoudingMogelijk: false,
    verlengingMogelijk: false,
    publicatieIndicatie: false,
    productenOfDiensten: [],
    referentieproces: { naam: 'Verstrekken voorziening' },
    verantwoordelijke: 'Team Wmo',
    besluittypen: [besluittype.url],
    gerelateerdeZaaktypen: [],
    selectielijstProcestype: procestype.url,
    beginGeldigheid: '2010-01-01',
    versiedatum: '2010-01-01'
  });
  // Een zaak van dit type mag deelzaak zijn van een zaak van hetzelfde type.
  await patch(zaaktype.url, { deelzaaktypen: [zaaktype.url] });
  await post('catalogi', 'zaaktype-informatieobjecttypen', { zaaktype: zaaktype.url, informatieobjecttype: documenttype.url, volgnummer: 1, richting: 'inkomend' });
  const resultaattype = await post('catalogi', 'resultaattypen', {
    zaaktype: zaaktype.url,
    omschrijving: 'Toegekend',
    resultaattypeomschrijving: omschrijving.url,
    selectielijstklasse: vernietigen.url,
    archiefnominatie: 'vernietigen',
    archiefactietermijn: 'P7Y',
    brondatumArchiefprocedure: { afleidingswijze: 'afgehandeld', datumkenmerk: '', einddatumBekend: false, objecttype: '', registratie: '', procestermijn: null }
  });
  await post('catalogi', 'statustypen', { zaaktype: zaaktype.url, omschrijving: 'Ontvangen', volgnummer: 1 });
  const eindstatus = await post('catalogi', 'statustypen', { zaaktype: zaaktype.url, omschrijving: 'Afgehandeld', volgnummer: 2 });
  const roltype = await post('catalogi', 'roltypen', { zaaktype: zaaktype.url, omschrijving: 'Aanvrager', omschrijvingGeneriek: 'initiator' });
  // Open Zaak staat één initiator per zaak toe; verdere betrokkenen zijn belanghebbende.
  const roltypeBelanghebbende = await post('catalogi', 'roltypen', { zaaktype: zaaktype.url, omschrijving: 'Belanghebbende', omschrijvingGeneriek: 'belanghebbende' });

  const typen = {
    catalogus: catalogus.url,
    zaaktype: zaaktype.url,
    resultaattype: resultaattype.url,
    eindstatus: eindstatus.url,
    roltype: roltype.url,
    roltypeBelanghebbende: roltypeBelanghebbende.url,
    documenttype: documenttype.url,
    besluittype: besluittype.url,
    selectielijstklasse: vernietigen.url
  };
  // De URL's in de toelichting, zodat een volgende run ze terugvindt.
  await patch(zaaktype.url, { toelichting: JSON.stringify(typen) });
  await publiceer(zaaktype.url);
  return typen;
}

// --- Zaken ---

async function maakVoorbeeldzaken(typen, aantal) {
  const zaken = {};

  // Het voorbeeld uit de analyse: D2 hoort ook bij de herindicatie.
  const herindicatie = await zaak(typen, { identificatie: 'ZAAK-2019-0107', omschrijving: 'Herindicatie traplift', einddatum: '2023-03-31', documenten: [] });
  const voorbeeld = await zaak(typen, {
    identificatie: 'ZAAK-2018-0042',
    omschrijving: 'Aanvraag traplift',
    documenten: ['Aanvraagformulier', 'Medisch advies', 'Offerte'],
    besluiten: [['Besluitbrief']],
    rollen: 2
  });

  if (voorbeeld.nieuw) {
    await post('zaken', 'zaakinformatieobjecten', { zaak: herindicatie.url, informatieobject: voorbeeld.documenten[1] });
  }

  zaken.voorbeeld = voorbeeld;
  zaken.herindicatie = herindicatie;
  zaken.bewaren = await zaak(typen, { identificatie: 'ZAAK-2018-0100', omschrijving: 'Blijvend te bewaren', documenten: ['Rapport'], wijzig: { archiefnominatie: 'blijvend_bewaren' } });
  zaken.zonderNominatie = await zaak(typen, { identificatie: 'ZAAK-2018-0101', omschrijving: 'Zonder archiefnominatie', documenten: [], wijzig: { archiefnominatie: '' } });
  zaken.overgedragen = await zaak(typen, { identificatie: 'ZAAK-2018-0102', omschrijving: 'Overgedragen', documenten: [], wijzig: { archiefstatus: 'overgedragen' } });

  const hoofdzaak = await zaak(typen, { identificatie: 'ZAAK-2018-0200', omschrijving: 'Hoofdzaak', documenten: ['Plan van aanpak'], openLaten: true });
  zaken.deelzaak = await zaak(typen, { identificatie: 'ZAAK-2018-0201', omschrijving: 'Deelzaak', documenten: [], hoofdzaak: hoofdzaak.url });
  zaken.hoofdzaak = { ...hoofdzaak, ...(await sluitAf(typen, hoofdzaak)) };

  for (let nummer = 1; nummer <= aantal; nummer += 1) {
    const volgnummer = String(nummer).padStart(4, '0');
    zaken[`zaak${volgnummer}`] = await zaak(typen, {
      identificatie: `ZAAK-2018-1${volgnummer}`,
      omschrijving: `Aanvraag voorziening ${volgnummer}`,
      documenten: Array.from({ length: nummer % 4 }, (_, index) => `Document ${index + 1}`),
      besluiten: nummer % 5 === 0 ? [['Besluitbrief']] : []
    });
  }

  return Object.fromEntries(Object.entries(zaken).map(([naam, { url, identificatie, documenten, besluiten }]) => [naam, { url, identificatie, documenten, besluiten }]));
}

async function zaak(typen, {
  identificatie,
  omschrijving,
  einddatum = '2018-06-30',
  documenten = [],
  besluiten = [],
  rollen = 1,
  hoofdzaak,
  wijzig,
  openLaten = false
}) {
  const bestaand = (await lijst('zaken', 'zaken', { identificatie, bronorganisatie: RSIN }))[0];

  if (bestaand) {
    const zios = await lijst('zaken', 'zaakinformatieobjecten', { zaak: bestaand.url });
    const bes = await lijst('besluiten', 'besluiten', { zaak: bestaand.url });
    return { url: bestaand.url, identificatie, documenten: zios.map((zio) => zio.informatieobject), besluiten: bes.map((besluit) => besluit.url), einddatum, nieuw: false };
  }

  const nieuw = await post('zaken', 'zaken', {
    identificatie,
    bronorganisatie: RSIN,
    verantwoordelijkeOrganisatie: RSIN,
    omschrijving,
    zaaktype: typen.zaaktype,
    startdatum: '2018-01-15',
    ...(hoofdzaak ? { hoofdzaak } : {})
  });

  for (let index = 0; index < rollen; index += 1) {
    await post('zaken', 'rollen', {
      zaak: nieuw.url,
      betrokkeneType: 'natuurlijk_persoon',
      roltype: index === 0 ? typen.roltype : typen.roltypeBelanghebbende,
      roltoelichting: index === 0 ? 'Aanvrager' : 'Belanghebbende',
      betrokkeneIdentificatie: { voornamen: 'Test', geslachtsnaam: `Persoon ${index + 1}` }
    });
  }

  const documentUrls = [];

  for (const [index, titel] of documenten.entries()) {
    const document = await maakDocument(typen, `${identificatie}-D${index + 1}`, titel);
    await post('zaken', 'zaakinformatieobjecten', { zaak: nieuw.url, informatieobject: document });
    documentUrls.push(document);
  }

  const besluitUrls = [];

  for (const [index, titels] of besluiten.entries()) {
    const besluit = await post('besluiten', 'besluiten', {
      identificatie: `${identificatie}-B${index + 1}`,
      verantwoordelijkeOrganisatie: RSIN,
      besluittype: typen.besluittype,
      zaak: nieuw.url,
      datum: einddatum,
      ingangsdatum: einddatum
    });

    for (const [documentIndex, titel] of titels.entries()) {
      const document = await maakDocument(typen, `${identificatie}-B${index + 1}-D${documentIndex + 1}`, titel);
      await post('besluiten', 'besluitinformatieobjecten', { besluit: besluit.url, informatieobject: document });
    }

    besluitUrls.push(besluit.url);
  }

  const resultaat = { url: nieuw.url, identificatie, documenten: documentUrls, besluiten: besluitUrls, einddatum, nieuw: true };

  if (!openLaten) {
    await sluitAf(typen, resultaat);
  }

  if (wijzig) {
    await patch(nieuw.url, wijzig);
  }

  return resultaat;
}

// Resultaat + eindstatus met een datum in het verleden: Open Zaak zet dan einddatum en berekent
// de archiefactiedatum uit het resultaattype (afgehandeld + P7Y).
async function sluitAf(typen, { url, einddatum }) {
  if ((await verzoek('GET', url)).einddatum) {
    return {};
  }

  if ((await lijst('zaken', 'resultaten', { zaak: url })).length === 0) {
    await post('zaken', 'resultaten', { zaak: url, resultaattype: typen.resultaattype });
  }

  await post('zaken', 'statussen', { zaak: url, statustype: typen.eindstatus, datumStatusGezet: `${einddatum}T12:00:00Z` });
  return {};
}

async function maakDocument(typen, identificatie, titel) {
  return (await post('documenten', 'enkelvoudiginformatieobjecten', {
    identificatie,
    bronorganisatie: RSIN,
    creatiedatum: '2018-02-01',
    titel,
    auteur: 'Vernietigingscockpit seed',
    taal: 'nld',
    informatieobjecttype: typen.documenttype,
    vertrouwelijkheidaanduiding: 'openbaar',
    // Nodig om de zaak te mogen afsluiten.
    indicatieGebruiksrecht: false,
    inhoud: Buffer.from(`Testdocument ${identificatie}`).toString('base64'),
    bestandsnaam: `${identificatie}.txt`,
    formaat: 'text/plain'
  })).url;
}

// --- Account van de stekker ---

async function zorgVoorStekkerAccount(typen) {
  const autorisaties = [
    { component: 'zrc', scopes: SCOPES.zrc, zaaktype: typen.zaaktype, maxVertrouwelijkheidaanduiding: 'zeer_geheim' },
    { component: 'drc', scopes: SCOPES.drc, informatieobjecttype: typen.documenttype, maxVertrouwelijkheidaanduiding: 'zeer_geheim' },
    { component: 'brc', scopes: SCOPES.brc, besluittype: typen.besluittype },
    { component: 'ztc', scopes: SCOPES.ztc }
  ];
  const bestaand = (await lijst('autorisaties', 'applicaties', { clientIds: stekkerClientId }))[0];
  const gegevens = { clientIds: [stekkerClientId], label: 'Vernietigingscockpit stekker', heeftAlleAutorisaties: false, autorisaties };

  if (bestaand) {
    await verzoek('PUT', bestaand.url, gegevens);
  } else {
    await post('autorisaties', 'applicaties', gegevens);
  }
}

// --- HTTP ---

async function lijst(dienst, pad, params) {
  const url = new URL(pad, api[dienst]);
  Object.entries(params).forEach(([sleutel, waarde]) => url.searchParams.set(sleutel, waarde));
  const antwoord = await verzoek('GET', url.toString());
  return Array.isArray(antwoord) ? antwoord : antwoord.results;
}

function post(dienst, pad, body) {
  return verzoek('POST', new URL(pad, api[dienst]).toString(), body);
}

function patch(url, body) {
  return verzoek('PATCH', url, body);
}

function publiceer(url) {
  return verzoek('POST', `${url}/publish`, {});
}

async function verzoek(methode, url, body) {
  const response = await fetch(url, {
    method: methode,
    headers: {
      Authorization: `Bearer ${maakZgwToken({ clientId: seedClientId, secret: seedSecret })}`,
      Accept: 'application/json',
      'Accept-Crs': 'EPSG:4326',
      'Content-Crs': 'EPSG:4326',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const tekst = await response.text();

  if (!response.ok) {
    throw new Error(`${methode} ${url.split('?')[0]}: HTTP ${response.status} ${tekst.slice(0, 800)}`);
  }

  return tekst ? JSON.parse(tekst) : undefined;
}

async function haal(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }

  return response.json();
}

function verplicht(naam) {
  const waarde = process.env[naam];

  if (!waarde) {
    console.error(`${naam} ontbreekt.`);
    process.exit(1);
  }

  return waarde;
}
