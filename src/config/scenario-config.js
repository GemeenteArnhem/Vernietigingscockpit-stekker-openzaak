import crypto from 'node:crypto';

// Foutscenario's om de Cockpit tegen foutpaden te testen. Alles staat standaard uit;
// een scenario wordt per stekkerinstantie via env ingesteld en is deterministisch,
// zodat tests reproduceerbaar zijn.

const RESULTAAT_PERCENTAGES = [
  ['FAILED', 'SCENARIO_FAILED_PERCENTAGE'],
  ['CHANGED', 'SCENARIO_CHANGED_PERCENTAGE'],
  ['NOT_FOUND', 'SCENARIO_NOT_FOUND_PERCENTAGE'],
  ['SKIPPED', 'SCENARIO_SKIPPED_PERCENTAGE']
];

const TOEGESTANE_HTTP_FOUTSTATUSSEN = [401, 403, 500, 502, 503, 504];
const FAIL_MODES = ['voor', 'na'];

export function parseScenario(env = process.env) {
  const percentages = Object.fromEntries(
    RESULTAAT_PERCENTAGES.map(([resultaat, variabele]) => [resultaat, leesGeheelGetal(env, variabele, 0, 0, 100)])
  );
  const totaal = Object.values(percentages).reduce((som, percentage) => som + percentage, 0);

  if (totaal > 100) {
    throw new Error(`Scenario-percentages tellen op tot ${totaal}; maximaal 100 is toegestaan.`);
  }

  const failStatus = leesGeheelGetal(env, 'SCENARIO_HTTP_FAIL_STATUS', 503, 400, 599);

  if (!TOEGESTANE_HTTP_FOUTSTATUSSEN.includes(failStatus)) {
    throw new Error(`SCENARIO_HTTP_FAIL_STATUS moet een van ${TOEGESTANE_HTTP_FOUTSTATUSSEN.join(', ')} zijn.`);
  }

  const failMode = (env.SCENARIO_HTTP_FAIL_MODE ?? 'voor').trim() || 'voor';

  if (!FAIL_MODES.includes(failMode)) {
    throw new Error(`SCENARIO_HTTP_FAIL_MODE moet ${FAIL_MODES.join(' of ')} zijn.`);
  }

  return {
    resultaatPercentages: percentages,
    selectieFail: env.SCENARIO_SELECTIE_FAIL === 'true',
    // Levert ook bronrecords met waardering B (Blijvend te bewaren) als kandidaat, om de
    // automatische uitsluiting in de Cockpit te testen (ADR-0005, B-M1).
    leverNietV: env.SCENARIO_LEVER_NIET_V === 'true',
    http: {
      failFirstN: leesGeheelGetal(env, 'SCENARIO_HTTP_FAIL_FIRST_N', 0, 0, 1000),
      failStatus,
      failMode,
      failEndpoints: (env.SCENARIO_HTTP_FAIL_ENDPOINTS ?? '')
        .split(',')
        .map((endpoint) => endpoint.trim())
        .filter(Boolean),
      delayMs: leesGeheelGetal(env, 'SCENARIO_HTTP_DELAY_MS', 0, 0, 600000)
    }
  };
}

export const GEEN_SCENARIO = parseScenario({});

// Kiest deterministisch een afwijkend resultaat op basis van het kandidaat-id:
// elke kandidaat valt in een vaste 'bucket' 0–99. Undefined betekent: normaal verwerken.
export function scenarioResultaat(scenario, vernietigingskandidaatId) {
  const bucket = Number.parseInt(
    crypto.createHash('sha256').update(vernietigingskandidaatId).digest('hex').slice(0, 8),
    16
  ) % 100;
  let grens = 0;

  for (const [resultaat] of RESULTAAT_PERCENTAGES) {
    grens += scenario.resultaatPercentages[resultaat];

    if (bucket < grens) {
      return resultaat;
    }
  }

  return undefined;
}

function leesGeheelGetal(env, naam, standaard, minimum, maximum) {
  const ruw = env[naam];

  if (ruw === undefined || ruw.trim() === '') {
    return standaard;
  }

  const waarde = Number(ruw);

  if (!Number.isInteger(waarde) || waarde < minimum || waarde > maximum) {
    throw new Error(`${naam} moet een geheel getal tussen ${minimum} en ${maximum} zijn (nu: ${ruw}).`);
  }

  return waarde;
}
