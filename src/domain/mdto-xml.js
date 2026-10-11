import { Begrippenlijst, begrip } from '../config/mdto-config.js';

// MDTO-XML 1.0.1 (Nationaal Archief) voor de specificatie van een vernietigde kandidaat
// (ADR-0005, B-M2). De elementvolgorde volgt de XSD (spec/mdto/MDTO-XML1.0.1.xsd).
// `bevatOnderdeel` bevat precies de onderdelen uit de momentopname (ADR-0007, DR-04). Een
// onderdeel dat ook bij een ander object hoort, wordt ontkoppeld en niet vernietigd (B-OZ2);
// MDTO kent geen status per verwijzing, dus dat staat in eventResultaat.

const MDTO_NAMESPACE = 'https://www.nationaalarchief.nl/mdto';
const MDTO_SCHEMA_LOCATION = 'https://www.nationaalarchief.nl/mdto https://www.nationaalarchief.nl/mdto/MDTO-XML1.0.1.xsd';

export function maakSpecificatieXml({ kandidaat, event, onderdeelUitkomsten = [], archiefvormer, vernietigingsmethodeToelichting }) {
  const archiefvormers = kandidaat.archiefvormer?.length ? kandidaat.archiefvormer : [{ verwijzingNaam: archiefvormer }];
  const ontkoppeld = onderdeelUitkomsten
    .filter((item) => item.uitkomst === 'ontkoppeld')
    .map((item) => item.identificatieKenmerk);
  const eventResultaat = [
    event.eventResultaat,
    ontkoppeld.length > 0 ? `Ontkoppeld en niet vernietigd, blijft bestaan bij een ander object: ${ontkoppeld.join(', ')}.` : undefined,
    vernietigingsmethodeToelichting
  ].filter(Boolean).join(' ');
  const regels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MDTO xmlns="${MDTO_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${MDTO_SCHEMA_LOCATION}">`,
    '  <informatieobject>',
    ...kandidaat.identificatie.map((item) => identificatie('identificatie', item, 4)),
    element('naam', kandidaat.naam, 4),
    begripXml('aggregatieniveau', kandidaat.aggregatieniveau, 4),
    ...(kandidaat.classificatie ?? []).map((item) => begripXml('classificatie', item, 4)),
    ...(kandidaat.omschrijving ?? []).map((tekst) => element('omschrijving', tekst, 4)),
    ...(kandidaat.dekkingInTijd ?? []).map((item) => dekkingInTijd(item, 4)),
    eventXml({ ...event, eventResultaat }, 4),
    begripXml('waardering', kandidaat.waardering, 4),
    termijn('bewaartermijn', kandidaat.bewaartermijn, 4),
    begripXml('informatiecategorie', kandidaat.informatiecategorie, 4),
    ...(kandidaat.isOnderdeelVan ?? []).map((item) => verwijzing('isOnderdeelVan', item, 4)),
    ...(kandidaat.onderdelen ?? []).map((item) => verwijzing('bevatOnderdeel', item, 4)),
    ...(kandidaat.gerelateerdInformatieobject ?? []).map((item) => gerelateerd(item, 4)),
    ...archiefvormers.map((item) => verwijzing('archiefvormer', item, 4)),
    ...(kandidaat.activiteit ? [verwijzing('activiteit', kandidaat.activiteit, 4)] : []),
    blok('beperkingGebruik', [begripXml('beperkingGebruikType', begrip('Nader te bepalen', Begrippenlijst.beperkingGebruik), 6)], 4),
    '  </informatieobject>',
    '</MDTO>',
    ''
  ];

  return regels.join('\n');
}

function identificatie(naam, { identificatieKenmerk, identificatieBron }, inspring) {
  return blok(naam, [
    element('identificatieKenmerk', identificatieKenmerk, inspring + 2),
    element('identificatieBron', identificatieBron, inspring + 2)
  ], inspring);
}

function verwijzing(naam, { verwijzingNaam, verwijzingIdentificatie }, inspring) {
  return blok(naam, [
    element('verwijzingNaam', verwijzingNaam, inspring + 2),
    ...(verwijzingIdentificatie ? [identificatie('verwijzingIdentificatie', verwijzingIdentificatie, inspring + 2)] : [])
  ], inspring);
}

function begripXml(naam, { begripLabel, begripCode, begripBegrippenlijst }, inspring) {
  return blok(naam, [
    element('begripLabel', begripLabel, inspring + 2),
    ...(begripCode ? [element('begripCode', begripCode, inspring + 2)] : []),
    verwijzing('begripBegrippenlijst', begripBegrippenlijst, inspring + 2)
  ], inspring);
}

function dekkingInTijd({ dekkingInTijdType, dekkingInTijdBegindatum, dekkingInTijdEinddatum }, inspring) {
  return blok('dekkingInTijd', [
    begripXml('dekkingInTijdType', dekkingInTijdType, inspring + 2),
    element('dekkingInTijdBegindatum', dekkingInTijdBegindatum, inspring + 2),
    ...(dekkingInTijdEinddatum ? [element('dekkingInTijdEinddatum', dekkingInTijdEinddatum, inspring + 2)] : [])
  ], inspring);
}

function eventXml({ eventType, eventTijd, eventResultaat }, inspring) {
  return blok('event', [
    begripXml('eventType', eventType, inspring + 2),
    ...(eventTijd ? [element('eventTijd', eventTijd, inspring + 2)] : []),
    ...(eventResultaat ? [element('eventResultaat', eventResultaat, inspring + 2)] : [])
  ], inspring);
}

function termijn(naam, gegevens, inspring) {
  const { termijnTriggerStartLooptijd, termijnStartdatumLooptijd, termijnLooptijd, termijnEinddatum } = gegevens;

  return blok(naam, [
    ...(termijnTriggerStartLooptijd ? [begripXml('termijnTriggerStartLooptijd', termijnTriggerStartLooptijd, inspring + 2)] : []),
    ...(termijnStartdatumLooptijd ? [element('termijnStartdatumLooptijd', termijnStartdatumLooptijd, inspring + 2)] : []),
    ...(termijnLooptijd ? [element('termijnLooptijd', termijnLooptijd, inspring + 2)] : []),
    ...(termijnEinddatum ? [element('termijnEinddatum', termijnEinddatum, inspring + 2)] : [])
  ], inspring);
}

function gerelateerd({ gerelateerdInformatieobjectVerwijzing, gerelateerdInformatieobjectTypeRelatie }, inspring) {
  return blok('gerelateerdInformatieobject', [
    verwijzing('gerelateerdInformatieobjectVerwijzing', gerelateerdInformatieobjectVerwijzing, inspring + 2),
    begripXml('gerelateerdInformatieobjectTypeRelatie', gerelateerdInformatieobjectTypeRelatie, inspring + 2)
  ], inspring);
}

function blok(naam, inhoud, inspring) {
  const ruimte = ' '.repeat(inspring);
  return [`${ruimte}<${naam}>`, ...inhoud, `${ruimte}</${naam}>`].join('\n');
}

function element(naam, waarde, inspring) {
  return `${' '.repeat(inspring)}<${naam}>${escape(String(waarde))}</${naam}>`;
}

function escape(tekst) {
  return tekst
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
