import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectieNogNietGereedError, SelectieService } from '../src/application/selectie-service.js';
import { InMemorySelectieRepository } from '../src/infrastructure/repositories/in-memory-selectie-repository.js';
import { GeheugenBron } from './helpers/geheugen-bron.js';

function maakService(opties = {}) {
  return new SelectieService({
    bron: new GeheugenBron(),
    selectieRepository: new InMemorySelectieRepository(),
    clock: () => new Date('2026-09-25T10:00:00.000Z'),
    processingDelayMs: 0,
    ...opties
  });
}

test('maakt een bevroren selectie uit de bron', async () => {
  const service = maakService();
  const selectie = await service.startSelectie({ peildatum: '2026-09-25' });

  assert.equal(selectie.status, 'READY');
  assert.equal(selectie.bronRecords, 200);
  assert.equal(selectie.aantalWaarschuwingen, 0);
  assert.equal(selectie.totaalKandidaten, 129);
  assert.equal(selectie.kandidaten.every((kandidaat) => kandidaat.bewaartermijn.termijnEinddatum <= '2026-09-25'), true);
  assert.equal(selectie.totaalObjecten, selectie.kandidaten.reduce((som, kandidaat) => som + kandidaat.aantalObjecten, 0));
  assert.ok(Object.isFrozen(service.getSelectie(selectie.selectieId).kandidaten[0]), 'een afgeronde selectie verandert niet meer');
});

test('zonder peildatum geldt de dag waarop de selectie start', async () => {
  const selectie = await maakService().startSelectie({});

  assert.equal(selectie.peildatum, '2026-09-25');
  assert.match(selectie.selectieId, /^sel-20260925-/);
});

test('levert kandidaten gepagineerd', async () => {
  const service = maakService();
  const selectie = await service.startSelectie({ peildatum: '2026-09-25' });
  const pagina = service.getKandidaten(selectie.selectieId, { offset: 10, limit: 5 });

  assert.equal(pagina.items.length, 5);
  assert.equal(pagina.offset, 10);
  assert.equal(pagina.limit, 5);
  assert.equal(pagina.totaal, selectie.totaalKandidaten);
});

test('houdt de selectie tijdelijk op RUNNING en rondt daarna af', async () => {
  const service = maakService({ processingDelayMs: 25 });
  const selectie = await service.startSelectie({ peildatum: '2026-09-25' });

  assert.equal(selectie.status, 'RUNNING');
  assert.throws(() => service.getKandidaten(selectie.selectieId, { offset: 0, limit: 5 }), SelectieNogNietGereedError);

  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });

  const afgerond = service.getSelectie(selectie.selectieId);
  assert.equal(afgerond.status, 'READY');
  assert.equal(afgerond.totaalKandidaten, 129);
});

test('een fout in de bron levert een selectie met status FAILED op', async () => {
  const bron = new GeheugenBron();
  bron.selecteer = async () => {
    throw new Error('Open Zaak niet bereikbaar');
  };
  const selectie = await maakService({ bron }).startSelectie({ peildatum: '2026-09-25' });

  assert.equal(selectie.status, 'FAILED');
  assert.equal(selectie.aantalFouten, 1);
  assert.equal(selectie.foutmelding, 'Open Zaak niet bereikbaar');
});

test('weigert een bron zonder de verplichte functies', () => {
  assert.throws(
    () => new SelectieService({ bron: { selecteer() {} }, selectieRepository: new InMemorySelectieRepository() }),
    /Bron mist controleer, vernietig/
  );
});
