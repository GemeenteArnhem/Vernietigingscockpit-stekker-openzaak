#!/usr/bin/env node
// Integratietest tegen een echte Open Zaak (1.30.0) in Docker:
//   1. start een lege Open Zaak (eigen compose-project, eigen geheimen per run);
//   2. zet de accounts klaar (openzaak-init) en vult hem met voorbeeldzaken (seed-openzaak.mjs);
//   3. draait test/integratie/*.test.js met de stekker tegen die Open Zaak;
//   4. ruimt alles op (ook het volume), tenzij OPENZAAK_BEHOUD=1.
//
//   npm run test:openzaak

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = process.env.OPENZAAK_TEST_PROJECT || 'stekker-openzaak-test';
const poort = process.env.OPENZAAK_HOST_POORT || '8491';
const behoud = process.env.OPENZAAK_BEHOUD === '1';
const geheim = (bytes) => crypto.randomBytes(bytes).toString('hex');
const werkmap = fs.mkdtempSync(path.join(os.tmpdir(), 'openzaak-test-'));
const seedBestand = path.join(werkmap, 'seed.json');

const env = {
  ...process.env,
  OPENZAAK_HOST_POORT: poort,
  OPENZAAK_DB_WACHTWOORD: geheim(16),
  OPENZAAK_SECRET_KEY: geheim(32),
  OPENZAAK_ADMIN_WACHTWOORD: geheim(12),
  OPENZAAK_SEED_CLIENT_ID: 'vernietigingscockpit-seed',
  OPENZAAK_SEED_SECRET: geheim(24),
  OPENZAAK_CLIENT_ID: 'vernietigingscockpit-stekker',
  OPENZAAK_SECRET: geheim(24),
  OPENZAAK_URL: `http://localhost:${poort}`,
  OPENZAAK_SEED_BESTAND: seedBestand,
  // In Git Bash op Windows: paden in docker-argumenten niet omzetten.
  MSYS_NO_PATHCONV: '1'
};
const compose = ['compose', '-f', path.join(root, 'compose.openzaak.yaml'), '-p', project];

function voer(commando, args, { stoppen = true } = {}) {
  console.log(`> ${commando} ${args.join(' ')}`);
  const resultaat = spawnSync(commando, args, { cwd: root, env, stdio: 'inherit', shell: false });

  if (resultaat.status !== 0 && stoppen) {
    throw new Error(`${commando} ${args.slice(0, 3).join(' ')} eindigde met ${resultaat.status ?? resultaat.error?.message}`);
  }

  return resultaat.status;
}

let status = 1;

try {
  voer('docker', [...compose, 'down', '-v', '--remove-orphans'], { stoppen: false });
  voer('docker', [...compose, 'up', '-d', '--wait', 'openzaak']);
  voer('docker', [...compose, 'run', '--rm', 'openzaak-init']);
  voer(process.execPath, ['scripts/seed-openzaak.mjs', '--aantal', process.env.OPENZAAK_SEED_AANTAL || '10', '--uitvoer', seedBestand]);
  status = voer(process.execPath, ['--test', '--test-concurrency=1', 'test/integratie/*.test.js'], { stoppen: false });
} catch (error) {
  console.error(error.message);
} finally {
  if (behoud) {
    // Om er daarna zelf tegen te kunnen werken; .env.* staat in .gitignore.
    const bewaard = path.join(root, '.env.openzaak-test');
    const regels = Object.entries(env).filter(([naam]) => naam.startsWith('OPENZAAK_')).map(([naam, waarde]) => `${naam}=${waarde}`);
    fs.writeFileSync(bewaard, `${regels.join('\n')}\n`);

    if (fs.existsSync(seedBestand)) {
      fs.copyFileSync(seedBestand, path.join(root, 'runtime-openzaak-seed.json'));
    }
    console.log(`Open Zaak blijft draaien op ${env.OPENZAAK_URL} (project ${project}); instellingen in .env.openzaak-test.`);
  } else {
    voer('docker', [...compose, 'down', '-v', '--remove-orphans'], { stoppen: false });
  }

  fs.rmSync(werkmap, { recursive: true, force: true });
}

process.exit(status);
