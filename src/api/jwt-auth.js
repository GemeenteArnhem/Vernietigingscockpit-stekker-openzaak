import crypto from 'node:crypto';

// OAuth2-bearer-tokenvalidatie volgens de securityScheme van de Stekker-spec
// (client credentials, scopes per endpoint). Zonder dependencies: de handtekening
// wordt met node:crypto gecontroleerd tegen de JWKS van de identity provider.

const ALGORITMEN = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' }
};

export const SCOPE_PER_ENDPOINT = {
  'POST /selecties': 'selectie.write',
  'GET /selecties/{selectieId}': 'selectie.read',
  'GET /selecties/{selectieId}/vernietigingskandidaten': 'selectie.read',
  'POST /vernietigingen': 'vernietiging.write',
  'GET /vernietigingen/{vernietigingId}': 'vernietiging.read',
  'POST /vernietigingen/{vernietigingId}/batches': 'vernietiging.write',
  'GET /vernietigingen/{vernietigingId}/batches': 'vernietiging.read',
  'GET /vernietigingen/{vernietigingId}/batches/{batchNummer}': 'vernietiging.read',
  'POST /vernietigingen/{vernietigingId}/vrijgeven': 'vernietiging.write',
  'GET /vernietigingen/{vernietigingId}/specificaties/{vernietigingskandidaatId}': 'vernietiging.read'
};

export class AuthFout extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.code = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
    // Waarde voor de WWW-Authenticate-header (RFC 6750).
    this.oauthError = error;
  }
}

export function createAuthenticator({
  enabled,
  issuer,
  jwksUrl,
  audience,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  clockToleranceS = 30,
  jwksCacheMs = 10 * 60 * 1000,
  jwksMinRefreshMs = 30 * 1000,
  jwksTimeoutMs = 5000
}) {
  let sleutels = new Map();
  let opgehaaldOp = 0;
  let lopendeOpvraging;

  // Gelijktijdige requests delen één lopende opvraging, en een hangende identity
  // provider houdt requests nooit langer dan jwksTimeoutMs vast.
  function haalSleutelsOp() {
    lopendeOpvraging ??= haalSleutelsOpVanIdp().finally(() => {
      lopendeOpvraging = undefined;
    });
    return lopendeOpvraging;
  }

  async function haalSleutelsOpVanIdp() {
    const response = await fetchFn(jwksUrl, { signal: AbortSignal.timeout(jwksTimeoutMs) });

    if (!response.ok) {
      throw new Error(`JWKS ophalen mislukt: HTTP ${response.status}`);
    }

    const { keys = [] } = await response.json();
    sleutels = new Map(
      keys
        .filter((jwk) => jwk.kid && (!jwk.use || jwk.use === 'sig'))
        .map((jwk) => [jwk.kid, jwk])
    );
    opgehaaldOp = now();
  }

  async function zoekSleutel(kid) {
    if (sleutels.size === 0 || now() - opgehaaldOp > jwksCacheMs) {
      await haalSleutelsOp();
    }

    // Onbekende kid: mogelijk sleutelrotatie. Opnieuw ophalen, maar niet vaker dan
    // jwksMinRefreshMs, zodat tokens met verzonnen kids de IdP niet kunnen belasten.
    if (!sleutels.has(kid) && now() - opgehaaldOp > jwksMinRefreshMs) {
      await haalSleutelsOp();
    }

    return sleutels.get(kid);
  }

  return {
    enabled,

    // Geeft de token-claims terug, of gooit een AuthFout (401 of 403).
    async authenticeer(request, endpoint) {
      if (!enabled) {
        return undefined;
      }

      const token = leesBearerToken(request.headers.authorization);
      const { header, payload, ondertekend, handtekening } = decodeer(token);
      const algoritme = ALGORITMEN[header.alg];

      if (!algoritme) {
        throw new AuthFout(401, 'invalid_token', `Algoritme ${header.alg} is niet toegestaan.`);
      }

      let jwk;

      try {
        jwk = await zoekSleutel(header.kid);
      } catch {
        throw new AuthFout(401, 'invalid_token', 'Sleutels van de identity provider zijn niet beschikbaar.');
      }

      if (!jwk || jwk.kty !== algoritme.kty) {
        throw new AuthFout(401, 'invalid_token', 'Onbekende of ongeschikte sleutel (kid).');
      }

      const geldig = crypto.verify(
        algoritme.hash,
        Buffer.from(ondertekend),
        { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: algoritme.dsaEncoding },
        handtekening
      );

      if (!geldig) {
        throw new AuthFout(401, 'invalid_token', 'Ongeldige handtekening.');
      }

      controleerClaims(payload, { issuer, audience, nuS: now() / 1000, clockToleranceS });

      const vereisteScope = SCOPE_PER_ENDPOINT[endpoint];
      const scopes = leesScopes(payload);

      if (vereisteScope && !scopes.includes(vereisteScope)) {
        throw new AuthFout(403, 'insufficient_scope', `Scope ${vereisteScope} is vereist.`);
      }

      return payload;
    }
  };
}

function leesBearerToken(authorization) {
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer ([A-Za-z0-9_.-]+)$/) : null;

  if (!match) {
    throw new AuthFout(401, 'invalid_request', 'Bearer-token ontbreekt.');
  }

  return match[1];
}

function decodeer(token) {
  const delen = token.split('.');

  if (delen.length !== 3) {
    throw new AuthFout(401, 'invalid_token', 'Token is geen geldige JWT.');
  }

  try {
    return {
      header: JSON.parse(Buffer.from(delen[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(delen[1], 'base64url').toString('utf8')),
      ondertekend: `${delen[0]}.${delen[1]}`,
      handtekening: Buffer.from(delen[2], 'base64url')
    };
  } catch {
    throw new AuthFout(401, 'invalid_token', 'Token is geen geldige JWT.');
  }
}

function controleerClaims(payload, { issuer, audience, nuS, clockToleranceS }) {
  if (payload.iss !== issuer) {
    throw new AuthFout(401, 'invalid_token', 'Token is niet uitgegeven door de verwachte issuer.');
  }

  if (typeof payload.exp !== 'number' || payload.exp + clockToleranceS < nuS) {
    throw new AuthFout(401, 'invalid_token', 'Token is verlopen.');
  }

  if (typeof payload.nbf === 'number' && payload.nbf - clockToleranceS > nuS) {
    throw new AuthFout(401, 'invalid_token', 'Token is nog niet geldig.');
  }

  if (audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (!audiences.includes(audience)) {
      throw new AuthFout(401, 'invalid_token', 'Token is niet bedoeld voor deze stekker (aud).');
    }
  }
}

// Keycloak zet scopes in `scope` (spatiegescheiden); andere IdP's soms in `scp`.
function leesScopes(payload) {
  if (typeof payload.scope === 'string') {
    return payload.scope.split(' ').filter(Boolean);
  }

  if (Array.isArray(payload.scp)) {
    return payload.scp;
  }

  return typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : [];
}
