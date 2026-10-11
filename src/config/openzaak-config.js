// Verbinding met Open Zaak. Per stekkerinstantie via env; het secret hoort in .env of een
// secret-store, nooit in git.

const DIENSTEN = [
  ['zaken', 'OPENZAAK_ZAKEN_URL'],
  ['documenten', 'OPENZAAK_DOCUMENTEN_URL'],
  ['besluiten', 'OPENZAAK_BESLUITEN_URL'],
  ['catalogi', 'OPENZAAK_CATALOGI_URL']
];

export const STANDAARD_SELECTIELIJST_URL = 'https://selectielijst.openzaak.nl/api/v1/';

// Leest en controleert de instellingen. Ontbreekt er iets verplichts, dan een fout met alle
// ontbrekende variabelen tegelijk, zodat de stekker bij het opstarten duidelijk faalt.
export function parseOpenZaakConfig(env = process.env) {
  const fouten = [];
  const diensten = {};

  for (const [naam, variabele] of DIENSTEN) {
    diensten[naam] = leesUrl(env, variabele, fouten, { verplicht: true });
  }

  diensten.selectielijst = leesUrl(env, 'SELECTIELIJST_URL', fouten, { standaard: STANDAARD_SELECTIELIJST_URL });

  const clientId = (env.OPENZAAK_CLIENT_ID ?? '').trim();
  const secret = env.OPENZAAK_SECRET ?? '';

  if (!clientId) {
    fouten.push('OPENZAAK_CLIENT_ID ontbreekt.');
  }

  if (!secret) {
    fouten.push('OPENZAAK_SECRET ontbreekt.');
  }

  const timeoutMs = leesGetal(env, 'OPENZAAK_TIMEOUT_MS', 30000, 1000, 600000, fouten);
  const parallel = leesGetal(env, 'OPENZAAK_PARALLEL', 8, 1, 64, fouten);
  const maxPogingen = leesGetal(env, 'OPENZAAK_GET_POGINGEN', 3, 1, 10, fouten);
  // Optioneel: alleen zaken van deze zaaktypen (identificatie, kommagescheiden).
  const zaaktypen = (env.OPENZAAK_ZAAKTYPEN ?? '').split(',').map((item) => item.trim()).filter(Boolean);

  if (fouten.length > 0) {
    throw new Error(`Configuratie Open Zaak onvolledig: ${fouten.join(' ')}`);
  }

  return { diensten, clientId, secret, timeoutMs, parallel, maxPogingen, zaaktypen };
}

function leesUrl(env, variabele, fouten, { verplicht = false, standaard } = {}) {
  const ruw = (env[variabele] ?? '').trim() || standaard;

  if (!ruw) {
    if (verplicht) {
      fouten.push(`${variabele} ontbreekt.`);
    }

    return undefined;
  }

  try {
    const url = new URL(ruw);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fouten.push(`${variabele} moet een http(s)-URL zijn.`);
      return undefined;
    }

    if (url.search || url.hash || url.username || url.password) {
      fouten.push(`${variabele} mag geen query, fragment of inloggegevens bevatten.`);
      return undefined;
    }

    return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
  } catch {
    fouten.push(`${variabele} is geen geldige URL.`);
    return undefined;
  }
}

function leesGetal(env, naam, standaard, minimum, maximum, fouten) {
  const ruw = env[naam];

  if (ruw === undefined || ruw.trim() === '') {
    return standaard;
  }

  const waarde = Number(ruw);

  if (!Number.isInteger(waarde) || waarde < minimum || waarde > maximum) {
    fouten.push(`${naam} moet een geheel getal tussen ${minimum} en ${maximum} zijn.`);
    return standaard;
  }

  return waarde;
}
