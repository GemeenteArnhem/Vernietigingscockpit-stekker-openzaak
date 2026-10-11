import { Begrippenlijst, begrip } from '../../config/mdto-config.js';
import { uuidUitUrl } from './zgw-client.js';

// Zet een ZGW-zaak (met _expand.zaaktype en _expand.resultaat._expand.resultaattype) om naar
// een vernietigingskandidaat volgens Stekker API v2 (MDTO). Mapping: analyse §5.

const WAARDERINGEN = {
  vernietigen: ['Tijdelijk te bewaren', 'V'],
  blijvend_bewaren: ['Blijvend te bewaren', 'B']
};

// Cockpit-termijntriggers: bij ZGW-afkomst is de code gelijk aan de afleidingswijze.
const TERMIJNTRIGGERS = {
  afgehandeld: 'Afgehandeld',
  ander_datumkenmerk: 'Ander datumkenmerk',
  eigenschap: 'Eigenschap',
  gerelateerde_zaak: 'Gerelateerde zaak',
  hoofdzaak: 'Hoofdzaak',
  ingangsdatum_besluit: 'Ingangsdatum besluit',
  termijn: 'Termijn',
  vervaldatum_besluit: 'Vervaldatum besluit',
  zaakobject: 'Zaakobject'
};

export const ARCHIEFNOMINATIES = Object.keys(WAARDERINGEN);

// Selectielijstcode uit Cockpit-selectielijsten (ADR-0008, DR-SL-05 punt 6): de Selectielijst API
// kent alleen de gemeentelijke selectielijst; het jaar van het procestype geeft GEM-2017 of GEM-2020.
export function selectielijstcode(procestype) {
  return /^\d{4}$/.test(String(procestype?.jaar ?? '')) ? `GEM-${procestype.jaar}` : undefined;
}

export function naarKandidaat({ zaak, onderdelen, selectielijst, relaties, mdto }) {
  const zaaktype = zaak._expand?.zaaktype ?? {};
  const resultaattype = zaak._expand?.resultaat?._expand?.resultaattype ?? {};
  const [waarderingLabel, waarderingCode] = WAARDERINGEN[zaak.archiefnominatie];
  const afleidingswijze = resultaattype.brondatumArchiefprocedure?.afleidingswijze;

  return {
    vernietigingskandidaatId: `vk-${zaak.uuid ?? uuidUitUrl(zaak.url)}`,
    identificatie: [
      { identificatieKenmerk: zaak.url, identificatieBron: mdto.technischeBron },
      ...(zaak.identificatie ? [{ identificatieKenmerk: zaak.identificatie, identificatieBron: mdto.kenmerkBron }] : [])
    ],
    naam: zaak.omschrijving || zaak.identificatie || zaak.url,
    ...(zaak.toelichting ? { omschrijving: [zaak.toelichting] } : {}),
    // Een zaak is een zaakdossier: de bron beheert hem zelf met een eigen kenmerk (ADR-0007, DR-03).
    aggregatieniveau: begrip('Dossier', Begrippenlijst.aggregatieniveaus),
    classificatie: [{
      begripLabel: zaaktype.omschrijving || zaaktype.identificatie || 'Onbekend zaaktype',
      ...(zaaktype.identificatie ? { begripCode: zaaktype.identificatie } : {}),
      begripBegrippenlijst: {
        verwijzingNaam: 'Zaaktypecatalogus',
        ...(zaaktype.catalogus
          ? { verwijzingIdentificatie: { identificatieKenmerk: zaaktype.catalogus, identificatieBron: 'Open Zaak Catalogi API (catalogus-URL)' } }
          : {})
      }
    }],
    dekkingInTijd: [{
      dekkingInTijdType: begrip('Looptijd', Begrippenlijst.dekkingInTijdtypen, 'looptijd'),
      dekkingInTijdBegindatum: zaak.startdatum,
      ...(zaak.einddatum ? { dekkingInTijdEinddatum: zaak.einddatum } : {})
    }],
    waardering: begrip(waarderingLabel, Begrippenlijst.waarderingen, waarderingCode),
    bewaartermijn: {
      ...(afleidingswijze
        ? { termijnTriggerStartLooptijd: begrip(TERMIJNTRIGGERS[afleidingswijze] ?? afleidingswijze, Begrippenlijst.termijntriggers, afleidingswijze) }
        : {}),
      ...(zaak.startdatumBewaartermijn ? { termijnStartdatumLooptijd: zaak.startdatumBewaartermijn } : {}),
      ...(resultaattype.archiefactietermijn ? { termijnLooptijd: resultaattype.archiefactietermijn } : {}),
      termijnEinddatum: zaak.archiefactiedatum
    },
    informatiecategorie: {
      begripLabel: selectielijst.klasse.naam,
      ...(selectielijst.klasse.volledigNummer || selectielijst.klasse.nummer
        ? { begripCode: String(selectielijst.klasse.volledigNummer || selectielijst.klasse.nummer) }
        : {}),
      begripBegrippenlijst: {
        verwijzingNaam: `Selectielijst gemeenten en intergemeentelijke organen ${selectielijst.procestype.jaar}`,
        verwijzingIdentificatie: { identificatieKenmerk: selectielijstcode(selectielijst.procestype), identificatieBron: Begrippenlijst.selectielijsten }
      }
    },
    ...(relaties.length > 0 ? { gerelateerdInformatieobject: relaties.map((relatie) => gerelateerd(relatie, mdto)) } : {}),
    activiteit: { verwijzingNaam: selectielijst.procestype?.naam || zaaktype.omschrijving || 'Onbekend proces' },
    // Alleen de direct onderliggende objecten: documenten, besluiten en besluitdocumenten (ADR-0007, DR-04).
    aantalObjecten: onderdelen.length,
    aantalBetrokkenen: Array.isArray(zaak.rollen) ? zaak.rollen.length : 0,
    // Intern
    bronId: zaak.url,
    onderdelen: onderdelen.map((onderdeel) => ({
      verwijzingNaam: onderdeel.naam,
      verwijzingIdentificatie: {
        identificatieKenmerk: onderdeel.kenmerk,
        identificatieBron: onderdeel.soort === 'besluit' ? mdto.besluitBron : mdto.documentBron
      }
    })),
    momentopname: {
      zaak: zaak.url,
      archiefnominatie: zaak.archiefnominatie,
      archiefactiedatum: zaak.archiefactiedatum,
      archiefstatus: zaak.archiefstatus,
      deelzaken: zaak.deelzaken ?? [],
      onderdelen
    }
  };
}

// Een document of besluit als onderdeel van de momentopname. Het kenmerk is het nummer uit
// Open Zaak; zonder nummer de URL, zodat het kenmerk binnen de kandidaat uniek blijft. Bij een
// document staan de koppelingen die de stekker bij vernietigen eerst verwijdert:
// zaakinformatieobjecten (zio) en besluitinformatieobjecten (bio).
export function documentOnderdeel(document, koppelingen = []) {
  return {
    soort: 'document',
    url: document.url,
    kenmerk: document.identificatie || document.url,
    naam: document.titel || document.identificatie || 'Document zonder titel',
    koppelingen
  };
}

export function besluitOnderdeel(besluit) {
  return {
    soort: 'besluit',
    url: besluit.url,
    kenmerk: besluit.identificatie || besluit.url,
    naam: `Besluit ${besluit.identificatie || ''}`.trim()
  };
}

function gerelateerd({ soort, url, identificatie, aardRelatie }, mdto) {
  const omschrijving = {
    hoofdzaak: 'Hoofdzaak',
    deelzaak: 'Deelzaak',
    relevant: `Gerelateerde zaak${aardRelatie ? ` (${aardRelatie})` : ''}`
  }[soort];

  return {
    gerelateerdInformatieobjectVerwijzing: {
      verwijzingNaam: `${omschrijving} ${identificatie ?? url}`,
      verwijzingIdentificatie: { identificatieKenmerk: url, identificatieBron: mdto.technischeBron }
    },
    gerelateerdInformatieobjectTypeRelatie: begrip('Refereert aan', Begrippenlijst.relatietypenInformatieobject)
  };
}
