import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { FileIdempotencyRepository } from '../src/infrastructure/repositories/file-idempotency-repository.js';
import { FileJournaalRepository } from '../src/infrastructure/repositories/file-journaal-repository.js';
import { FileSelectieRepository } from '../src/infrastructure/repositories/file-selectie-repository.js';
import { FileVernietigingRepository } from '../src/infrastructure/repositories/file-vernietiging-repository.js';
import { JsonFileStore } from '../src/infrastructure/repositories/json-file-store.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';

function tijdelijkeRuntime(t) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'stekker-runtime-'));
  t.after(() => fs.rmSync(map, { recursive: true, force: true }));
  return map;
}

// Een 'stekkerproces': services met bestandsopslag op een gedeelde runtime-map. Een tweede
// aanroep op dezelfde map simuleert een herstart; de bron (Open Zaak) blijft dezelfde.
function startStekker(runtime, bron, { vernietigingRepository, processingDelayMs = 0, selectieDelayMs = 0 } = {}) {
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new FileSelectieRepository(path.join(runtime, 'selecties')),
    processingDelayMs: selectieDelayMs
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: vernietigingRepository ?? new FileVernietigingRepository(path.join(runtime, 'vernietigingen')),
    journaalRepository: new FileJournaalRepository(path.join(runtime, 'journaal')),
    idempotencyRepository: new FileIdempotencyRepository(path.join(runtime, 'idempotency')),
    processingDelayMs,
    wachttijdPogingMs: 0
  });
  return { selectieService, vernietigingService };
}

function objectenVan(selectie, van, tot) {
  return selectie.kandidaten.slice(van, tot).map(({ vernietigingskandidaatId, identificatie }) => ({ vernietigingskandidaatId, identificatie }));
}

test('JsonFileStore schrijft atomisch en weigert id\'s die buiten de map kunnen wijzen', (t) => {
  const runtime = tijdelijkeRuntime(t);
  const store = new JsonFileStore(path.join(runtime, 'store'));

  store.save('vern-abc', { vernietigingId: 'vern-abc', status: 'IDLE' });
  assert.deepEqual(store.findById('vern-abc'), { vernietigingId: 'vern-abc', status: 'IDLE' });
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'store')), ['vern-abc.json']);

  for (const id of ['../geheim', '..', 'a/b', 'a\\b', '', 'x'.repeat(201)]) {
    assert.equal(store.findById(id), undefined, `id ${JSON.stringify(id)}`);
    assert.throws(() => store.save(id, {}), /Ongeldig id/);
  }
});

test('selecties, vernietigingen en idempotency-keys overleven een herstart', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const bron = new GeheugenBron();
  const eerste = startStekker(runtime, bron);
  const selectie = await eerste.selectieService.startSelectie({ peildatum: '2026-09-25' });
  const verzoek = { selectieId: selectie.selectieId, cockpitTaakId: 'taak-p', besluitReferentie: 'besluit-p' };
  const vernietiging = eerste.vernietigingService.startVernietiging(verzoek, { idempotencyKey: 'taak-p:vernietiging' });
  eerste.vernietigingService.voegBatchToe(vernietiging.vernietigingId, { batchNummer: 1, vernietigingskandidaten: objectenVan(selectie, 0, 2) });

  const herstart = startStekker(runtime, bron);
  const herladen = herstart.selectieService.getSelectie(selectie.selectieId);

  assert.equal(herladen.status, 'READY');
  assert.deepEqual(herladen.kandidaten[0].momentopname, selectie.kandidaten[0].momentopname, 'de momentopname staat op het volume');
  assert.equal(herstart.vernietigingService.getVernietiging(vernietiging.vernietigingId).totaalKandidaten, 2);
  assert.equal(
    herstart.vernietigingService.startVernietiging(verzoek, { idempotencyKey: 'taak-p:vernietiging' }).vernietigingId,
    vernietiging.vernietigingId
  );
});

test('een onderbroken selectie wordt na herstart afgerond', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const bron = new GeheugenBron();
  // Lange vertraging: het eerste 'proces' rondt de selectie niet af voordat het 'stopt'.
  const eerste = startStekker(runtime, bron, { selectieDelayMs: 60000 });
  const selectie = await eerste.selectieService.startSelectie({ peildatum: '2026-09-25' });
  assert.equal(selectie.status, 'RUNNING');

  const herstart = startStekker(runtime, bron);
  const hervat = await herstart.selectieService.hervatOnderbrokenSelecties();

  assert.deepEqual(hervat, [selectie.selectieId]);
  assert.equal(herstart.selectieService.getSelectie(selectie.selectieId).status, 'READY');
});

test('een onderbroken vernietiging wordt hervat zonder batches dubbel te verwerken', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const bron = new GeheugenBron();
  const eerste = startStekker(runtime, bron);
  const selectie = await eerste.selectieService.startSelectie({ peildatum: '2026-09-25' });
  const { vernietigingId } = eerste.vernietigingService.startVernietiging({
    selectieId: selectie.selectieId,
    cockpitTaakId: 'taak-h',
    besluitReferentie: 'besluit-h'
  });
  [objectenVan(selectie, 0, 2), objectenVan(selectie, 2, 4), objectenVan(selectie, 4, 5)].forEach((objecten, index) => {
    eerste.vernietigingService.voegBatchToe(vernietigingId, { batchNummer: index + 1, vernietigingskandidaten: objecten });
  });

  // Situatie bij een crash: vrijgegeven (RUNNING) en alleen batch 1 verwerkt.
  const repository = new FileVernietigingRepository(path.join(runtime, 'vernietigingen'));
  repository.save({ ...repository.findById(vernietigingId), status: 'RUNNING', totaalBatches: 3 });
  await eerste.vernietigingService.verwerkBatch(vernietigingId, 1);

  const herstart = startStekker(runtime, bron, { processingDelayMs: 5 });
  assert.deepEqual(herstart.vernietigingService.hervatOnderbrokenVerwerkingen(), [vernietigingId]);
  const afgerond = await herstart.vernietigingService.wachtOpVerwerking(vernietigingId);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(afgerond.succesvolVernietigd, 5);
  assert.deepEqual(afgerond.resultaten.map((resultaat) => resultaat.batchNummer), [1, 1, 2, 2, 3]);
  assert.equal(bron.aanroepen.vernietig, 5);
});

test('crash tussen journaal en resultaten: hervatting meldt SUCCESS met het oorspronkelijke tijdstip', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const bron = new GeheugenBron();
  const echteRepository = new FileVernietigingRepository(path.join(runtime, 'vernietigingen'));
  let crashBijVolgendeResultaten = false;
  // Repository die 'crasht' op het moment dat de resultaten van een batch worden opgeslagen,
  // dus nádat de zaken al zijn verwijderd en het journaal is bijgewerkt.
  const crashendeRepository = {
    findById: (id) => echteRepository.findById(id),
    findAll: () => echteRepository.findAll(),
    save(vernietiging) {
      if (crashBijVolgendeResultaten && vernietiging.resultaten.length > 0) {
        throw new Error('proces gestopt');
      }
      return echteRepository.save(vernietiging);
    }
  };
  const eerste = startStekker(runtime, bron, { vernietigingRepository: crashendeRepository });
  const selectie = await eerste.selectieService.startSelectie({ peildatum: '2026-09-25' });
  const objecten = objectenVan(selectie, 0, 3);
  const { vernietigingId } = eerste.vernietigingService.startVernietiging({
    selectieId: selectie.selectieId,
    cockpitTaakId: 'taak-c',
    besluitReferentie: 'besluit-c'
  });
  eerste.vernietigingService.voegBatchToe(vernietigingId, { batchNummer: 1, vernietigingskandidaten: objecten });
  echteRepository.save({ ...echteRepository.findById(vernietigingId), status: 'RUNNING', totaalBatches: 1 });

  crashBijVolgendeResultaten = true;
  await assert.rejects(eerste.vernietigingService.verwerkBatch(vernietigingId, 1), /proces gestopt/);
  assert.equal(selectie.kandidaten.slice(0, 3).every((kandidaat) => bron.zaak(kandidaat.bronId).verwijderd), true);
  assert.equal(echteRepository.findById(vernietigingId).resultaten.length, 0);

  const herstart = startStekker(runtime, bron, { processingDelayMs: 5 });
  herstart.vernietigingService.hervatOnderbrokenVerwerkingen();
  const afgerond = await herstart.vernietigingService.wachtOpVerwerking(vernietigingId);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(afgerond.succesvolVernietigd, 3);
  assert.equal(afgerond.nietGevonden, 0);
  assert.equal(bron.aanroepen.vernietig, 3, 'de bron wordt niet opnieuw aangeroepen');
});

test('journaal: een half geschreven laatste regel na een crash kost geen geldige regels', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const repository = new FileJournaalRepository(path.join(runtime, 'journaal'));
  const journaal = repository.voor('vern-a', 'vk-ZAAK-1');

  await journaal.schrijf({ identificatieKenmerk: 'D1', uitkomst: 'vernietigd' });
  const [bestand] = fs.readdirSync(path.join(runtime, 'journaal', 'vern-a'));
  // Crash midden in het schrijven: regel zonder afsluitend regeleinde.
  fs.appendFileSync(path.join(runtime, 'journaal', 'vern-a', bestand), '{"identificatieKenmerk":"D2","uit');
  await journaal.schrijf({ identificatieKenmerk: 'D3', uitkomst: 'ontkoppeld' });

  assert.deepEqual(await journaal.lees(), [
    { identificatieKenmerk: 'D1', uitkomst: 'vernietigd' },
    { identificatieKenmerk: 'D3', uitkomst: 'ontkoppeld' }
  ]);
  assert.deepEqual(await repository.voor('vern-a', 'vk-ander').lees(), []);
  assert.throws(() => repository.voor('../geheim', 'vk-1'), /Ongeldig id/);
});

test('na een herstart geeft een nieuwe vernietiging van een al vernietigde zaak NOT_FOUND', async (t) => {
  const runtime = tijdelijkeRuntime(t);
  const bron = new GeheugenBron();
  const eerste = startStekker(runtime, bron);
  const selectie = await eerste.selectieService.startSelectie({ peildatum: '2026-09-25' });
  const objecten = objectenVan(selectie, 0, 1);
  const verzoek = { selectieId: selectie.selectieId, cockpitTaakId: 'taak-l', besluitReferentie: 'besluit-l' };
  const eersteVernietiging = eerste.vernietigingService.startVernietiging(verzoek);
  eerste.vernietigingService.voegBatchToe(eersteVernietiging.vernietigingId, { batchNummer: 1, vernietigingskandidaten: objecten });
  assert.equal((await eerste.vernietigingService.vrijgeven(eersteVernietiging.vernietigingId, { aantalBatches: 1, aantalKandidaten: 1 })).status, 'COMPLETED');

  const herstart = startStekker(runtime, bron);
  const tweede = herstart.vernietigingService.startVernietiging(verzoek);
  herstart.vernietigingService.voegBatchToe(tweede.vernietigingId, { batchNummer: 1, vernietigingskandidaten: objecten });
  const afgerond = await herstart.vernietigingService.vrijgeven(tweede.vernietigingId, { aantalBatches: 1, aantalKandidaten: 1 });

  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(afgerond.nietGevonden, 1);
});
