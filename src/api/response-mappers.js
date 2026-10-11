// Responses bevatten uitsluitend velden uit de Stekker-OpenAPI-spec
// (spec/stekker-openapi-spec-v2.0.0.yaml). Interne velden, zoals de technische sleutel
// `bronId`, de momentopname, de onderdelen en hun uitkomst of de waarschuwingen,
// blijven zo binnen de stekker.

const SELECTIE_VELDEN = [
  'selectieId',
  'peildatum',
  'selectietijdstip',
  'status',
  'totaalKandidaten',
  'totaalObjecten',
  'totaalBetrokkenen',
  'stekkerNaam',
  'stekkerOmschrijving',
  'stekkerversie',
  'configuratieversie',
  'apiVersie',
  'aantalWaarschuwingen',
  'aantalFouten'
];

const KANDIDAAT_VELDEN = [
  'vernietigingskandidaatId',
  'identificatie',
  'naam',
  'omschrijving',
  'aggregatieniveau',
  'classificatie',
  'dekkingInTijd',
  'waardering',
  'bewaartermijn',
  'informatiecategorie',
  'informatiecategorieAfwijking',
  'isOnderdeelVan',
  'gerelateerdInformatieobject',
  'archiefvormer',
  'activiteit',
  'aantalObjecten',
  'aantalBetrokkenen',
  'toelichting'
];

const KANDIDATEN_PAGINA_VELDEN = ['selectieId', 'offset', 'limit', 'cursor', 'nextCursor', 'totaal', 'items'];

const VERNIETIGING_VELDEN = [
  'vernietigingId',
  'selectieId',
  'cockpitTaakId',
  'vernietigingsdossierId',
  'besluitReferentie',
  'status',
  'starttijd',
  'eindtijd',
  'totaalKandidaten',
  'totaalObjecten',
  'totaalBatches',
  'ontvangenBatches',
  'verwerkteBatches',
  'succesvolVernietigd',
  'mislukt',
  'overgeslagen',
  'gewijzigd',
  'nietGevonden',
  'stekkerNaam',
  'stekkerOmschrijving',
  'stekkerversie',
  'configuratieversie',
  'vernietigingsmethode',
  'vernietigingsmethodeToelichting',
  'aantalWaarschuwingen',
  'aantalFouten'
];

const RESULTAAT_VELDEN = [
  'vernietigingskandidaatId',
  'identificatie',
  'batchNummer',
  'resultaat',
  'event',
  'bronEventReferentie',
  'foutcode',
  'foutmelding',
  'bronstatus',
  'logReference',
  'correlatieId',
  'toelichting'
];

export function toSelectieResponse(selectie) {
  return pick(selectie, SELECTIE_VELDEN);
}

export function toKandidatenPaginaResponse(pagina) {
  return pick({ ...pagina, items: pagina.items.map((kandidaat) => pick(kandidaat, KANDIDAAT_VELDEN)) }, KANDIDATEN_PAGINA_VELDEN);
}

export function toVernietigingResponse(vernietiging) {
  const verwerkteBatches = new Set(vernietiging.resultaten.map((resultaat) => resultaat.batchNummer)).size;
  return pick({ ...vernietiging, verwerkteBatches }, VERNIETIGING_VELDEN);
}

export function toBatchResultaatResponse(batchResultaat) {
  return {
    batchNummer: batchResultaat.batchNummer,
    resultaten: batchResultaat.resultaten.map((resultaat) => pick(resultaat, RESULTAAT_VELDEN))
  };
}

function pick(source, velden) {
  return Object.fromEntries(
    velden
      .filter((veld) => source[veld] !== undefined)
      .map((veld) => [veld, source[veld]])
  );
}
