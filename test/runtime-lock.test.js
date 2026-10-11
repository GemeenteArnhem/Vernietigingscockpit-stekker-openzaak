import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeLock } from '../src/infrastructure/runtime-lock.js';

function lockPad(t) {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'stekker-lock-'));
  t.after(() => fs.rmSync(map, { recursive: true, force: true }));
  return path.join(map, 'instance.lock');
}

function maakLock(lockPath, opties = {}) {
  return new RuntimeLock({ lockPath, leaseMs: 300, heartbeatMs: 50, wachtMs: 600, hostname: 'host-a', pid: 1, ...opties });
}

test('verkrijgt een vrije lock en geeft hem weer vrij', async (t) => {
  const pad = lockPad(t);
  const lock = maakLock(pad);

  await lock.verkrijg();
  assert.equal(JSON.parse(fs.readFileSync(pad, 'utf8')).hostname, 'host-a');

  lock.vrijgeven();
  assert.equal(fs.existsSync(pad), false);
});

test('een tweede, andere instantie weigert te starten zolang de eerste leeft', async (t) => {
  const pad = lockPad(t);
  const eerste = maakLock(pad);
  await eerste.verkrijg();
  t.after(() => eerste.vrijgeven());

  const tweede = maakLock(pad, { hostname: 'host-b' });
  const start = Date.now();

  await assert.rejects(tweede.verkrijg(), /in gebruik door een andere stekkerinstantie \(host-a, pid 1\)/);
  assert.ok(Date.now() - start >= 600, 'wacht eerst de ingestelde tijd af');
  assert.equal(eerste.isEigenaar(), true);
});

test('neemt een verlopen lock over (instantie zonder heartbeat, bijv. na kill)', async (t) => {
  const pad = lockPad(t);
  fs.writeFileSync(pad, JSON.stringify({ hostname: 'host-oud', pid: 7, token: 'oud', heartbeat: Date.now() - 10000 }));

  const lock = maakLock(pad);
  await lock.verkrijg();
  t.after(() => lock.vrijgeven());

  assert.equal(lock.isEigenaar(), true);
});

test('neemt de lock van een vorige incarnatie (zelfde hostname en pid) direct over', async (t) => {
  const pad = lockPad(t);
  // Verse heartbeat, maar van 'onszelf' vóór een docker restart.
  fs.writeFileSync(pad, JSON.stringify({ hostname: 'host-a', pid: 1, token: 'vorige', heartbeat: Date.now() }));

  const lock = maakLock(pad);
  const start = Date.now();
  await lock.verkrijg();
  t.after(() => lock.vrijgeven());

  assert.equal(lock.isEigenaar(), true);
  assert.ok(Date.now() - start < 300, 'zonder op de lease te wachten');
});

test('na vrijgeven kan een andere instantie direct starten', async (t) => {
  const pad = lockPad(t);
  const eerste = maakLock(pad);
  await eerste.verkrijg();
  eerste.vrijgeven();

  const tweede = maakLock(pad, { hostname: 'host-b' });
  await tweede.verkrijg();
  t.after(() => tweede.vrijgeven());

  assert.equal(tweede.isEigenaar(), true);
});

test('een instantie die haar lock kwijt is, meldt dat bij de volgende heartbeat', async (t) => {
  const pad = lockPad(t);
  let verloren;
  const lock = maakLock(pad, { onVerloren: (eigenaar) => { verloren = eigenaar; } });
  await lock.verkrijg();
  t.after(() => lock.vrijgeven());

  fs.writeFileSync(pad, JSON.stringify({ hostname: 'host-b', pid: 9, token: 'ander', heartbeat: Date.now() }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(verloren?.hostname, 'host-b');
  assert.equal(lock.heartbeat, undefined);
});
