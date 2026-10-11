import { STANDAARD_MDTO } from '../../config/mdto-config.js';
import { ARCHIEFNOMINATIES, besluitOnderdeel, documentOnderdeel, naarKandidaat, selectielijstcode } from './mapping.js';
import { metBeperking } from './parallel.js';

// De bron Open Zaak (Zaken, Documenten, Besluiten en Catalogi API, plus de Selectielijst API).
// Selectie naar Open Archiefbeheer (zaken/tasks.py, retrieve_and_cache_zaken), maar zonder
// lokale kopie van alle zaken: de stekker haalt bij elke selectie op wat nu vernietigbaar is
// en legt per kandidaat een momentopname van de onderdelen vast (ADR-0007, DR-04).
// Zie src/application/bron.js voor de poort.
export class OpenZaakBron {
  constructor({ client, mdto = STANDAARD_MDTO, parallel = 8, zaaktypen = [], klok = () => new Date() }) {
    this.client = client;
    this.klok = klok;
    this.mdto = mdto;
    this.parallel = parallel;
    // Optioneel: alleen zaken van deze zaaktypen (identificatie); leeg = alle.
    this.zaaktypen = new Set(zaaktypen);
    this.selectielijstCache = new Map();
  }

  async selecteer({ peildatum, leverNietV = false }) {
    // Alle afgehandelde zaken waarvan de archiefactiedatum op of vóór de peildatum ligt. Bewust
    // zonder filter op archiefnominatie: zaken zonder nominatie moeten als waarschuwing opvallen.
    const zaken = await this.client.alle(this.client.url('zaken', 'zaken'), {
      params: {
        einddatum__isnull: 'false',
        archiefactiedatum__lt: dagNa(peildatum),
        expand: 'resultaat,resultaat.resultaattype,zaaktype'
      }
    });
    const waarschuwingen = [];
    const teSelecteren = [];

    for (const zaak of zaken) {
      const nummer = zaak.identificatie || zaak.url;

      // Al overgebracht naar een archiefbewaarplaats: nooit vernietigen.
      if (zaak.archiefstatus === 'overgedragen') {
        continue;
      }

      if (this.zaaktypen.size > 0 && !this.zaaktypen.has(zaak._expand?.zaaktype?.identificatie)) {
        continue;
      }

      if (!zaak.archiefnominatie) {
        waarschuwingen.push(`Zaak ${nummer}: archiefactiedatum ${zaak.archiefactiedatum} is verstreken, maar de archiefnominatie ontbreekt; niet geselecteerd.`);
        continue;
      }

      if (!ARCHIEFNOMINATIES.includes(zaak.archiefnominatie)) {
        waarschuwingen.push(`Zaak ${nummer}: onbekende archiefnominatie ${zaak.archiefnominatie}; niet geselecteerd.`);
        continue;
      }

      // Blijvend te bewaren alleen als testscenario, zodat de Cockpit die kan uitsluiten (B-M1).
      if (zaak.archiefnominatie === 'blijvend_bewaren' && !leverNietV) {
        continue;
      }

      teSelecteren.push(zaak);
    }

    const zaakPerUrl = new Map(zaken.map((zaak) => [zaak.url, zaak]));
    const kandidaten = await metBeperking(teSelecteren, this.parallel, async (zaak) => {
      const selectielijst = await this.selectielijstVoor(zaak);

      if (!selectielijst) {
        waarschuwingen.push(`Zaak ${zaak.identificatie || zaak.url}: geen selectielijstklasse (zaak of resultaattype); niet geselecteerd.`);
        return undefined;
      }

      // Zonder jaar van het procestype is er geen selectielijstcode (ADR-0008); de kandidaat zou het contract schenden.
      if (!selectielijstcode(selectielijst.procestype)) {
        waarschuwingen.push(`Zaak ${zaak.identificatie || zaak.url}: geen selectielijstjaar (procestype van de selectielijstklasse); niet geselecteerd.`);
        return undefined;
      }

      const [onderdelen, relaties] = await Promise.all([this.onderdelenVan(zaak.url), this.relatiesVan(zaak, zaakPerUrl)]);
      return naarKandidaat({ zaak, onderdelen, selectielijst, relaties, mdto: this.mdto });
    });

    return {
      bronRecords: zaken.length,
      kandidaten: kandidaten.filter(Boolean),
      waarschuwingen
    };
  }

  // De direct onderliggende objecten van een zaak: de documenten (via zaakinformatieobjecten),
  // de besluiten en de documenten van die besluiten (via besluitinformatieobjecten). Een
  // document dat via meer wegen aan de zaak hangt, telt één keer. Volgorde: zaakdocumenten,
  // dan per besluit het besluit en zijn documenten.
  async onderdelenVan(zaakUrl) {
    const [zios, besluiten] = await Promise.all([
      this.client.alle(this.client.url('zaken', 'zaakinformatieobjecten'), { params: { zaak: zaakUrl } }),
      this.client.alle(this.client.url('besluiten', 'besluiten'), { params: { zaak: zaakUrl } })
    ]);
    const bios = await Promise.all(besluiten.map((besluit) => this.client.alle(
      this.client.url('besluiten', 'besluitinformatieobjecten'),
      { params: { besluit: besluit.url } }
    )));
    const documentUrls = [...new Set([
      ...zios.map((zio) => zio.informatieobject),
      ...bios.flat().map((bio) => bio.informatieobject)
    ])];
    const koppelingen = new Map(documentUrls.map((url) => [url, []]));
    zios.forEach((zio) => koppelingen.get(zio.informatieobject).push({ soort: 'zio', url: zio.url }));
    bios.flat().forEach((bio) => koppelingen.get(bio.informatieobject).push({ soort: 'bio', url: bio.url }));
    // Op de URL zoals de koppeling hem noemt; daarop zoeken de koppelingen hieronder het document.
    const documenten = new Map((await metBeperking(documentUrls, this.parallel, (url) => this.client.get(url)))
      .map((document, index) => [documentUrls[index], documentOnderdeel({ ...document, url: documentUrls[index] }, koppelingen.get(documentUrls[index]))]));
    const gehad = new Set();
    const eenKeer = (url) => {
      if (gehad.has(url)) {
        return [];
      }

      gehad.add(url);
      return [documenten.get(url)];
    };

    return [
      ...zios.flatMap((zio) => eenKeer(zio.informatieobject)),
      ...besluiten.flatMap((besluit, index) => [
        besluitOnderdeel(besluit),
        ...bios[index].flatMap((bio) => eenKeer(bio.informatieobject))
      ])
    ];
  }

  // Hoofdzaak, deelzaken en relevante andere zaken, met hun zaaknummer. Een zaak buiten de
  // opgehaalde set wordt apart opgevraagd; bestaat die niet meer, dan blijft alleen de URL.
  async relatiesVan(zaak, zaakPerUrl) {
    const relaties = [
      ...(zaak.hoofdzaak ? [{ soort: 'hoofdzaak', url: zaak.hoofdzaak }] : []),
      ...(zaak.deelzaken ?? []).map((url) => ({ soort: 'deelzaak', url })),
      ...(zaak.relevanteAndereZaken ?? []).map(({ url, aardRelatie }) => ({ soort: 'relevant', url, aardRelatie }))
    ];

    return Promise.all(relaties.map(async (relatie) => ({ ...relatie, identificatie: await this.zaaknummer(relatie.url, zaakPerUrl) })));
  }

  async zaaknummer(url, zaakPerUrl) {
    if (zaakPerUrl.has(url)) {
      return zaakPerUrl.get(url).identificatie;
    }

    try {
      return (await this.client.get(url)).identificatie;
    } catch (error) {
      if (error.status === 404 || error.code === 'ONBEKENDE_URL') {
        return undefined;
      }

      throw error;
    }
  }

  // Selectielijstklasse van de zaak, anders die van het resultaattype; met het procestype voor
  // het selectielijstjaar. Elke URL wordt één keer opgehaald.
  async selectielijstVoor(zaak) {
    const klasseUrl = zaak.selectielijstklasse || zaak._expand?.resultaat?._expand?.resultaattype?.selectielijstklasse;

    if (!klasseUrl) {
      return undefined;
    }

    const klasse = await this.selectielijstResource(klasseUrl);
    const procestype = klasse.procesType ? await this.selectielijstResource(klasse.procesType) : undefined;
    return { klasse, procestype };
  }

  selectielijstResource(url) {
    if (!this.selectielijstCache.has(url)) {
      const ophalen = this.client.get(url);
      // Een mislukte opvraging niet bewaren: de volgende selectie probeert het opnieuw.
      ophalen.catch(() => this.selectielijstCache.delete(url));
      this.selectielijstCache.set(url, ophalen);
    }

    return this.selectielijstCache.get(url);
  }

  // Vlak vóór vernietigen (ADR-0007, DR-04; besluit stap 4): is de zaak nog zoals bij selectie?
  // Gekeken wordt naar de archiefgegevens en de onderdelen; een andere omschrijving of status
  // houdt de vernietiging niet tegen. Naar OAB (_delete_destruction_list_item): nooit een zaak
  // vernietigen waarvan de archiefactiedatum nog in de toekomst ligt.
  async controleer(kandidaat) {
    const momentopname = kandidaat.momentopname;
    let zaak;

    try {
      zaak = await this.client.get(momentopname.zaak);
    } catch (error) {
      if (error.status === 404) {
        return afwijking('NOT_FOUND', 'NOT_FOUND', 'Zaak bestaat niet meer in Open Zaak.', 'ONTBREEKT');
      }

      throw error;
    }

    if (zaak.archiefstatus === 'overgedragen') {
      return afwijking('CHANGED', 'OVERGEDRAGEN', 'Zaak is sinds de selectie overgedragen aan een archiefbewaarplaats.');
    }

    if (zaak.archiefnominatie !== momentopname.archiefnominatie) {
      return afwijking('CHANGED', 'ARCHIEFNOMINATIE_GEWIJZIGD', `Archiefnominatie is gewijzigd sinds de selectie: ${momentopname.archiefnominatie} → ${zaak.archiefnominatie ?? 'leeg'}.`);
    }

    if (zaak.archiefactiedatum !== momentopname.archiefactiedatum) {
      return afwijking('CHANGED', 'ARCHIEFACTIEDATUM_GEWIJZIGD', `Archiefactiedatum is gewijzigd sinds de selectie: ${momentopname.archiefactiedatum} → ${zaak.archiefactiedatum ?? 'leeg'}.`);
    }

    // Open Zaak verwijdert de deelzaken van een hoofdzaak stil mee (getoetst op 1.30.0). Een
    // hoofdzaak gaat daarom pas als er geen deelzaak meer aan hangt (besluit stap 5).
    if (zaak.deelzaken?.length > 0) {
      return afwijking('SKIPPED', 'DEELZAKEN_AANWEZIG', `Aan deze hoofdzaak hangen nog ${zaak.deelzaken.length} deelzaak/deelzaken; Open Zaak zou die zonder controle meeverwijderen. Vernietig eerst de deelzaken.`, 'ONVERANDERD');
    }

    if (!zaak.archiefactiedatum || zaak.archiefactiedatum > this.klok().toISOString().slice(0, 10)) {
      return afwijking('SKIPPED', 'NOG_NIET_VERNIETIGBAAR', `Archiefactiedatum ${zaak.archiefactiedatum ?? 'ontbreekt'} ligt na vandaag; de zaak mag nog niet vernietigd worden.`, 'ONVERANDERD');
    }

    const huidig = await this.onderdelenVan(zaak.url);
    const sleutel = (onderdeel) => `${onderdeel.soort}|${onderdeel.url}`;
    const voor = new Set(momentopname.onderdelen.map(sleutel));
    const na = new Set(huidig.map(sleutel));
    const bijgekomen = [...na].filter((item) => !voor.has(item)).length;
    const verdwenen = [...voor].filter((item) => !na.has(item)).length;

    if (bijgekomen > 0 || verdwenen > 0) {
      return afwijking('CHANGED', 'ONDERDELEN_GEWIJZIGD', `Onderdelen gewijzigd sinds de selectie: ${bijgekomen} bijgekomen, ${verdwenen} verdwenen. Niets van deze kandidaat is vernietigd.`);
    }

    return undefined;
  }

  // Vernietigt de zaak in de volgorde van Open Archiefbeheer (_delete_destruction_list_item):
  //   1. besluitinformatieobjecten, 2. besluiten, 3. zaakinformatieobjecten, 4. documenten,
  //   5. de zaak (Open Zaak ruimt rollen, statussen, resultaat en zaakobjecten zelf op).
  // Externe registers (Objecten API) komen later (B-OZ4). Elke stap staat in het journaal
  // voordat de volgende begint; een herhaalde aanroep slaat afgeronde stappen over. 404 = al weg.
  // Een document of besluit dat nog ergens anders aan hangt (pending-relations), blijft
  // bestaan en heet 'ontkoppeld' (B-OZ2).
  async vernietig(kandidaat, { journaal, clock }) {
    const { zaak: zaakUrl, onderdelen } = kandidaat.momentopname;
    const gedaan = new Map((await journaal.lees()).filter((regel) => regel.url).map((regel) => [regel.url, regel]));
    const documenten = onderdelen.filter((onderdeel) => onderdeel.soort === 'document');
    const besluiten = onderdelen.filter((onderdeel) => onderdeel.soort === 'besluit');
    const koppelingen = (soort) => documenten.flatMap((document) => document.koppelingen.filter((koppeling) => koppeling.soort === soort));

    const verwijderKoppeling = async ({ url }) => {
      if (!gedaan.has(url)) {
        const resultaat = await this.client.verwijder(url);

        if (resultaat === 'pending-relations') {
          throw new Error(`Open Zaak weigert koppeling ${url} te verwijderen (pending-relations).`);
        }

        await vastleggen({ stap: 'koppeling', url, resultaat, wijziging: true });
      }
    };
    const verwijderOnderdeel = async (onderdeel) => {
      if (!gedaan.has(onderdeel.url)) {
        const resultaat = await this.client.verwijder(onderdeel.url);
        const uitkomst = resultaat === 'pending-relations' ? 'ontkoppeld' : 'vernietigd';
        await vastleggen({ stap: onderdeel.soort, url: onderdeel.url, identificatieKenmerk: onderdeel.kenmerk, resultaat, uitkomst, wijziging: true });
      }
    };
    const vastleggen = async (regel) => {
      const volledig = { ...regel, tijdstip: clock().toISOString() };
      await journaal.schrijf(volledig);
      gedaan.set(regel.url, volledig);
      return volledig;
    };

    for (const koppeling of koppelingen('bio')) {
      await verwijderKoppeling(koppeling);
    }

    for (const besluit of besluiten) {
      await verwijderOnderdeel(besluit);
    }

    for (const koppeling of koppelingen('zio')) {
      await verwijderKoppeling(koppeling);
    }

    for (const document of documenten) {
      await verwijderOnderdeel(document);
    }

    let zaakRegel = gedaan.get(zaakUrl);

    if (!zaakRegel) {
      await this.controleerNietsNieuws(kandidaat);
      const start = gedaan.get(`${zaakUrl}#start`) ?? await vastleggen({ stap: 'zaak-start', url: `${zaakUrl}#start` });
      const resultaat = await this.client.verwijder(zaakUrl);

      if (resultaat === 'pending-relations') {
        throw new Error('Open Zaak weigert de zaak te verwijderen: er hangt nog iets aan (pending-relations).');
      }

      // 404: al weg, zoals na een crash tussen het verwijderen en het journaal.
      zaakRegel = await vastleggen({ stap: 'zaak', url: zaakUrl, resultaat, wijziging: true });

      if (resultaat === 'niet-gevonden') {
        zaakRegel = { ...zaakRegel, tijdstip: start.tijdstip };
      }
    }

    return {
      eventTijd: zaakRegel.tijdstip,
      onderdeelUitkomsten: onderdelen.map((onderdeel) => ({
        identificatieKenmerk: onderdeel.kenmerk,
        uitkomst: gedaan.get(onderdeel.url).uitkomst
      }))
    };
  }

  // Binnen een batch eerst de zaken zonder deelzaken, dan de hoofdzaken: zijn hoofdzaak en
  // deelzaak samen vrijgegeven, dan is de deelzaak weg als de hoofdzaak aan de beurt is.
  volgorde(kandidaten) {
    return [
      ...kandidaten.filter((kandidaat) => !(kandidaat.momentopname?.deelzaken?.length > 0)),
      ...kandidaten.filter((kandidaat) => kandidaat.momentopname?.deelzaken?.length > 0)
    ];
  }

  // Laatste vangnet vóór het verwijderen van de zaak: hangt er nu nog een document, besluit of
  // deelzaak aan dat niet in de momentopname stond (bijv. toegevoegd tijdens een onderbroken
  // vernietiging), dan wordt de zaak niet verwijderd. Open Zaak zou dat anders stil opruimen
  // (koppelingen, deelzaken).
  async controleerNietsNieuws(kandidaat) {
    const zaak = await this.client.get(kandidaat.momentopname.zaak);

    if (zaak.deelzaken?.length > 0) {
      throw new Error(`Aan de zaak hangen nog ${zaak.deelzaken.length} deelzaak/deelzaken; de zaak is niet verwijderd.`);
    }

    const bekend = new Set(kandidaat.momentopname.onderdelen.flatMap((onderdeel) => [onderdeel.url, ...(onderdeel.koppelingen ?? []).map((koppeling) => koppeling.url)]));
    const [zios, besluiten] = await Promise.all([
      this.client.alle(this.client.url('zaken', 'zaakinformatieobjecten'), { params: { zaak: kandidaat.momentopname.zaak } }),
      this.client.alle(this.client.url('besluiten', 'besluiten'), { params: { zaak: kandidaat.momentopname.zaak } })
    ]);
    const nieuw = [...zios.filter((zio) => !bekend.has(zio.url)), ...besluiten.filter((besluit) => !bekend.has(besluit.url))];

    if (nieuw.length > 0) {
      throw new Error(`Er hangen ${nieuw.length} nieuwe onderdelen aan de zaak die niet in de selectie stonden; de zaak is niet verwijderd.`);
    }
  }
}

function afwijking(resultaat, foutcode, foutmelding, bronstatus = 'GEWIJZIGD') {
  return { resultaat, foutcode, foutmelding, bronstatus };
}

function dagNa(datum) {
  const dag = new Date(`${datum}T00:00:00Z`);
  dag.setUTCDate(dag.getUTCDate() + 1);
  return dag.toISOString().slice(0, 10);
}
