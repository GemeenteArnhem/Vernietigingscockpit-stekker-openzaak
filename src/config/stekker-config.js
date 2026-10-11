import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthConfig } from './auth-config.js';
import { parseMdtoConfig } from './mdto-config.js';
import { parseScenario } from './scenario-config.js';

// .env wordt alleen door het opstartpunt (src/index.js) ingelezen, zodat tests
// nooit afhangen van een lokale .env.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const stekkerConfig = {
  naam: process.env.STEKKER_NAAM || 'OpenZaak-stekker',
  omschrijving: process.env.STEKKER_OMSCHRIJVING || 'Stekker voor zaken in Open Zaak (Zaken, Documenten en Besluiten API).',
  versie: process.env.STEKKER_VERSIE || '0.1.0',
  apiVersie: process.env.STEKKER_API_VERSIE || '2.0.0',
  configuratieversie: process.env.STEKKER_CONFIGURATIEVERSIE || 'openzaak-2026-10-10',
  // Zonder peildatum in het verzoek: de dag waarop de selectie start.
  defaultPeildatum: process.env.STEKKER_DEFAULT_PEILDATUM || undefined,
  // Pauze vóór de asynchrone verwerking; 0 = synchroon, alleen voor tests.
  selectieProcessingDelayMs: leesGetal('SELECTIE_PROCESSING_DELAY_MS', 100),
  vernietigingProcessingDelayMs: leesGetal('VERNIETIGING_PROCESSING_DELAY_MS', 100),
  // Pogingen per kandidaat bij een fout in de bron (B-OZ3); daarna FAILED.
  vernietigingMaxPogingen: leesGetal('VERNIETIGING_MAX_POGINGEN', 3),
  vernietigingWachttijdPogingMs: leesGetal('VERNIETIGING_WACHTTIJD_POGING_MS', 2000),
  maxBodyBytes: leesGetal('MAX_BODY_BYTES', 1048576),
  logRequests: process.env.LOG_REQUESTS !== 'false',
  mdto: parseMdtoConfig(process.env),
  scenario: parseScenario(process.env),
  auth: parseAuthConfig(process.env),
  runtime: {
    selectiesPath: resolveFromRoot(process.env.STEKKER_RUNTIME_SELECTIES_PATH || path.join('runtime', 'selecties')),
    vernietigingenPath: resolveFromRoot(process.env.STEKKER_RUNTIME_VERNIETIGINGEN_PATH || path.join('runtime', 'vernietigingen')),
    journaalPath: resolveFromRoot(process.env.STEKKER_RUNTIME_JOURNAAL_PATH || path.join('runtime', 'journaal')),
    idempotencyPath: resolveFromRoot(process.env.STEKKER_RUNTIME_IDEMPOTENCY_PATH || path.join('runtime', 'idempotency')),
    lockPath: resolveFromRoot(process.env.STEKKER_RUNTIME_LOCK_PATH || path.join('runtime', 'instance.lock'))
  },
  dataSource: {
    type: 'openzaak',
    name: process.env.STEKKER_DATASOURCE_NAME || 'openzaak'
  }
};

export const serverConfig = {
  port: leesGetal('PORT', 3000)
};

function resolveFromRoot(configuredPath) {
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(rootDir, configuredPath);
}

function leesGetal(naam, standaard) {
  const ruw = process.env[naam];

  if (ruw === undefined || ruw.trim() === '') {
    return standaard;
  }

  const waarde = Number(ruw);

  if (!Number.isInteger(waarde) || waarde < 0) {
    throw new Error(`${naam} moet een geheel getal >= 0 zijn (nu: ${ruw}).`);
  }

  return waarde;
}
