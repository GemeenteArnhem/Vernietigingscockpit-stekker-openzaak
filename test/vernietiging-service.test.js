import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectieService } from '../src/application/selectie-service.js';
import { VernietigingService } from '../src/application/vernietiging-service.js';
import { InMemoryJournaalRepository } from '../src/infrastructure/repositories/in-memory-journaal-repository.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { InMemoryVernietigingRepository } from '../src/infrastructure/repositories/in-memory-vernietiging-repository.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';

// Een selectie op een bron in het geheugen, met een vernietigingsservice die standaard
// synchroon verwerkt en niet wacht tussen herhaalpogingen.
async function maakContext({ processingDelayMs = 0, maxPogingen = 3, vernietigingRepository, journaalRepository } = {}) {
  const bron = new GeheugenBron();
  let tik = 0;
  // Oplopende klok, zodat tijdstippen en id's per aanroep verschillen.
  const clock = () => new Date(Date.UTC(2026, 8, 25, 15, 0, 0, tik++));
  const selectieService = new SelectieService({
    bron,
    selectieRepository: new InMemorySelectieRepository(),
    clock,
    processingDelayMs: 0
  });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: vernietigingRepository ?? new InMemoryVernietigingRepository(),
    journaalRepository: journaalRepository ?? new InMemoryJournaalRepository(),
    clock,
    processingDelayMs,
    maxPogingen,
    wachttijdPogingMs: 0
  });
  const selectie = await selectieService.startSelectie({ peildatum: '2026-09-25' });
  const kandidaat = (index) => selectie.kandidaten[index];
  const object = (index) => ({
    vernietigingskandidaatId: kandidaat(index).vernietigingskandidaatId,
    identificatie: kandidaat(index).identificatie
  });
  // Kandidaten met een bepaalde eigenschap, voor tests op gedeelde documenten en besluiten.
  const indexVan = (voorwaarde) => selectie.kandidaten.findIndex((item) => voorwaarde(item, bron.zaak(item.bronId)));
  const maakVernietiging = (batches) => {
    const vernietiging = vernietigingService.startVernietiging({
      selectieId: selectie.selectieId,
      cockpitTaakId: 'taak-test',
      besluitReferentie: 'besluit-test'
    });
    batches.forEach((objecten, index) => {
      vernietigingService.voegBatchToe(vernietiging.vernietigingId, { batchNummer: index + 1, vernietigingskandidaten: objecten });
    });
    return vernietiging.vernietigingId;
  };
  const vernietig = async (objecten) => {
    const id = maakVernietiging([objecten]);
    const afgerond = await vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: objecten.length });
    return processingDelayMs > 0 ? vernietigingService.wachtOpVerwerking(id) : afgerond;
  };

  return { bron, selectie, vernietigingService, kandidaat, object, indexVan, maakVernietiging, vernietig };
}

test('vernietigt vrijgegeven kandidaten: eerst de onderdelen, dan de zaak', async () => {
  const { bron, selectie, kandidaat, object, vernietig } = await maakContext();
  const afgerond = await vernietig([object(0), object(1), object(2)]);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(afgerond.succesvolVernietigd, 3);
  assert.equal(afgerond.totaalKandidaten, 3);
  assert.equal(afgerond.totaalObjecten, [0, 1, 2].reduce((som, index) => som + kandidaat(index).aantalObjecten, 0));

  for (const index of [0, 1, 2]) {
    const zaak = bron.zaak(kandidaat(index).bronId);
    assert.equal(zaak.verwijderd, true);
    assert.equal(zaak.onderdelen.length, 0);
  }

  assert.equal(bron.zaak(kandidaat(3).bronId).verwijderd, false, 'niet aangeboden kandidaten blijven staan');
  assert.equal(selectie.kandidaten.length, 129);
});

test('SUCCESS draagt het event Vernietigen met het tijdstip waarop de zaak is verwijderd', async () => {
  const { object, vernietig } = await maakContext();
  const afgerond = await vernietig([object(0)]);
  const [resultaat] = afgerond.resultaten;

  assert.equal(resultaat.resultaat, 'SUCCESS');
  assert.equal(resultaat.event.eventType.begripLabel, 'Vernietigen');
  assert.match(resultaat.event.eventTijd, /^2026-09-25T15:00:00\.\d{3}Z$/);
  assert.equal(resultaat.bronstatus, 'VERNIETIGD');
});

test('een zaak die al weg is geeft NOT_FOUND; er wordt niets meer aangeroepen', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext();
  bron.verwijderZaak(kandidaat(0).bronId);
  const afgerond = await vernietig([object(0)]);

  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(afgerond.nietGevonden, 1);
  assert.equal(afgerond.resultaten[0].foutcode, 'NOT_FOUND');
  assert.equal(bron.aanroepen.vernietig, 0);
});

test('tweede vernietiging van dezelfde kandidaat geeft NOT_FOUND', async () => {
  const { object, vernietig } = await maakContext();
  assert.equal((await vernietig([object(0)])).status, 'COMPLETED');

  const tweede = await vernietig([object(0)]);
  assert.equal(tweede.nietGevonden, 1);
  assert.equal(tweede.status, 'PARTIAL');
});

test('een document dat na de selectie is toegevoegd geeft CHANGED en er wordt niets vernietigd (DR-04)', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext();
  const voor = bron.zaak(kandidaat(0).bronId).onderdelen.length;
  bron.voegOnderdeelToe(kandidaat(0).bronId);
  const afgerond = await vernietig([object(0)]);

  assert.equal(afgerond.resultaten[0].resultaat, 'CHANGED');
  assert.equal(afgerond.resultaten[0].foutcode, 'ONDERDELEN_GEWIJZIGD');
  assert.match(afgerond.resultaten[0].foutmelding, /1 bijgekomen, 0 verdwenen/);
  assert.equal(bron.zaak(kandidaat(0).bronId).verwijderd, false);
  assert.equal(bron.zaak(kandidaat(0).bronId).onderdelen.length, voor + 1);
});

test('besluiten en besluitdocumenten worden als onderdeel vernietigd (B-OZ4)', async () => {
  const { bron, kandidaat, object, indexVan, vernietig } = await maakContext();
  const index = indexVan((_, zaak) => zaak.onderdelen.some((onderdeel) => onderdeel.soort === 'besluit'));
  const kenmerken = bron.zaak(kandidaat(index).bronId).onderdelen.map((onderdeel) => onderdeel.kenmerk);
  const afgerond = await vernietig([object(index)]);

  assert.ok(kenmerken.some((kenmerk) => kenmerk.endsWith('-B1')));
  assert.equal(kandidaat(index).aantalObjecten, kenmerken.length);
  assert.deepEqual(
    afgerond.resultaten[0].onderdeelUitkomsten,
    kenmerken.map((identificatieKenmerk) => ({ identificatieKenmerk, uitkomst: 'vernietigd' }))
  );
});

test('een gedeeld document wordt ontkoppeld; de kandidaat is SUCCESS en de specificatie meldt het (B-OZ2)', async () => {
  const { bron, kandidaat, object, indexVan, vernietigingService, maakVernietiging } = await maakContext();
  const index = indexVan((_, zaak) => zaak.onderdelen.some((onderdeel) => onderdeel.gedeeld));
  const gedeeld = bron.zaak(kandidaat(index).bronId).onderdelen.find((onderdeel) => onderdeel.gedeeld).kenmerk;
  const id = maakVernietiging([[object(index)]]);
  const afgerond = await vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: 1 });
  const [resultaat] = afgerond.resultaten;

  assert.equal(resultaat.resultaat, 'SUCCESS');
  assert.equal(resultaat.onderdeelUitkomsten.find((item) => item.identificatieKenmerk === gedeeld).uitkomst, 'ontkoppeld');

  const xml = vernietigingService.getSpecificatie(id, resultaat.vernietigingskandidaatId);
  assert.equal(xml.match(/<bevatOnderdeel>/g).length, kandidaat(index).aantalObjecten);
  assert.match(xml, new RegExp(`Ontkoppeld en niet vernietigd, blijft bestaan bij een ander object: ${gedeeld}\\.`));
});

test('een tijdelijke storing wordt opgevangen door een nieuwe poging', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext({ maxPogingen: 3 });
  bron.faalBij(kandidaat(0).bronId, 'zaak', 2);
  const afgerond = await vernietig([object(0)]);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(bron.aanroepen.vernietig, 3);
  assert.equal(bron.zaak(kandidaat(0).bronId).verwijderd, true);
});

test('lukt het verwijderen van de zaak niet, dan FAILED DEELS_VERNIETIGD met wat al weg is (B-OZ3)', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext({ maxPogingen: 3 });
  const kenmerken = bron.zaak(kandidaat(0).bronId).onderdelen.map((onderdeel) => onderdeel.kenmerk);
  bron.faalBij(kandidaat(0).bronId, 'zaak');
  const afgerond = await vernietig([object(0)]);
  const [resultaat] = afgerond.resultaten;

  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(resultaat.resultaat, 'FAILED');
  assert.equal(resultaat.foutcode, 'DEELS_VERNIETIGD');
  assert.equal(resultaat.bronstatus, 'DEELS_VERNIETIGD');
  assert.match(resultaat.foutmelding, /na 3 poging\(en\)/);
  assert.deepEqual(resultaat.onderdeelUitkomsten.map((item) => item.identificatieKenmerk), kenmerken);
  assert.equal(bron.zaak(kandidaat(0).bronId).verwijderd, false);
  assert.equal(bron.aanroepen.vernietig, 3);
});

test('mislukt al de eerste stap, dan FAILED VERNIETIGING_MISLUKT: er is niets weg', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext({ maxPogingen: 2 });
  const eerste = bron.zaak(kandidaat(0).bronId).onderdelen[0].kenmerk;
  bron.faalBij(kandidaat(0).bronId, eerste);
  const afgerond = await vernietig([object(0)]);

  assert.equal(afgerond.resultaten[0].foutcode, 'VERNIETIGING_MISLUKT');
  assert.equal(afgerond.resultaten[0].bronstatus, 'ONVERANDERD');
  assert.equal(bron.zaak(kandidaat(0).bronId).onderdelen.length, kandidaat(0).aantalObjecten);
});

test('een controle die blijft mislukken geeft FAILED CONTROLE_MISLUKT zonder te vernietigen', async () => {
  const { bron, kandidaat, object, vernietig } = await maakContext({ maxPogingen: 2 });
  bron.faalBij(kandidaat(0).bronId, 'controleer');
  const afgerond = await vernietig([object(0)]);

  assert.equal(afgerond.resultaten[0].foutcode, 'CONTROLE_MISLUKT');
  assert.equal(bron.aanroepen.controleer, 2);
  assert.equal(bron.aanroepen.vernietig, 0);
});

test('een hervatting na gedeeltelijke vernietiging slaat de controle over en maakt het af', async () => {
  const journaalRepository = new InMemoryJournaalRepository();
  const vernietigingRepository = new InMemoryVernietigingRepository();
  const { bron, kandidaat, object, vernietigingService, maakVernietiging } = await maakContext({
    maxPogingen: 1,
    journaalRepository,
    vernietigingRepository
  });
  bron.faalBij(kandidaat(0).bronId, 'zaak', 1);
  const id = maakVernietiging([[object(0)]]);
  vernietigingRepository.save({ ...vernietigingRepository.findById(id), status: 'RUNNING', totaalBatches: 1 });

  // Eerste keer: onderdelen weg, zaak niet. Zoals na een crash: resultaten niet bewaard.
  const eerste = await vernietigingService.verwerkKandidaat({
    vernietiging: vernietigingRepository.findById(id),
    batchNummer: 1,
    object: { ...object(0), bronId: kandidaat(0).bronId },
    kandidaat: kandidaat(0)
  });
  assert.equal(eerste.foutcode, 'DEELS_VERNIETIGD');

  // Hervatting: de bron zou zijn eigen verwijderingen als wijziging zien; de controle wordt overgeslagen.
  const afgerond = await vernietigingService.verwerkVernietiging(id);

  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(bron.aanroepen.controleer, 1);
  assert.equal(bron.zaak(kandidaat(0).bronId).verwijderd, true);
});

test('een kandidaat die al klaar staat in het journaal wordt niet opnieuw vernietigd', async () => {
  const journaalRepository = new InMemoryJournaalRepository();
  const vernietigingRepository = new InMemoryVernietigingRepository();
  const { bron, object, vernietigingService, maakVernietiging } = await maakContext({ journaalRepository, vernietigingRepository });
  const id = maakVernietiging([[object(0)]]);
  const eerste = await vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: 1 });

  // Zoals na een crash vlak vóór het opslaan van de resultaten.
  vernietigingRepository.save({ ...vernietigingRepository.findById(id), status: 'RUNNING', resultaten: [] });
  const hervat = await vernietigingService.verwerkVernietiging(id);

  assert.equal(hervat.status, 'COMPLETED');
  assert.equal(hervat.resultaten[0].event.eventTijd, eerste.resultaten[0].event.eventTijd);
  assert.equal(bron.aanroepen.vernietig, 1);
});

test('levert batchresultaten per batch, ook voordat de vernietiging is verwerkt', async () => {
  const { object, vernietigingService } = await maakContext();
  const id = vernietigingService.startVernietiging({
    selectieId: vernietigingService.selectieService.selectieRepository.findAll()[0].selectieId,
    cockpitTaakId: 'taak-test-004',
    besluitReferentie: 'besluit-test-004'
  }).vernietigingId;

  vernietigingService.voegBatchToe(id, { batchNummer: 2, vernietigingskandidaten: [object(3), object(4)] });
  const ontvangen = vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [object(0), object(1), object(2)] });

  assert.deepEqual(ontvangen, { batchNummer: 1, resultaten: [] });
  assert.deepEqual(vernietigingService.getBatchResultaten(id), [{ batchNummer: 1, resultaten: [] }, { batchNummer: 2, resultaten: [] }]);

  await vernietigingService.vrijgeven(id, { aantalBatches: 2, aantalKandidaten: 5 });

  const batch1 = vernietigingService.getBatchResultaat(id, 1);
  const batch2 = vernietigingService.getBatchResultaat(id, 2);
  assert.equal(batch1.resultaten.length, 3);
  assert.equal(batch2.resultaten.length, 2);
  assert.equal([...batch1.resultaten, ...batch2.resultaten].every((resultaat) => resultaat.resultaat === 'SUCCESS'), true);
  assert.equal(vernietigingService.getVernietiging(id).status, 'COMPLETED');
  assert.throws(() => vernietigingService.getBatchResultaat(id, 3), (error) => error.code === 'BATCH_NOT_FOUND');
  assert.throws(() => vernietigingService.getBatchResultaten('vern-bestaat-niet'), (error) => error.code === 'VERNIETIGING_NOT_FOUND');
});

test('weigert bij aanlevering objecten die niet bij de selectie horen', async () => {
  const { object, maakVernietiging, vernietigingService } = await maakContext();
  const id = maakVernietiging([]);
  const isValidatieFout = (error) => error.code === 'VALIDATION_ERROR';

  assert.throws(
    () => vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [{ vernietigingskandidaatId: 'vk-bestaat-niet', identificatie: [{ identificatieKenmerk: 'x', identificatieBron: 'x' }] }] }),
    isValidatieFout
  );
  assert.throws(
    () => vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [{ ...object(0), identificatie: object(1).identificatie }] }),
    isValidatieFout
  );
  assert.throws(() => vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [object(0), object(0)] }), isValidatieFout);
  assert.throws(
    () => vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [{ vernietigingskandidaatId: object(0).vernietigingskandidaatId }] }),
    isValidatieFout
  );
  assert.equal(vernietigingService.getVernietiging(id).batches.length, 0);
});

test('weigert een kandidaat die al in een andere batch is aangeleverd, en accepteert dezelfde batch opnieuw', async () => {
  const { object, maakVernietiging, vernietigingService } = await maakContext();
  const id = maakVernietiging([[object(0), object(1)]]);

  assert.throws(
    () => vernietigingService.voegBatchToe(id, { batchNummer: 2, vernietigingskandidaten: [object(2), object(1)] }),
    (error) => error.code === 'KANDIDAAT_AL_AANGELEVERD'
  );
  assert.deepEqual(vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [object(0), object(1)] }), { batchNummer: 1, resultaten: [] });
  assert.equal(vernietigingService.getVernietiging(id).totaalKandidaten, 2);
});

test('vernietigt nooit een zaak die niet bij de kandidaat hoort (vangnet bij uitvoering)', async () => {
  const vernietigingRepository = new InMemoryVernietigingRepository();
  const { bron, kandidaat, object, maakVernietiging, vernietigingService } = await maakContext({ vernietigingRepository });
  const id = maakVernietiging([]);

  // Omzeilt de controle bij aanlevering, zoals een fout in een toekomstige codewijziging zou doen.
  const opgeslagen = vernietigingRepository.findById(id);
  opgeslagen.batches.push({ batchNummer: 1, objecten: [{ ...object(0), bronId: kandidaat(1).bronId }] });
  opgeslagen.totaalKandidaten = 1;
  vernietigingRepository.save(opgeslagen);

  const afgerond = await vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: 1 });

  assert.equal(afgerond.resultaten[0].foutcode, 'BRONID_MISMATCH');
  assert.equal(afgerond.status, 'PARTIAL');
  assert.equal(bron.zaak(kandidaat(0).bronId).verwijderd, false);
  assert.equal(bron.zaak(kandidaat(1).bronId).verwijderd, false);
});

test('verwerkt een vrijgegeven vernietiging asynchroon, batch voor batch', async () => {
  const { object, maakVernietiging, vernietigingService } = await maakContext({ processingDelayMs: 200 });
  const id = maakVernietiging([[object(0), object(1)], [object(2)]]);

  const vrijgegeven = await vernietigingService.vrijgeven(id, { aantalBatches: 2, aantalKandidaten: 3 });
  assert.equal(vrijgegeven.status, 'RUNNING');

  // Batch 2 volgt pas 200 ms na batch 1, dus de tussenstand is ruim zichtbaar.
  let tussenstand = vernietigingService.getVernietiging(id);
  const start = Date.now();
  while (tussenstand.succesvolVernietigd === 0 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    tussenstand = vernietigingService.getVernietiging(id);
  }

  assert.equal(tussenstand.status, 'RUNNING');
  assert.equal(tussenstand.succesvolVernietigd, 2);
  assert.equal(vernietigingService.getBatchResultaat(id, 2).resultaten.length, 0);

  const afgerond = await vernietigingService.wachtOpVerwerking(id);
  assert.equal(afgerond.status, 'COMPLETED');
  assert.equal(afgerond.succesvolVernietigd, 3);
  assert.ok(afgerond.eindtijd);
});

test('twee vernietigingen tegelijk op dezelfde selectie verliezen geen resultaten', async () => {
  const { bron, kandidaat, object, maakVernietiging, vernietigingService } = await maakContext({ processingDelayMs: 5 });
  const idA = maakVernietiging([[object(0)], [object(1)], [object(2)]]);
  const idB = maakVernietiging([[object(3)], [object(4)], [object(5)]]);

  await Promise.all([
    vernietigingService.vrijgeven(idA, { aantalBatches: 3, aantalKandidaten: 3 }),
    vernietigingService.vrijgeven(idB, { aantalBatches: 3, aantalKandidaten: 3 })
  ]);
  const [a, b] = await Promise.all([vernietigingService.wachtOpVerwerking(idA), vernietigingService.wachtOpVerwerking(idB)]);

  assert.equal(a.succesvolVernietigd + b.succesvolVernietigd, 6);
  assert.equal([0, 1, 2, 3, 4, 5].every((index) => bron.zaak(kandidaat(index).bronId).verwijderd), true);
});

test('zet de vernietiging op FAILED als de verwerking zelf faalt', async () => {
  const kapotJournaal = { voor: () => ({ lees: () => Promise.reject(new Error('journaal niet leesbaar')), schrijf: async () => {} }) };
  const { object, maakVernietiging, vernietigingService } = await maakContext({ processingDelayMs: 5, journaalRepository: kapotJournaal });
  const id = maakVernietiging([[object(0)]]);

  await vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: 1 });
  const afgerond = await vernietigingService.wachtOpVerwerking(id);

  assert.equal(afgerond.status, 'FAILED');
  assert.equal(afgerond.aantalFouten, 1);
  assert.ok(afgerond.eindtijd);
});

test('Idempotency-Key bij POST /vernietigingen: zelfde key levert dezelfde vernietiging, andere inhoud geeft 409', async () => {
  const { selectie, vernietigingService } = await maakContext();
  const verzoek = { selectieId: selectie.selectieId, cockpitTaakId: 'taak-idem', besluitReferentie: 'besluit-idem' };

  const eerste = vernietigingService.startVernietiging(verzoek, { idempotencyKey: 'taak-idem:stekker:vernietiging' });
  const herhaling = vernietigingService.startVernietiging({ ...verzoek }, { idempotencyKey: 'taak-idem:stekker:vernietiging' });
  const andereKey = vernietigingService.startVernietiging(verzoek, { idempotencyKey: 'taak-idem:stekker:vernietiging-2' });

  assert.equal(herhaling.vernietigingId, eerste.vernietigingId);
  assert.notEqual(andereKey.vernietigingId, eerste.vernietigingId);
  assert.throws(
    () => vernietigingService.startVernietiging({ ...verzoek, besluitReferentie: 'ander-besluit' }, { idempotencyKey: 'taak-idem:stekker:vernietiging' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
});

test('Idempotency-Key bij batches en vrijgeven: herhaling na vrijgeven geeft de actuele stand, geen 409', async () => {
  const { selectie, object, vernietigingService } = await maakContext({ processingDelayMs: 20 });
  const id = vernietigingService.startVernietiging({
    selectieId: selectie.selectieId,
    cockpitTaakId: 'taak-idem-2',
    besluitReferentie: 'besluit-idem-2'
  }).vernietigingId;
  const batch = { batchNummer: 1, vernietigingskandidaten: [object(0), object(1)] };
  const vrijgave = { aantalBatches: 1, aantalKandidaten: 2 };

  vernietigingService.voegBatchToe(id, batch, { idempotencyKey: 'k:batch:1' });
  assert.equal((await vernietigingService.vrijgeven(id, vrijgave, { idempotencyKey: 'k:vrijgeven' })).status, 'RUNNING');

  // Cockpit herstart tijdens RUNNING en herhaalt zijn calls met dezelfde keys.
  assert.equal((await vernietigingService.vrijgeven(id, vrijgave, { idempotencyKey: 'k:vrijgeven' })).status, 'RUNNING');
  assert.equal(vernietigingService.voegBatchToe(id, batch, { idempotencyKey: 'k:batch:1' }).batchNummer, 1);

  await assert.rejects(vernietigingService.vrijgeven(id, vrijgave), (error) => error.code === 'VERNIETIGING_NOT_IDLE');
  await assert.rejects(
    vernietigingService.vrijgeven(id, { aantalBatches: 1, aantalKandidaten: 3 }, { idempotencyKey: 'k:vrijgeven' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  assert.throws(
    () => vernietigingService.voegBatchToe(id, { batchNummer: 1, vernietigingskandidaten: [object(0)] }, { idempotencyKey: 'k:batch:1' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );

  await vernietigingService.wachtOpVerwerking(id);
  const naAfronding = await vernietigingService.vrijgeven(id, vrijgave, { idempotencyKey: 'k:vrijgeven' });
  assert.equal(naAfronding.status, 'COMPLETED');
  assert.equal(vernietigingService.voegBatchToe(id, batch, { idempotencyKey: 'k:batch:1' }).resultaten.length, 2);
});

test('geeft unieke selectie- en vernietigingId\'s, ook bij gelijke tijdstempel', async () => {
  const bron = new GeheugenBron({ aantal: 5 });
  const stilstaandeKlok = () => new Date('2026-09-25T16:00:00.000Z');
  const selectieService = new SelectieService({ bron, selectieRepository: new InMemorySelectieRepository(), clock: stilstaandeKlok, processingDelayMs: 0 });
  const vernietigingService = new VernietigingService({
    bron,
    selectieService,
    vernietigingRepository: new InMemoryVernietigingRepository(),
    clock: stilstaandeKlok,
    processingDelayMs: 0
  });

  const [selectieA, selectieB] = await Promise.all([
    selectieService.startSelectie({ peildatum: '2026-09-25' }),
    selectieService.startSelectie({ peildatum: '2026-09-25' })
  ]);
  const verzoek = { selectieId: selectieA.selectieId, cockpitTaakId: 'taak-uniek', besluitReferentie: 'besluit-uniek' };
  const vernietigingA = vernietigingService.startVernietiging(verzoek);
  const vernietigingB = vernietigingService.startVernietiging(verzoek);

  assert.notEqual(selectieA.selectieId, selectieB.selectieId);
  assert.match(selectieA.selectieId, /^sel-20260925-[0-9a-f]{12}$/);
  assert.notEqual(vernietigingA.vernietigingId, vernietigingB.vernietigingId);
  assert.match(vernietigingA.vernietigingId, /^vern-[0-9a-f]{12}$/);
});
