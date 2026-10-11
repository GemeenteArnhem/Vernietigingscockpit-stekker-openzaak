import crypto from 'node:crypto';
import http from 'node:http';
import { ConflictError, ResourceNotFoundError, ValidationError } from '../application/errors.js';
import { SelectieNogNietGereedError } from '../application/selectie-service.js';
import { GEEN_SCENARIO } from '../config/scenario-config.js';
import { stekkerConfig } from '../config/stekker-config.js';
import { AuthFout, createAuthenticator } from './jwt-auth.js';
import {
  toBatchResultaatResponse,
  toKandidatenPaginaResponse,
  toSelectieResponse,
  toVernietigingResponse
} from './response-mappers.js';

const MAX_LIMIT = 500;
// Major versie in de URI (API Design Rules API-20); het volledige versienummer in de
// header API-Version (API-57).
const API_PREFIX = '/v2';
const MAX_CORRELATIE_ID_LENGTE = 200;

export function createHttpServer({
  selectieService,
  vernietigingService,
  maxBodyBytes = stekkerConfig.maxBodyBytes,
  logRequests = stekkerConfig.logRequests,
  scenario = stekkerConfig.scenario ?? GEEN_SCENARIO,
  authenticator = createAuthenticator(stekkerConfig.auth)
}) {
  // Telt per endpoint en resource (methode + pad) hoeveel calls er zijn binnengekomen.
  const transportTellers = new Map();

  return http.createServer(async (request, response) => {
    // Een meegestuurde X-Correlation-ID van de Cockpit wordt overgenomen, zodat
    // een fout aan beide kanten met hetzelfde kenmerk terug te vinden is.
    const correlatieId = leesCorrelatieId(request) ?? crypto.randomUUID();
    response.setHeader('X-Correlation-ID', correlatieId);
    response.setHeader('API-Version', stekkerConfig.apiVersie);

    if (logRequests) {
      logRequest(request, response, correlatieId);
    }

    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      const readBody = () => readJsonBody(request, maxBodyBytes);

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, {
          status: 'ok',
          naam: stekkerConfig.naam,
          versie: stekkerConfig.versie,
          configuratieversie: stekkerConfig.configuratieversie,
          dataSource: stekkerConfig.dataSource.name
        });
      }

      // Alles behalve /health valt onder /v2; het pad zonder prefix is het pad uit de spec.
      const pad = url.pathname.startsWith(`${API_PREFIX}/`) ? url.pathname.slice(API_PREFIX.length) : undefined;

      if (pad === undefined) {
        throw new ResourceNotFoundError('NOT_FOUND', `Endpoint niet gevonden; de API staat onder ${API_PREFIX}.`);
      }

      const endpoint = endpointVan(request.method, pad);
      await authenticator.authenticeer(request, endpoint);

      const transportFout = bepaalTransportFout(scenario.http, transportTellers, request.method, pad, endpoint);

      if (scenario.http.delayMs > 0) {
        await sleep(scenario.http.delayMs);
      }

      if (transportFout && scenario.http.failMode === 'voor') {
        throw transportFout;
      }

      if (request.method === 'POST' && endpoint) {
        vereisIdempotencyKey(request);
      }

      const resultaat = await routeer({ request, pad, url, readBody, selectieService, vernietigingService });

      // Faalmodus 'na': het verzoek is wél verwerkt, maar het antwoord gaat 'verloren'.
      // Precies de situatie waarvoor de Cockpit een Idempotency-Key meestuurt.
      if (transportFout) {
        throw transportFout;
      }

      if (resultaat.xml !== undefined) {
        return sendXml(response, resultaat.status, resultaat.xml);
      }

      return sendJson(response, resultaat.status, resultaat.payload);
    } catch (error) {
      return sendFout(response, request, correlatieId, error);
    }
  });
}

// Eén logregel per request, zonder bodies of kandidaatgegevens.
function logRequest(request, response, correlatieId) {
  const start = process.hrtime.bigint();

  response.on('finish', () => {
    console.log(JSON.stringify({
      niveau: 'info',
      tijdstip: new Date().toISOString(),
      correlatieId,
      methode: request.method,
      pad: request.url?.split('?')[0],
      status: response.statusCode,
      duurMs: Number((process.hrtime.bigint() - start) / 1_000_000n)
    }));
  });
}

// Stekker API v2: Idempotency-Key is verplicht op alle muterende verzoeken (ADR-0004).
function vereisIdempotencyKey(request) {
  const key = request.headers['idempotency-key'];

  if (typeof key !== 'string' || !key.trim()) {
    throw new ValidationError('Idempotency-Key is verplicht op dit verzoek.', 'IDEMPOTENCY_KEY_MISSING');
  }

  if (key.length > 200) {
    throw new ValidationError('Idempotency-Key is langer dan 200 tekens.', 'IDEMPOTENCY_KEY_INVALID');
  }
}

async function routeer({ request, pad, url, readBody, selectieService, vernietigingService }) {
  if (request.method === 'POST' && pad === '/selecties') {
    const body = await readBody();
    const selectie = await selectieService.startSelectie({
      peildatum: body.peildatum ?? undefined
    }, { idempotencyKey: request.headers['idempotency-key'] });

    return antwoord(202, toSelectieResponse(selectie));
  }

  if (request.method === 'POST' && pad === '/vernietigingen') {
    const body = await readBody();
    const vernietiging = vernietigingService.startVernietiging({
      selectieId: body.selectieId,
      cockpitTaakId: body.cockpitTaakId,
      besluitReferentie: body.besluitReferentie,
      vernietigingsdossierId: body.vernietigingsdossierId
    }, { idempotencyKey: request.headers['idempotency-key'] });

    return antwoord(202, toVernietigingResponse(vernietiging));
  }

  const vernietigingMatch = pad.match(/^\/vernietigingen\/([^/]+)$/);
  if (request.method === 'GET' && vernietigingMatch) {
    const vernietiging = vernietigingService.getVernietiging(vernietigingMatch[1]);

    if (!vernietiging) {
      throw new ResourceNotFoundError('VERNIETIGING_NOT_FOUND', 'Vernietiging niet gevonden.');
    }

    return antwoord(200, toVernietigingResponse(vernietiging));
  }

  const batchMatch = pad.match(/^\/vernietigingen\/([^/]+)\/batches$/);
  if (request.method === 'POST' && batchMatch) {
    const body = await readBody();
    const batchResultaat = vernietigingService.voegBatchToe(batchMatch[1], {
      batchNummer: body.batchNummer,
      vernietigingskandidaten: body.vernietigingskandidaten
    }, { idempotencyKey: request.headers['idempotency-key'] });

    return antwoord(202, toBatchResultaatResponse(batchResultaat));
  }

  if (request.method === 'GET' && batchMatch) {
    return antwoord(200, vernietigingService.getBatchResultaten(batchMatch[1]).map(toBatchResultaatResponse));
  }

  const specificatieMatch = pad.match(/^\/vernietigingen\/([^/]+)\/specificaties\/([^/]+)$/);
  if (request.method === 'GET' && specificatieMatch) {
    return { status: 200, xml: vernietigingService.getSpecificatie(specificatieMatch[1], decodeURIComponent(specificatieMatch[2])) };
  }

  const batchNummerMatch = pad.match(/^\/vernietigingen\/([^/]+)\/batches\/([^/]+)$/);
  if (request.method === 'GET' && batchNummerMatch) {
    // Een ongeldig batchnummer verwijst naar een batch die niet bestaat; de spec kent hier geen 400.
    const batchNummer = Number(batchNummerMatch[2]);

    if (!Number.isInteger(batchNummer) || batchNummer < 1) {
      throw new ResourceNotFoundError('BATCH_NOT_FOUND', `Batch ${batchNummerMatch[2]} niet gevonden.`);
    }

    return antwoord(200, toBatchResultaatResponse(vernietigingService.getBatchResultaat(batchNummerMatch[1], batchNummer)));
  }

  const vrijgevenMatch = pad.match(/^\/vernietigingen\/([^/]+)\/vrijgeven$/);
  if (request.method === 'POST' && vrijgevenMatch) {
    const body = await readBody();
    const vernietiging = await vernietigingService.vrijgeven(vrijgevenMatch[1], {
      aantalBatches: body.aantalBatches,
      aantalKandidaten: body.aantalKandidaten
    }, { idempotencyKey: request.headers['idempotency-key'] });

    return antwoord(202, toVernietigingResponse(vernietiging));
  }

  const selectieMatch = pad.match(/^\/selecties\/([^/]+)$/);
  if (request.method === 'GET' && selectieMatch) {
    const selectie = selectieService.getSelectie(selectieMatch[1]);

    if (!selectie) {
      throw new ResourceNotFoundError('SELECTIE_NOT_FOUND', 'Selectie niet gevonden.');
    }

    return antwoord(200, toSelectieResponse(selectie));
  }

  const kandidatenMatch = pad.match(/^\/selecties\/([^/]+)\/vernietigingskandidaten$/);
  if (request.method === 'GET' && kandidatenMatch) {
    const selectieId = kandidatenMatch[1];
    const cursor = url.searchParams.get('cursor');

    if (cursor !== null && url.searchParams.has('offset')) {
      throw new ValidationError('Gebruik offset of cursor, niet allebei.');
    }

    const pagina = selectieService.getKandidaten(selectieId, {
      offset: cursor !== null
        ? leesCursor(cursor, selectieId)
        : leesGeheelGetal(url.searchParams, 'offset', { standaard: 0, minimum: 0 }),
      limit: leesGeheelGetal(url.searchParams, 'limit', { standaard: 100, minimum: 1, maximum: MAX_LIMIT })
    });

    if (!pagina) {
      throw new ResourceNotFoundError('SELECTIE_NOT_FOUND', 'Selectie niet gevonden.');
    }

    const volgendeOffset = pagina.offset + pagina.items.length;

    return antwoord(200, toKandidatenPaginaResponse({
      ...pagina,
      ...(cursor !== null ? { cursor } : {}),
      // Altijd een nextCursor zolang er meer kandidaten zijn, ook bij offset-paginering.
      ...(volgendeOffset < pagina.totaal ? { nextCursor: maakCursor(selectieId, volgendeOffset) } : {})
    }));
  }

  throw new ResourceNotFoundError('NOT_FOUND', 'Endpoint niet gevonden.');
}

// Opake cursor: base64url van positie en selectieId. Een cursor van een andere selectie
// of een gemanipuleerde waarde wordt geweigerd.
function maakCursor(selectieId, offset) {
  return Buffer.from(JSON.stringify({ s: selectieId, o: offset })).toString('base64url');
}

function leesCursor(cursor, selectieId) {
  let inhoud;

  try {
    inhoud = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    inhoud = undefined;
  }

  if (!inhoud || inhoud.s !== selectieId || !Number.isInteger(inhoud.o) || inhoud.o < 0) {
    throw new ValidationError('cursor is ongeldig of hoort niet bij deze selectie.');
  }

  return inhoud.o;
}

function antwoord(status, payload) {
  return { status, payload };
}

function sendFout(response, request, correlatieId, error) {
  const logReference = `log-${crypto.randomUUID()}`;
  const fout = mapFout(error);

  // Technische logging: geen request-bodies of kandidaatgegevens, alleen kenmerken.
  const logregel = JSON.stringify({
    niveau: fout.status >= 500 ? 'error' : 'warn',
    logReference,
    correlatieId,
    methode: request.method,
    pad: request.url?.split('?')[0],
    status: fout.status,
    code: fout.code,
    ...(fout.status >= 500 ? { fout: error?.stack ?? String(error) } : {})
  });

  if (fout.status >= 500) {
    console.error(logregel);
  } else {
    console.warn(logregel);
  }

  if (error instanceof AuthFout) {
    response.setHeader('WWW-Authenticate', `Bearer error="${error.oauthError}"`);
  }

  return sendJson(response, fout.status, {
    code: fout.code,
    message: fout.message,
    ...(fout.details ? { details: fout.details } : {}),
    correlatieId,
    logReference
  });
}

function mapFout(error) {
  if (error instanceof AuthFout) {
    return { status: error.status, code: error.code, message: error.message };
  }

  if (error instanceof TransportScenarioFout) {
    return { status: error.status, code: error.code, message: error.message };
  }

  if (error instanceof SelectieNogNietGereedError) {
    return {
      status: 409,
      code: 'SELECTIE_NOT_READY',
      message: error.message,
      details: `selectieId=${error.selectieId}; status=${error.status}`
    };
  }

  if (error instanceof ValidationError) {
    return { status: 400, code: error.code, message: error.message };
  }

  if (error instanceof ResourceNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }

  if (error instanceof ConflictError) {
    return { status: 409, code: error.code, message: error.message };
  }

  // Interne meldingen blijven in de log; de client krijgt alleen de logReference.
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Onverwachte technische fout.' };
}

function leesCorrelatieId(request) {
  const waarde = request.headers['x-correlation-id'];

  if (typeof waarde !== 'string') {
    return undefined;
  }

  const getrimd = waarde.trim();
  return getrimd && getrimd.length <= MAX_CORRELATIE_ID_LENGTE && /^[\w.:@/-]+$/.test(getrimd) ? getrimd : undefined;
}

function leesGeheelGetal(searchParams, naam, { standaard, minimum, maximum = Number.MAX_SAFE_INTEGER }) {
  const ruw = searchParams.get(naam);

  if (ruw === null || ruw === '') {
    return standaard;
  }

  const waarde = Number(ruw);

  if (!Number.isInteger(waarde) || waarde < minimum || waarde > maximum) {
    const bereik = maximum === Number.MAX_SAFE_INTEGER ? `minimaal ${minimum}` : `tussen ${minimum} en ${maximum}`;
    throw new ValidationError(`${naam} moet een geheel getal ${bereik} zijn.`);
  }

  return waarde;
}

function sendXml(response, statusCode, xml) {
  response.writeHead(statusCode, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(xml)
  });
  response.end(xml);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let lengte = 0;
  let teGroot = false;

  // Bij een te grote body wordt de rest wel gelezen maar niet bewaard,
  // zodat de client het foutantwoord nog netjes ontvangt.
  for await (const chunk of request) {
    lengte += chunk.length;

    if (lengte > maxBodyBytes) {
      teGroot = true;
      continue;
    }

    chunks.push(chunk);
  }

  if (teGroot) {
    throw new ValidationError(`Request is groter dan ${maxBodyBytes} bytes.`, 'REQUEST_TOO_LARGE');
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();

  if (!rawBody) {
    return {};
  }

  let body;

  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ValidationError('Request body is geen geldige JSON.', 'INVALID_JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body moet een JSON-object zijn.');
  }

  return body;
}

const ENDPOINTS = [
  ['POST', /^\/selecties$/, 'POST /selecties'],
  ['GET', /^\/selecties\/[^/]+$/, 'GET /selecties/{selectieId}'],
  ['GET', /^\/selecties\/[^/]+\/vernietigingskandidaten$/, 'GET /selecties/{selectieId}/vernietigingskandidaten'],
  ['POST', /^\/vernietigingen$/, 'POST /vernietigingen'],
  ['GET', /^\/vernietigingen\/[^/]+$/, 'GET /vernietigingen/{vernietigingId}'],
  ['POST', /^\/vernietigingen\/[^/]+\/batches$/, 'POST /vernietigingen/{vernietigingId}/batches'],
  ['GET', /^\/vernietigingen\/[^/]+\/batches$/, 'GET /vernietigingen/{vernietigingId}/batches'],
  ['GET', /^\/vernietigingen\/[^/]+\/batches\/[^/]+$/, 'GET /vernietigingen/{vernietigingId}/batches/{batchNummer}'],
  ['POST', /^\/vernietigingen\/[^/]+\/vrijgeven$/, 'POST /vernietigingen/{vernietigingId}/vrijgeven'],
  ['GET', /^\/vernietigingen\/[^/]+\/specificaties\/[^/]+$/, 'GET /vernietigingen/{vernietigingId}/specificaties/{vernietigingskandidaatId}']
];

const TRANSPORT_FOUTCODES = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT'
};

class TransportScenarioFout extends Error {
  constructor(status) {
    super(`HTTP ${status} gesimuleerd via scenario-configuratie.`);
    this.status = status;
    this.code = TRANSPORT_FOUTCODES[status];
  }
}

function endpointVan(method, pathname) {
  return ENDPOINTS.find(([methode, patroon]) => methode === method && patroon.test(pathname))?.[2];
}

// De eerste N calls per endpoint en resource falen; daarna slaagt de call.
// Zo moet de Cockpit na N retries slagen, reproduceerbaar in CI.
function bepaalTransportFout(httpScenario, tellers, method, pathname, endpoint) {
  if (!endpoint || httpScenario.failFirstN === 0) {
    return undefined;
  }

  if (httpScenario.failEndpoints.length > 0 && !httpScenario.failEndpoints.includes(endpoint)) {
    return undefined;
  }

  const sleutel = `${method} ${pathname}`;
  const aantal = (tellers.get(sleutel) ?? 0) + 1;
  tellers.set(sleutel, aantal);

  return aantal <= httpScenario.failFirstN ? new TransportScenarioFout(httpScenario.failStatus) : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
