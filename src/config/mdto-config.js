// MDTO-gegevens die niet uit Open Zaak komen, maar wel nodig zijn voor de Stekker API v2
// en de MDTO-XML-specificatie (ADR-0005). Per stekkerinstantie instelbaar via env.

export const METHODE_LABELS = [
  'Verwijderd via bronfunctie',
  'Fysiek verwijderd',
  'Overschreven',
  'Cryptografisch onleesbaar gemaakt',
  'Overig'
];

export function parseMdtoConfig(env = process.env) {
  const vernietigingsmethode = (env.STEKKER_VERNIETIGINGSMETHODE ?? '').trim() || 'Verwijderd via bronfunctie';

  if (!METHODE_LABELS.includes(vernietigingsmethode)) {
    throw new Error(`STEKKER_VERNIETIGINGSMETHODE moet een van ${METHODE_LABELS.join(', ')} zijn.`);
  }

  return {
    // identificatieBron van de technische sleutel (zaak-URL) en van het zaaknummer.
    technischeBron: (env.STEKKER_IDENTIFICATIEBRON_TECHNISCH ?? '').trim() || 'Open Zaak Zaken API (zaak-URL)',
    kenmerkBron: (env.STEKKER_IDENTIFICATIEBRON_KENMERK ?? '').trim() || 'Zaaknummering gemeente Voorbeeld',
    // identificatieBron van de onderdelen: documentnummer en besluitnummer uit Open Zaak.
    documentBron: (env.STEKKER_IDENTIFICATIEBRON_DOCUMENT ?? '').trim() || 'Documentnummering gemeente Voorbeeld',
    besluitBron: (env.STEKKER_IDENTIFICATIEBRON_BESLUIT ?? '').trim() || 'Besluitnummering gemeente Voorbeeld',
    archiefvormer: (env.STEKKER_ARCHIEFVORMER ?? '').trim() || 'Gemeente Voorbeeld',
    vernietigingsmethode,
    vernietigingsmethodeToelichting: (env.STEKKER_VERNIETIGINGSMETHODE_TOELICHTING ?? '').trim()
      || 'Verwijderd via de DELETE-endpoints van de Zaken, Documenten en Besluiten API van Open Zaak. Back-ups, replica\'s en de audittrail van Open Zaak vallen buiten de stekker.'
  };
}

export const STANDAARD_MDTO = parseMdtoConfig({});

// Namen van de begrippenlijsten (MDTO en eigen, designrules/begrippenlijsten/).
export const Begrippenlijst = Object.freeze({
  aggregatieniveaus: 'Begrippenlijst Aggregatieniveaus MDTO',
  waarderingen: 'Begrippenlijst Waarderingen MDTO',
  eventtypen: 'Begrippenlijst Eventtypen MDTO',
  relatietypenInformatieobject: 'Begrippenlijst Relatietypen informatieobject MDTO',
  beperkingGebruik: 'Begrippenlijst BeperkingGebruik MDTO',
  termijntriggers: 'Cockpit-termijntriggers',
  dekkingInTijdtypen: 'Cockpit-dekkingInTijdtypen',
  vernietigingsmethoden: 'Cockpit-vernietigingsmethoden',
  selectielijsten: 'Cockpit-selectielijsten'
});

export function begrip(begripLabel, begrippenlijst, begripCode) {
  return {
    begripLabel,
    ...(begripCode ? { begripCode } : {}),
    begripBegrippenlijst: { verwijzingNaam: begrippenlijst }
  };
}
