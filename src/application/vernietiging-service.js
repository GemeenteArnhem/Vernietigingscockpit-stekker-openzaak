import crypto from 'node:crypto';
import { Begrippenlijst, begrip } from '../config/mdto-config.js';
import { GEEN_SCENARIO, scenarioResultaat } from '../config/scenario-config.js';
import { stekkerConfig } from '../config/stekker-config.js';
import { technischeSleutel } from '../domain/identificatie.js';
import { maakSpecificatieXml } from '../domain/mdto-xml.js';
import { SelectieStatus, Uitvoeringsresultaat, VernietigingStatus } from '../domain/status.js';
import { controleerBron } from './bron.js';
import { ConflictError, ResourceNotFoundError, ValidationError } from './errors.js';
import { canoniekeJson, Idempotentie } from './idempotentie.js';
import { InMemoryIdempotencyRepository } from '../infrastructure/repositories/in-memory-idempotency-repository.js';
import { InMemoryJournaalRepository } from '../infrastructure/repositories/in-memory-journaal-repository.js';

export { ConflictError, ResourceNotFoundError, ValidationError };

export class VernietigingService {
  constructor({
    bron,
    selectieService,
    vernietigingRepository,
    journaalRepository = new InMemoryJournaalRepository(),
    clock = () => new Date(),
    processingDelayMs = stekkerConfig.vernietigingProcessingDelayMs,
    maxPogingen = stekkerConfig.vernietigingMaxPogingen,
    wachttijdPogingMs = stekkerConfig.vernietigingWachttijdPogingMs,
    idempotencyRepository = new InMemoryIdempotencyRepository(),
    scenario = stekkerConfig.scenario ?? GEEN_SCENARIO,
    mdto = stekkerConfig.mdto
  }) {
    this.bron = controleerBron(bron);
    this.selectieService = selectieService;
    this.vernietigingRepository = vernietigingRepository;
    this.journaalRepository = journaalRepository;
    this.clock = clock;
    this.processingDelayMs = processingDelayMs;
    this.maxPogingen = Math.max(1, maxPogingen);
    this.wachttijdPogingMs = wachttijdPogingMs;
    this.idempotentie = new Idempotentie(idempotencyRepository);
    this.scenario = scenario;
    this.mdto = mdto;
    this.lopendeVerwerkingen = new Map();
    this.selectieLocks = new Map();
  }

  startVernietiging({
    selectieId,
    cockpitTaakId,
    besluitReferentie,
    vernietigingsdossierId
  }, { idempotencyKey } = {}) {
    const idempotentie = this.idempotentie.controleer('POST /vernietigingen', idempotencyKey, {
      selectieId,
      cockpitTaakId,
      besluitReferentie,
      vernietigingsdossierId
    });

    if (idempotentie.registratie) {
      return this.mustGetVernietiging(idempotentie.registratie.vernietigingId);
    }

    const selectie = this.selectieService.getSelectie(selectieId);

    if (!selectie) {
      throw new ResourceNotFoundError('SELECTIE_NOT_FOUND', 'Selectie niet gevonden.');
    }

    if (selectie.status !== SelectieStatus.READY) {
      throw new ConflictError('SELECTIE_NOT_READY', `Selectie ${selectieId} is nog niet gereed.`);
    }

    if (!cockpitTaakId || !besluitReferentie) {
      throw new ValidationError('cockpitTaakId en besluitReferentie zijn verplicht.');
    }

    const starttijd = this.clock().toISOString();
    const vernietiging = {
      vernietigingId: makeVernietigingId(),
      selectieId,
      cockpitTaakId,
      besluitReferentie,
      vernietigingsdossierId,
      status: VernietigingStatus.IDLE,
      starttijd,
      eindtijd: undefined,
      totaalKandidaten: 0,
      totaalObjecten: 0,
      totaalBatches: 0,
      ontvangenBatches: 0,
      succesvolVernietigd: 0,
      mislukt: 0,
      overgeslagen: 0,
      gewijzigd: 0,
      nietGevonden: 0,
      stekkerNaam: stekkerConfig.naam,
      stekkerOmschrijving: stekkerConfig.omschrijving,
      stekkerversie: stekkerConfig.versie,
      configuratieversie: stekkerConfig.configuratieversie,
      aantalWaarschuwingen: 0,
      aantalFouten: 0,
      batches: [],
      resultaten: []
    };

    this.vernietigingRepository.save(vernietiging);
    this.idempotentie.registreer(idempotentie, { vernietigingId: vernietiging.vernietigingId });
    return vernietiging;
  }

  getVernietiging(vernietigingId) {
    return this.vernietigingRepository.findById(vernietigingId);
  }

  voegBatchToe(vernietigingId, { batchNummer, vernietigingskandidaten }, { idempotencyKey } = {}) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);
    const idempotentie = this.idempotentie.controleer(`POST /vernietigingen/${vernietigingId}/batches`, idempotencyKey, {
      batchNummer,
      vernietigingskandidaten: Array.isArray(vernietigingskandidaten)
        ? vernietigingskandidaten.map((kandidaat) => ({
            vernietigingskandidaatId: kandidaat?.vernietigingskandidaatId,
            identificatie: kandidaat?.identificatie
          }))
        : vernietigingskandidaten
    });

    // Een herhaling mag ook na vrijgeven: de cockpit kan na een crash niet weten of de batch al binnen was.
    if (idempotentie.registratie) {
      return this.toBatchResultaat(vernietiging, idempotentie.registratie.batchNummer);
    }

    if (vernietiging.status !== VernietigingStatus.IDLE) {
      throw new ConflictError('VERNIETIGING_NOT_IDLE', 'Batches kunnen alleen worden toegevoegd zolang de vernietiging IDLE is.');
    }

    if (!Number.isInteger(batchNummer) || batchNummer < 1) {
      throw new ValidationError('batchNummer moet een positief geheel getal zijn.');
    }

    if (!Array.isArray(vernietigingskandidaten) || vernietigingskandidaten.length === 0) {
      throw new ValidationError('vernietigingskandidaten moet minimaal een kandidaat bevatten.');
    }

    // Intern blijft per object de technische sleutel (bronId) bewaard, afgeleid uit de identificatie.
    const normalizedBatch = {
      batchNummer,
      ontvangenTijdstip: this.clock().toISOString(),
      objecten: vernietigingskandidaten.map((kandidaat) => ({
        vernietigingskandidaatId: kandidaat?.vernietigingskandidaatId,
        identificatie: kandidaat?.identificatie,
        bronId: technischeSleutel(kandidaat?.identificatie, this.mdto)
      }))
    };

    const existingBatch = vernietiging.batches.find((batch) => batch.batchNummer === batchNummer);

    if (existingBatch) {
      if (canoniekeJson(existingBatch.objecten) !== canoniekeJson(normalizedBatch.objecten)) {
        throw new ConflictError('BATCH_CONFLICT', 'BatchNummer bestaat al met een afwijkende inhoud.');
      }

      return this.toBatchResultaat(vernietiging, batchNummer);
    }

    this.valideerObjecten(vernietiging, normalizedBatch.objecten);

    vernietiging.batches.push(normalizedBatch);
    vernietiging.ontvangenBatches = vernietiging.batches.length;
    vernietiging.totaalKandidaten = vernietiging.batches.reduce((total, batch) => total + batch.objecten.length, 0);
    vernietiging.totaalObjecten = this.telObjecten(vernietiging);

    this.vernietigingRepository.save(vernietiging);
    this.idempotentie.registreer(idempotentie, { vernietigingId, batchNummer });
    return this.toBatchResultaat(vernietiging, batchNummer);
  }

  // Een batch wordt alleen geaccepteerd als elke kandidaat uit de selectie komt, met
  // precies de identificatie die de stekker voor die kandidaat heeft geleverd.
  valideerObjecten(vernietiging, objecten) {
    const selectie = this.selectieService.getSelectie(vernietiging.selectieId);
    const kandidaatById = new Map(
      (selectie?.kandidaten ?? []).map((kandidaat) => [kandidaat.vernietigingskandidaatId, kandidaat])
    );
    const inDezeBatch = new Set();
    const alAangeleverd = new Map(
      vernietiging.batches.flatMap((batch) => batch.objecten.map((object) => [object.vernietigingskandidaatId, batch.batchNummer]))
    );

    for (const { vernietigingskandidaatId, identificatie } of objecten) {
      if (typeof vernietigingskandidaatId !== 'string' || !vernietigingskandidaatId
        || !Array.isArray(identificatie) || identificatie.length === 0) {
        throw new ValidationError('Elke kandidaat moet een vernietigingskandidaatId en een identificatie bevatten.');
      }

      if (inDezeBatch.has(vernietigingskandidaatId)) {
        throw new ValidationError(`Kandidaat ${vernietigingskandidaatId} komt meer dan eens voor in deze batch.`);
      }

      inDezeBatch.add(vernietigingskandidaatId);
      const kandidaat = kandidaatById.get(vernietigingskandidaatId);

      if (!kandidaat) {
        throw new ValidationError(`Kandidaat ${vernietigingskandidaatId} komt niet voor in selectie ${vernietiging.selectieId}.`);
      }

      if (canoniekeJson(kandidaat.identificatie) !== canoniekeJson(identificatie)) {
        throw new ValidationError(`identificatie hoort niet bij kandidaat ${vernietigingskandidaatId}.`);
      }

      if (alAangeleverd.has(vernietigingskandidaatId)) {
        throw new ConflictError(
          'KANDIDAAT_AL_AANGELEVERD',
          `Kandidaat ${vernietigingskandidaatId} is al aangeleverd in batch ${alAangeleverd.get(vernietigingskandidaatId)}.`
        );
      }
    }
  }

  telObjecten(vernietiging) {
    const selectie = this.selectieService.getSelectie(vernietiging.selectieId);
    const aantalObjectenPerKandidaat = new Map(
      (selectie?.kandidaten ?? []).map((kandidaat) => [kandidaat.vernietigingskandidaatId, kandidaat.aantalObjecten])
    );

    return vernietiging.batches
      .flatMap((batch) => batch.objecten)
      .reduce((total, object) => total + (aantalObjectenPerKandidaat.get(object.vernietigingskandidaatId) ?? 0), 0);
  }

  async vrijgeven(vernietigingId, { aantalBatches, aantalKandidaten }, { idempotencyKey } = {}) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);
    const idempotentie = this.idempotentie.controleer(`POST /vernietigingen/${vernietigingId}/vrijgeven`, idempotencyKey, {
      aantalBatches,
      aantalKandidaten
    });

    if (idempotentie.registratie) {
      return vernietiging;
    }

    if (vernietiging.status === VernietigingStatus.COMPLETED || vernietiging.status === VernietigingStatus.PARTIAL) {
      return vernietiging;
    }

    if (vernietiging.status !== VernietigingStatus.IDLE) {
      throw new ConflictError('VERNIETIGING_NOT_IDLE', 'Vernietiging kan alleen worden vrijgegeven vanuit IDLE.');
    }

    if (aantalBatches !== vernietiging.batches.length || aantalKandidaten !== vernietiging.totaalKandidaten) {
      throw new ConflictError('AANTALLEN_CONFLICT', 'Aangeleverde aantallen komen niet overeen met ontvangen batches.');
    }

    // De wijze van vernietiging is verplicht vanaf RUNNING (ADR-0005, B-M4).
    const running = this.vernietigingRepository.save({
      ...vernietiging,
      status: VernietigingStatus.RUNNING,
      totaalBatches: aantalBatches,
      vernietigingsmethode: begrip(this.mdto.vernietigingsmethode, Begrippenlijst.vernietigingsmethoden),
      vernietigingsmethodeToelichting: this.mdto.vernietigingsmethodeToelichting
    });
    this.idempotentie.registreer(idempotentie, { vernietigingId });

    // Met vertraging 0 verwerkt de stekker synchroon (bedoeld voor unittests).
    if (this.processingDelayMs <= 0) {
      return this.verwerkVernietiging(vernietigingId);
    }

    this.startAsynchroneVerwerking(vernietigingId);
    return running;
  }

  startAsynchroneVerwerking(vernietigingId) {
    const verwerking = this.verwerkVernietiging(vernietigingId)
      .catch(() => undefined)
      .finally(() => this.lopendeVerwerkingen.delete(vernietigingId));
    this.lopendeVerwerkingen.set(vernietigingId, verwerking);
    return verwerking;
  }

  // Na een herstart van de stekker: vernietigingen die RUNNING waren, gaan verder
  // met de batches die nog geen resultaat hebben.
  hervatOnderbrokenVerwerkingen() {
    const onderbroken = this.vernietigingRepository.findAll()
      .filter((vernietiging) => vernietiging.status === VernietigingStatus.RUNNING);

    for (const { vernietigingId } of onderbroken) {
      this.startAsynchroneVerwerking(vernietigingId);
    }

    return onderbroken.map(({ vernietigingId }) => vernietigingId);
  }

  // Wacht tot een lopende asynchrone verwerking klaar is (voor tests en nette afsluiting).
  async wachtOpVerwerking(vernietigingId) {
    await this.lopendeVerwerkingen.get(vernietigingId);
    return this.getVernietiging(vernietigingId);
  }

  // Verwerkt de batches één voor één, in volgorde van batchnummer. Na elke batch
  // worden resultaten en tellingen opgeslagen, zodat de voortgang zichtbaar is.
  async verwerkVernietiging(vernietigingId) {
    const huidig = this.mustGetVernietiging(vernietigingId);
    const alVerwerkt = new Set(huidig.resultaten.map((resultaat) => resultaat.batchNummer));
    const batchNummers = huidig.batches
      .map((batch) => batch.batchNummer)
      .filter((batchNummer) => !alVerwerkt.has(batchNummer))
      .sort((a, b) => a - b);

    try {
      for (const batchNummer of batchNummers) {
        if (this.processingDelayMs > 0) {
          await sleep(this.processingDelayMs);
        }

        await this.verwerkBatch(vernietigingId, batchNummer);
      }
    } catch (error) {
      const mislukt = this.mustGetVernietiging(vernietigingId);
      this.vernietigingRepository.save({
        ...mislukt,
        status: VernietigingStatus.FAILED,
        eindtijd: this.clock().toISOString(),
        aantalFouten: mislukt.aantalFouten + 1
      });
      throw error;
    }

    const vernietiging = this.mustGetVernietiging(vernietigingId);
    const allesSucces = vernietiging.resultaten.every((resultaat) => resultaat.resultaat === Uitvoeringsresultaat.SUCCESS);

    return this.vernietigingRepository.save({
      ...vernietiging,
      // FAILED blijft gereserveerd voor een uitvoering die als geheel niet betrouwbaar kan afronden.
      status: allesSucces ? VernietigingStatus.COMPLETED : VernietigingStatus.PARTIAL,
      eindtijd: this.clock().toISOString()
    });
  }

  async verwerkBatch(vernietigingId, batchNummer) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);
    const selectie = this.selectieService.getSelectie(vernietiging.selectieId);

    if (!selectie) {
      throw new ResourceNotFoundError('SELECTIE_NOT_FOUND', 'Selectie niet gevonden.');
    }

    const batch = vernietiging.batches.find((kandidaatBatch) => kandidaatBatch.batchNummer === batchNummer);
    const kandidaatById = new Map(selectie.kandidaten.map((kandidaat) => [kandidaat.vernietigingskandidaatId, kandidaat]));

    // Twee vernietigingen op dezelfde selectie verwerken nooit tegelijk dezelfde zaken.
    const batchResultaten = await this.metSelectieLock(selectie.selectieId, async () => {
      const resultaatPerKandidaat = new Map();
      // De bron mag de volgorde binnen de batch bepalen (bijv. deelzaken vóór hoofdzaken);
      // de resultaten blijven in de volgorde van de batch.
      const kandidaten = batch.objecten.map((object) => kandidaatById.get(object.vernietigingskandidaatId)).filter(Boolean);
      const volgorde = new Map((this.bron.volgorde?.(kandidaten) ?? kandidaten).map((kandidaat, index) => [kandidaat.vernietigingskandidaatId, index]));
      const objecten = [...batch.objecten].sort((a, b) => (volgorde.get(a.vernietigingskandidaatId) ?? -1) - (volgorde.get(b.vernietigingskandidaatId) ?? -1));

      // Kandidaat voor kandidaat: elke kandidaat is een reeks aanroepen naar de bron.
      for (const object of objecten) {
        resultaatPerKandidaat.set(object, await this.verwerkKandidaat({
          vernietiging,
          batchNummer,
          object,
          kandidaat: kandidaatById.get(object.vernietigingskandidaatId)
        }));
      }

      return batch.objecten.map((object) => resultaatPerKandidaat.get(object));
    });

    const bijgewerkt = this.mustGetVernietiging(vernietigingId);
    const resultaten = [...bijgewerkt.resultaten, ...batchResultaten];

    return this.vernietigingRepository.save({ ...bijgewerkt, resultaten, ...telResultaten(resultaten) });
  }

  // Bepaalt en voert uit wat er met één aangeboden kandidaat gebeurt. Het journaal van deze
  // vernietiging en kandidaat bepaalt of dit een eerste poging is of een hervatting.
  async verwerkKandidaat({ vernietiging, batchNummer, object, kandidaat }) {
    const correlatieId = `${vernietiging.vernietigingId}-${batchNummer}-${object.vernietigingskandidaatId}`;
    const basis = {
      vernietigingskandidaatId: object.vernietigingskandidaatId,
      identificatie: object.identificatie,
      batchNummer,
      logReference: `log-${correlatieId}`,
      correlatieId
    };
    const zonderVernietiging = (velden) => ({ ...basis, ...velden });

    if (!kandidaat) {
      return zonderVernietiging({
        resultaat: Uitvoeringsresultaat.NOT_FOUND,
        foutcode: 'NOT_FOUND',
        foutmelding: 'Kandidaat komt niet voor in de selectie.',
        bronstatus: 'ONTBREEKT'
      });
    }

    // Vangnet naast de controle bij aanlevering: vernietig nooit een bronobject
    // dat niet bij de aangeboden kandidaat hoort.
    if (kandidaat.bronId !== object.bronId) {
      return zonderVernietiging({
        resultaat: Uitvoeringsresultaat.FAILED,
        foutcode: 'BRONID_MISMATCH',
        foutmelding: 'Technische sleutel hoort niet bij de vernietigingskandidaat; er is niets vernietigd.',
        bronstatus: 'ONVERANDERD'
      });
    }

    const journaal = this.journaalRepository.voor(vernietiging.vernietigingId, kandidaat.vernietigingskandidaatId);
    const regels = await journaal.lees();
    const klaar = regels.find((regel) => regel.stap === 'klaar');

    // Hervatting: deze kandidaat is al volledig door déze vernietiging vernietigd.
    if (klaar) {
      return this.vernietigd(basis, klaar);
    }

    // Alleen als er nog niets is gebeurd: is de kandidaat nog zoals bij selectie (ADR-0007, DR-04)?
    // Na een gedeeltelijke vernietiging zou de bron zijn eigen verwijderingen als wijziging zien.
    if (regels.length === 0) {
      let afwijking;

      try {
        afwijking = await this.metPogingen(() => this.bron.controleer(kandidaat));
      } catch (error) {
        return zonderVernietiging({
          resultaat: Uitvoeringsresultaat.FAILED,
          foutcode: 'CONTROLE_MISLUKT',
          foutmelding: `Controle in de bron mislukt; er is niets vernietigd. ${error.message}`,
          bronstatus: 'ONBEKEND'
        });
      }

      if (afwijking) {
        return zonderVernietiging(afwijking);
      }

      // Testscenario: een vast deel van de kandidaten krijgt een afwijkend resultaat; de bron
      // blijft dan ongewijzigd.
      const afwijkend = scenarioResultaat(this.scenario, object.vernietigingskandidaatId);

      if (afwijkend) {
        return zonderVernietiging({
          resultaat: afwijkend,
          foutcode: `SCENARIO_${afwijkend}`,
          foutmelding: `Resultaat ${afwijkend} gesimuleerd via scenario-configuratie.`,
          bronstatus: 'ONVERANDERD'
        });
      }
    }

    try {
      const uitkomst = await this.metPogingen(() => this.bron.vernietig(kandidaat, { journaal, clock: this.clock }));
      const afgerond = { stap: 'klaar', eventTijd: uitkomst.eventTijd, onderdeelUitkomsten: uitkomst.onderdeelUitkomsten ?? [] };
      await journaal.schrijf(afgerond);
      return this.vernietigd(basis, afgerond);
    } catch (error) {
      // B-OZ3: na alle pogingen niet klaar. Is er in de bron al iets veranderd (een koppeling,
      // document of besluit weg), dan is de kandidaat deels vernietigd.
      const regels = await journaal.lees();
      const gedaan = regels.filter((regel) => regel.identificatieKenmerk && regel.uitkomst);

      return zonderVernietiging(regels.some((regel) => regel.wijziging)
        ? {
            resultaat: Uitvoeringsresultaat.FAILED,
            foutcode: 'DEELS_VERNIETIGD',
            foutmelding: `Vernietiging niet afgerond na ${this.maxPogingen} poging(en); het object bestaat nog. Al vernietigd of ontkoppeld: ${gedaan.length} van ${kandidaat.aantalObjecten ?? '?'} onderdelen. ${error.message}`,
            bronstatus: 'DEELS_VERNIETIGD',
            onderdeelUitkomsten: gedaan.map(({ identificatieKenmerk, uitkomst }) => ({ identificatieKenmerk, uitkomst }))
          }
        : {
            resultaat: Uitvoeringsresultaat.FAILED,
            foutcode: 'VERNIETIGING_MISLUKT',
            foutmelding: `Vernietiging mislukt na ${this.maxPogingen} poging(en); er is niets vernietigd. ${error.message}`,
            bronstatus: 'ONVERANDERD'
          });
    }
  }

  // MDTO-event Vernietigen met het tijdstip van vernietiging (Archiefbesluit art. 8).
  vernietigd(basis, { eventTijd, onderdeelUitkomsten }) {
    return {
      ...basis,
      resultaat: Uitvoeringsresultaat.SUCCESS,
      event: {
        eventType: begrip('Vernietigen', Begrippenlijst.eventtypen),
        eventTijd,
        eventResultaat: `Vernietigd; methode: ${this.mdto.vernietigingsmethode}.`
      },
      bronstatus: 'VERNIETIGD',
      onderdeelUitkomsten
    };
  }

  // Probeert een aanroep naar de bron tot maxPogingen keer, met oplopende wachttijd.
  async metPogingen(aanroep) {
    let laatsteFout;

    for (let poging = 1; poging <= this.maxPogingen; poging += 1) {
      try {
        return await aanroep();
      } catch (error) {
        laatsteFout = error;

        if (poging < this.maxPogingen && this.wachttijdPogingMs > 0) {
          await sleep(this.wachttijdPogingMs * 2 ** (poging - 1));
        }
      }
    }

    throw laatsteFout;
  }

  async metSelectieLock(selectieId, werk) {
    const vorige = this.selectieLocks.get(selectieId) ?? Promise.resolve();
    const huidige = vorige.catch(() => undefined).then(werk);
    const opgeruimd = huidige.catch(() => undefined).finally(() => {
      if (this.selectieLocks.get(selectieId) === opgeruimd) {
        this.selectieLocks.delete(selectieId);
      }
    });
    this.selectieLocks.set(selectieId, opgeruimd);
    return huidige;
  }

  getBatchResultaten(vernietigingId) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);

    return vernietiging.batches
      .map((batch) => batch.batchNummer)
      .sort((a, b) => a - b)
      .map((batchNummer) => this.toBatchResultaat(vernietiging, batchNummer));
  }

  getBatchResultaat(vernietigingId, batchNummer) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);

    if (!vernietiging.batches.some((batch) => batch.batchNummer === batchNummer)) {
      throw new ResourceNotFoundError('BATCH_NOT_FOUND', `Batch ${batchNummer} niet gevonden.`);
    }

    return this.toBatchResultaat(vernietiging, batchNummer);
  }

  // Zolang een batch niet is verwerkt, is de lijst met resultaten leeg.
  toBatchResultaat(vernietiging, batchNummer) {
    return {
      batchNummer,
      resultaten: vernietiging.resultaten.filter((resultaat) => resultaat.batchNummer === batchNummer)
    };
  }

  // MDTO-XML-specificatie van een vernietigde kandidaat (ADR-0005, B-M2). Alleen bij SUCCESS.
  getSpecificatie(vernietigingId, vernietigingskandidaatId) {
    const vernietiging = this.mustGetVernietiging(vernietigingId);
    const aangeboden = vernietiging.batches
      .flatMap((batch) => batch.objecten)
      .some((object) => object.vernietigingskandidaatId === vernietigingskandidaatId);

    if (!aangeboden) {
      throw new ResourceNotFoundError(
        'KANDIDAAT_NOT_FOUND',
        `Kandidaat ${vernietigingskandidaatId} is niet aangeboden in vernietiging ${vernietigingId}.`
      );
    }

    const resultaat = vernietiging.resultaten.find((item) => item.vernietigingskandidaatId === vernietigingskandidaatId);

    if (resultaat?.resultaat !== Uitvoeringsresultaat.SUCCESS) {
      throw new ConflictError(
        'SPECIFICATIE_NIET_BESCHIKBAAR',
        `Er is geen specificatie: kandidaat ${vernietigingskandidaatId} heeft resultaat ${resultaat?.resultaat ?? 'nog geen'}.`
      );
    }

    const kandidaat = this.selectieService.getSelectie(vernietiging.selectieId)?.kandidaten
      .find((item) => item.vernietigingskandidaatId === vernietigingskandidaatId);

    return maakSpecificatieXml({
      kandidaat,
      event: resultaat.event,
      onderdeelUitkomsten: resultaat.onderdeelUitkomsten,
      archiefvormer: this.mdto.archiefvormer,
      vernietigingsmethodeToelichting: vernietiging.vernietigingsmethodeToelichting
    });
  }

  mustGetVernietiging(vernietigingId) {
    const vernietiging = this.getVernietiging(vernietigingId);

    if (!vernietiging) {
      throw new ResourceNotFoundError('VERNIETIGING_NOT_FOUND', 'Vernietiging niet gevonden.');
    }

    return vernietiging;
  }
}

function telResultaten(resultaten) {
  const aantal = (waarde) => resultaten.filter((resultaat) => resultaat.resultaat === waarde).length;

  return {
    succesvolVernietigd: aantal(Uitvoeringsresultaat.SUCCESS),
    mislukt: aantal(Uitvoeringsresultaat.FAILED),
    overgeslagen: aantal(Uitvoeringsresultaat.SKIPPED),
    gewijzigd: aantal(Uitvoeringsresultaat.CHANGED),
    nietGevonden: aantal(Uitvoeringsresultaat.NOT_FOUND)
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeVernietigingId() {
  return `vern-${crypto.randomBytes(6).toString('hex')}`;
}
