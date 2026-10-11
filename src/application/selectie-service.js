import crypto from 'node:crypto';
import { GEEN_SCENARIO } from '../config/scenario-config.js';
import { stekkerConfig } from '../config/stekker-config.js';
import { SelectieStatus } from '../domain/status.js';
import { controleerBron } from './bron.js';
import { ValidationError } from './errors.js';
import { Idempotentie } from './idempotentie.js';
import { InMemoryIdempotencyRepository } from '../infrastructure/repositories/in-memory-idempotency-repository.js';

export class SelectieService {
  constructor({
    bron,
    selectieRepository,
    clock = () => new Date(),
    processingDelayMs = stekkerConfig.selectieProcessingDelayMs,
    scenario = stekkerConfig.scenario ?? GEEN_SCENARIO,
    idempotencyRepository = new InMemoryIdempotencyRepository()
  }) {
    this.bron = controleerBron(bron);
    this.selectieRepository = selectieRepository;
    this.clock = clock;
    this.processingDelayMs = processingDelayMs;
    this.scenario = scenario;
    this.idempotentie = new Idempotentie(idempotencyRepository);
    this.afgerondeSelecties = new Map();
  }

  async startSelectie({ peildatum } = {}, { idempotencyKey } = {}) {
    const selectietijdstip = this.clock().toISOString();
    const gekozenPeildatum = peildatum ?? stekkerConfig.defaultPeildatum ?? selectietijdstip.slice(0, 10);

    if (!isGeldigeDatum(gekozenPeildatum)) {
      throw new ValidationError('peildatum moet een geldige datum zijn in de vorm JJJJ-MM-DD.');
    }

    // De idempotentie kijkt naar het verzoek zoals het binnenkwam, niet naar de ingevulde standaard.
    const idempotentie = this.idempotentie.controleer('POST /selecties', idempotencyKey, { peildatum });

    if (idempotentie.registratie) {
      return this.getSelectie(idempotentie.registratie.selectieId);
    }

    const selectie = {
      selectieId: makeSelectieId(gekozenPeildatum),
      peildatum: gekozenPeildatum,
      selectietijdstip,
      status: SelectieStatus.RUNNING,
      totaalKandidaten: 0,
      totaalObjecten: 0,
      totaalBetrokkenen: 0,
      bronRecords: 0,
      stekkerNaam: stekkerConfig.naam,
      stekkerOmschrijving: stekkerConfig.omschrijving,
      stekkerversie: stekkerConfig.versie,
      configuratieversie: stekkerConfig.configuratieversie,
      apiVersie: stekkerConfig.apiVersie,
      aantalWaarschuwingen: 0,
      aantalFouten: 0,
      waarschuwingen: [],
      kandidaten: []
    };

    this.selectieRepository.save(selectie);
    this.idempotentie.registreer(idempotentie, { selectieId: selectie.selectieId });

    if (this.processingDelayMs <= 0) {
      return this.voltooiSelectie(selectie.selectieId);
    }

    // unref: de timer alleen houdt het proces niet in leven; in de stekker doet de
    // HTTP-server dat al, en een test hoeft niet op een openstaande selectie te wachten.
    setTimeout(() => {
      void this.voltooiSelectie(selectie.selectieId);
    }, this.processingDelayMs).unref();

    return selectie;
  }

  // Na een herstart van de stekker: selecties die nog RUNNING waren, opnieuw uitvoeren.
  // De bron wordt dan opnieuw bevraagd; de momentopname is die van het moment van afronden.
  async hervatOnderbrokenSelecties() {
    const onderbroken = this.selectieRepository.findAll()
      .filter((selectie) => selectie.status === SelectieStatus.RUNNING);

    await Promise.all(onderbroken.map(({ selectieId }) => this.voltooiSelectie(selectieId)));
    return onderbroken.map(({ selectieId }) => selectieId);
  }

  // Een fout tijdens het selecteren levert een selectie met status FAILED op,
  // niet een 500: de Cockpit ziet de fout via GET /selecties/{selectieId}.
  async voltooiSelectie(selectieId) {
    try {
      return await this.completeSelectie(selectieId);
    } catch (error) {
      const failedSelection = this.selectieRepository.findById(selectieId);

      if (!failedSelection) {
        return undefined;
      }

      return this.selectieRepository.save({
        ...failedSelection,
        status: SelectieStatus.FAILED,
        aantalFouten: 1,
        foutmelding: error.message
      });
    }
  }

  async completeSelectie(selectieId) {
    const selectie = this.getSelectie(selectieId);

    if (!selectie) {
      return undefined;
    }

    if (this.scenario.selectieFail) {
      throw new Error('Selectie mislukt (gesimuleerd via SCENARIO_SELECTIE_FAIL).');
    }

    const { bronRecords, kandidaten, waarschuwingen } = await this.bron.selecteer({
      peildatum: selectie.peildatum,
      leverNietV: this.scenario.leverNietV
    });

    return this.selectieRepository.save({
      ...selectie,
      gereedTijdstip: this.clock().toISOString(),
      status: SelectieStatus.READY,
      totaalKandidaten: kandidaten.length,
      totaalObjecten: kandidaten.reduce((total, kandidaat) => total + kandidaat.aantalObjecten, 0),
      totaalBetrokkenen: kandidaten.reduce((total, kandidaat) => total + kandidaat.aantalBetrokkenen, 0),
      bronRecords,
      aantalWaarschuwingen: waarschuwingen.length,
      aantalFouten: 0,
      waarschuwingen,
      kandidaten
    });
  }

  // Een selectie in eindstatus (READY of FAILED) verandert niet meer. Die wordt na de
  // eerste keer bevroren in het geheugen gehouden, zodat pagineren en batch-aanlevering
  // bij grote selecties niet steeds het hele bestand opnieuw inlezen.
  getSelectie(selectieId) {
    const gecachet = this.afgerondeSelecties.get(selectieId);

    if (gecachet) {
      return gecachet;
    }

    const selectie = this.selectieRepository.findById(selectieId);

    if (selectie && (selectie.status === SelectieStatus.READY || selectie.status === SelectieStatus.FAILED)) {
      const bevroren = diepBevriezen(selectie);
      this.afgerondeSelecties.set(selectieId, bevroren);
      return bevroren;
    }

    return selectie;
  }

  getKandidaten(selectieId, { offset = 0, limit = 100 } = {}) {
    const selectie = this.getSelectie(selectieId);

    if (!selectie) {
      return undefined;
    }

    if (selectie.status !== SelectieStatus.READY) {
      throw new SelectieNogNietGereedError(selectieId, selectie.status);
    }

    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));

    return {
      selectieId: selectie.selectieId,
      offset: safeOffset,
      limit: safeLimit,
      totaal: selectie.kandidaten.length,
      items: selectie.kandidaten.slice(safeOffset, safeOffset + safeLimit)
    };
  }
}

export class SelectieNogNietGereedError extends Error {
  constructor(selectieId, status) {
    super(`Selectie ${selectieId} is nog niet gereed; huidige status is ${status}.`);
    this.name = 'SelectieNogNietGereedError';
    this.selectieId = selectieId;
    this.status = status;
  }
}

function diepBevriezen(waarde) {
  if (waarde && typeof waarde === 'object' && !Object.isFrozen(waarde)) {
    Object.values(waarde).forEach(diepBevriezen);
    Object.freeze(waarde);
  }

  return waarde;
}

function isGeldigeDatum(waarde) {
  if (typeof waarde !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(waarde)) {
    return false;
  }

  const datum = new Date(`${waarde}T00:00:00Z`);
  return !Number.isNaN(datum.getTime()) && datum.toISOString().slice(0, 10) === waarde;
}

// Leesbaar prefix met de peildatum, plus een willekeurig deel zodat twee selecties
// in dezelfde milliseconde nooit hetzelfde id krijgen.
function makeSelectieId(peildatum) {
  return `sel-${peildatum.replaceAll('-', '')}-${crypto.randomBytes(6).toString('hex')}`;
}
