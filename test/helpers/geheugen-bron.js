import { Begrippenlijst, begrip, STANDAARD_MDTO } from '../../src/config/mdto-config.js';

// Bron in het geheugen voor tests van de services en de HTTP-laag: zaken met onderdelen
// (documenten, besluiten), waarvan sommige ook bij een andere zaak horen. Gedraagt zich als
// de OpenZaak-bron: verwijdert onderdelen één voor één met een journaalregel per stap, en
// pas daarna de zaak. Met faalBij en de wijzig-functies zijn fout- en wijzigpaden te testen.

const BASIS_URL = 'https://openzaak.test/zaken/api/v1/zaken';

export class GeheugenBron {
  constructor({ aantal = 200, mdto = STANDAARD_MDTO } = {}) {
    this.mdto = mdto;
    this.zaken = new Map();
    this.storingen = new Map();
    this.aanroepen = { selecteer: 0, controleer: 0, vernietig: 0 };

    for (let nummer = 1; nummer <= aantal; nummer += 1) {
      const zaak = maakZaak(nummer);
      this.zaken.set(zaak.bronId, zaak);
    }
  }

  async selecteer({ peildatum, leverNietV = false }) {
    this.aanroepen.selecteer += 1;
    const zaken = [...this.zaken.values()].filter((zaak) => !zaak.verwijderd);
    const kandidaten = zaken
      .filter((zaak) => (zaak.waardering === 'V' || leverNietV) && zaak.archiefactiedatum <= peildatum)
      .map((zaak) => this.naarKandidaat(zaak));

    return { bronRecords: zaken.length, kandidaten, waarschuwingen: [] };
  }

  async controleer(kandidaat) {
    this.aanroepen.controleer += 1;
    this.storing(kandidaat.bronId, 'controleer');
    const zaak = this.zaken.get(kandidaat.bronId);

    if (!zaak || zaak.verwijderd) {
      return {
        resultaat: 'NOT_FOUND',
        foutcode: 'NOT_FOUND',
        foutmelding: 'Zaak bestaat niet meer in de bron.',
        bronstatus: 'ONTBREEKT'
      };
    }

    if (zaak.archiefactiedatum !== kandidaat.bewaartermijn.termijnEinddatum) {
      return {
        resultaat: 'CHANGED',
        foutcode: 'CHANGED',
        foutmelding: 'Archiefactiedatum is gewijzigd sinds selectie.',
        bronstatus: 'GEWIJZIGD'
      };
    }

    const voor = new Set(kandidaat.momentopname.onderdelen.map((onderdeel) => onderdeel.kenmerk));
    const na = new Set(zaak.onderdelen.map((onderdeel) => onderdeel.kenmerk));
    const bijgekomen = [...na].filter((kenmerk) => !voor.has(kenmerk)).length;
    const verdwenen = [...voor].filter((kenmerk) => !na.has(kenmerk)).length;

    if (bijgekomen > 0 || verdwenen > 0) {
      return {
        resultaat: 'CHANGED',
        foutcode: 'ONDERDELEN_GEWIJZIGD',
        foutmelding: `Onderdelen gewijzigd sinds selectie: ${bijgekomen} bijgekomen, ${verdwenen} verdwenen. Niets van deze kandidaat is vernietigd.`,
        bronstatus: 'GEWIJZIGD'
      };
    }

    return undefined;
  }

  async vernietig(kandidaat, { journaal, clock }) {
    this.aanroepen.vernietig += 1;
    const zaak = this.zaken.get(kandidaat.bronId);
    const regels = await journaal.lees();
    const gedaan = new Map(regels.filter((regel) => regel.identificatieKenmerk).map((regel) => [regel.identificatieKenmerk, regel.uitkomst]));
    const onderdeelUitkomsten = [];

    for (const { kenmerk } of kandidaat.momentopname.onderdelen) {
      if (!gedaan.has(kenmerk)) {
        this.storing(kandidaat.bronId, kenmerk);
        const index = zaak.onderdelen.findIndex((onderdeel) => onderdeel.kenmerk === kenmerk);
        const onderdeel = zaak.onderdelen[index];
        const uitkomst = onderdeel?.gedeeld ? 'ontkoppeld' : 'vernietigd';

        if (index >= 0) {
          zaak.onderdelen.splice(index, 1);
        }

        await journaal.schrijf({ identificatieKenmerk: kenmerk, uitkomst, tijdstip: clock().toISOString(), wijziging: true });
        gedaan.set(kenmerk, uitkomst);
      }

      onderdeelUitkomsten.push({ identificatieKenmerk: kenmerk, uitkomst: gedaan.get(kenmerk) });
    }

    let zaakRegel = regels.find((regel) => regel.stap === 'zaak');

    if (!zaakRegel) {
      this.storing(kandidaat.bronId, 'zaak');
      zaak.verwijderd = true;
      zaakRegel = { stap: 'zaak', tijdstip: clock().toISOString(), wijziging: true };
      await journaal.schrijf(zaakRegel);
    }

    return { eventTijd: zaakRegel.tijdstip, onderdeelUitkomsten };
  }

  // --- Hulpfuncties voor tests ---

  // Laat een stap (controleer, een onderdeelkenmerk of 'zaak') voor een zaak `keer` keer falen.
  faalBij(bronId, stap, keer = Number.POSITIVE_INFINITY) {
    this.storingen.set(`${bronId}|${stap}`, keer);
  }

  storing(bronId, stap) {
    const sleutel = `${bronId}|${stap}`;
    const resterend = this.storingen.get(sleutel) ?? 0;

    if (resterend > 0) {
      this.storingen.set(sleutel, resterend - 1);
      throw new Error(`Gesimuleerde storing bij ${stap}.`);
    }
  }

  zaak(bronId) {
    return this.zaken.get(bronId);
  }

  verwijderZaak(bronId) {
    this.zaken.get(bronId).verwijderd = true;
  }

  voegOnderdeelToe(bronId) {
    const zaak = this.zaken.get(bronId);
    zaak.onderdelen.push({ kenmerk: `${zaak.identificatie}-NIEUW`, naam: 'Later toegevoegd document', soort: 'document' });
  }

  naarKandidaat(zaak) {
    const onderdelen = zaak.onderdelen.map((onderdeel) => ({ ...onderdeel }));

    return {
      vernietigingskandidaatId: `vk-${zaak.identificatie}`,
      identificatie: [
        { identificatieKenmerk: zaak.bronId, identificatieBron: this.mdto.technischeBron },
        { identificatieKenmerk: zaak.identificatie, identificatieBron: this.mdto.kenmerkBron }
      ],
      naam: zaak.naam,
      aggregatieniveau: begrip('Dossier', Begrippenlijst.aggregatieniveaus),
      classificatie: [begrip('Aanvraag Wmo-voorziening', 'Zaaktypecatalogus Gemeente Voorbeeld', 'WMO-AANVRAAG')],
      dekkingInTijd: [{
        dekkingInTijdType: begrip('Looptijd', Begrippenlijst.dekkingInTijdtypen, 'looptijd'),
        dekkingInTijdBegindatum: zaak.startdatum,
        dekkingInTijdEinddatum: zaak.einddatum
      }],
      waardering: zaak.waardering === 'V'
        ? begrip('Tijdelijk te bewaren', Begrippenlijst.waarderingen, 'V')
        : begrip('Blijvend te bewaren', Begrippenlijst.waarderingen, 'B'),
      bewaartermijn: {
        termijnTriggerStartLooptijd: begrip('Afgehandeld', Begrippenlijst.termijntriggers, 'afgehandeld'),
        termijnStartdatumLooptijd: '2018-07-01',
        termijnLooptijd: 'P7Y',
        termijnEinddatum: zaak.archiefactiedatum
      },
      informatiecategorie: {
        begripLabel: '7.1.2 – Aanvraag voorziening toegekend',
        begripBegrippenlijst: {
          verwijzingNaam: 'Selectielijst gemeenten en intergemeentelijke organen 2020',
          verwijzingIdentificatie: { identificatieKenmerk: 'GEM-2020', identificatieBron: 'Cockpit-selectielijsten' }
        }
      },
      activiteit: { verwijzingNaam: 'Aanvraag Wmo-voorziening' },
      aantalObjecten: onderdelen.length,
      aantalBetrokkenen: 1,
      // Intern
      bronId: zaak.bronId,
      onderdelen: onderdelen.map((onderdeel) => ({
        verwijzingNaam: onderdeel.naam,
        verwijzingIdentificatie: { identificatieKenmerk: onderdeel.kenmerk, identificatieBron: this.mdto.kenmerkBron }
      })),
      momentopname: { onderdelen }
    };
  }
}

// Deterministische zaken: elke vierde zaak is blijvend te bewaren (B), elke zevende heeft
// een archiefactiedatum in de toekomst, elke derde een besluit met besluitdocument, en bij
// elke vijfde hoort het eerste document ook bij een andere zaak.
function maakZaak(nummer) {
  const volgnummer = String(nummer).padStart(4, '0');
  const identificatie = `ZAAK-2018-${volgnummer}`;
  const documenten = Array.from({ length: (nummer % 3) + 1 }, (_, index) => ({
    kenmerk: `${identificatie}-D${index + 1}`,
    naam: `Document ${index + 1} bij ${identificatie}`,
    soort: 'document',
    gedeeld: index === 0 && nummer % 5 === 0
  }));
  const besluiten = nummer % 3 === 0
    ? [
        { kenmerk: `${identificatie}-B1`, naam: `Besluit bij ${identificatie}`, soort: 'besluit' },
        { kenmerk: `${identificatie}-B1-D1`, naam: `Besluitbrief bij ${identificatie}`, soort: 'document' }
      ]
    : [];

  return {
    bronId: `${BASIS_URL}/00000000-0000-4000-8000-00000000${volgnummer}`,
    identificatie,
    naam: `Aanvraag traplift ${volgnummer}`,
    waardering: nummer % 4 === 0 ? 'B' : 'V',
    startdatum: '2018-01-15',
    einddatum: '2018-06-30',
    archiefactiedatum: nummer % 7 === 0 ? '2030-07-01' : '2025-07-01',
    onderdelen: [...documenten, ...besluiten],
    verwijderd: false
  };
}
