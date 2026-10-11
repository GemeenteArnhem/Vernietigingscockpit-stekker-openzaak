import crypto from 'node:crypto';

// Client voor de ZGW-API's van Open Zaak (Zaken, Documenten, Besluiten, Catalogi) en de
// openbare Selectielijst API. Naar Open Archiefbeheer (clients.py, zaken/tasks.py):
// ZGW-JWT per verzoek, `Accept-Crs` op de Zaken API, paginering via `next`, herhaalpogingen
// op GET bij tijdelijke fouten. DELETE wordt niet herhaald door de client: de
// vernietigingsservice herhaalt de hele stap, met het journaal als geheugen.
//
// Het token gaat alleen naar de ingestelde API-roots. Een URL uit een antwoord (`next`, een
// documentverwijzing) buiten die roots wordt geweigerd, zodat het token nooit naar een andere
// host lekt en de stekker nooit iets buiten Open Zaak verwijdert.

const TIJDELIJKE_STATUSSEN = new Set([429, 502, 503, 504]);

export class ZgwFout extends Error {
  constructor(message, { status = 0, code = 'ZGW_FOUT', methode, url, invalidParams = [] } = {}) {
    super(message);
    this.name = 'ZgwFout';
    this.status = status;
    this.code = code;
    this.methode = methode;
    this.url = url;
    this.invalidParams = invalidParams;
  }

  get tijdelijk() {
    return this.status === 0 || TIJDELIJKE_STATUSSEN.has(this.status);
  }
}

export class ZgwClient {
  // diensten: { zaken, documenten, besluiten, catalogi, selectielijst } met elk een API-root
  // (eindigend op '/'). De Selectielijst API is openbaar en krijgt geen token.
  constructor({
    diensten,
    clientId,
    secret,
    gebruiker = 'vernietigingscockpit-stekker',
    timeoutMs = 30000,
    maxPogingen = 3,
    wachttijdMs = 500,
    fetchImpl = globalThis.fetch,
    klok = () => new Date()
  }) {
    this.diensten = Object.entries(diensten)
      .filter(([, root]) => root)
      .map(([naam, root]) => ({ naam, root: normaliseerRoot(root) }))
      // Langste root eerst, zodat geneste roots bij de juiste dienst horen.
      .sort((a, b) => b.root.length - a.root.length);
    this.clientId = clientId;
    this.secret = secret;
    this.gebruiker = gebruiker;
    this.timeoutMs = timeoutMs;
    this.maxPogingen = Math.max(1, maxPogingen);
    this.wachttijdMs = wachttijdMs;
    this.fetch = fetchImpl;
    this.klok = klok;
  }

  // Volledige URL voor een pad binnen een dienst, bijv. url('zaken', 'zaken', { archiefnominatie: 'vernietigen' }).
  url(dienst, pad, params) {
    const gevonden = this.diensten.find((item) => item.naam === dienst);

    if (!gevonden) {
      throw new ZgwFout(`Dienst ${dienst} is niet ingesteld.`, { code: 'DIENST_ONBEKEND' });
    }

    return metParams(new URL(pad, gevonden.root).toString(), params);
  }

  async get(url, { params } = {}) {
    const { body } = await this.verzoek('GET', metParams(url, params));
    return body;
  }

  // Alle resultaten van een lijst-endpoint. Gepagineerde antwoorden ({ count, next, results })
  // worden pagina voor pagina gevolgd; ongepagineerde endpoints geven direct een array.
  async *resultaten(url, { params } = {}) {
    let volgende = metParams(url, params);

    while (volgende) {
      const pagina = await this.get(volgende);

      if (Array.isArray(pagina)) {
        yield* pagina;
        return;
      }

      yield* pagina.results ?? [];
      volgende = pagina.next || undefined;
    }
  }

  async alle(url, opties) {
    const lijst = [];

    for await (const item of this.resultaten(url, opties)) {
      lijst.push(item);
    }

    return lijst;
  }

  // Verwijdert een resource. Uitkomst zoals Open Archiefbeheer (_delete_resource):
  // 'verwijderd' (204), 'niet-gevonden' (404: al weg) of 'pending-relations' (400: de
  // resource hoort nog bij iets anders en blijft bestaan). Elke andere fout gooit een ZgwFout.
  //
  // Bij een serverfout, time-out of verbroken verbinding is onduidelijk of de DELETE is gelukt.
  // Open Zaak 1.30.0 geeft bijvoorbeeld een 500 nádat een zaak al is verwijderd (fout bij het
  // herberekenen van de ETag). Dan wordt de resource opgevraagd: een 404 betekent verwijderd.
  async verwijder(url) {
    try {
      await this.verzoek('DELETE', url);
      return 'verwijderd';
    } catch (error) {
      if (error instanceof ZgwFout && error.status === 404) {
        return 'niet-gevonden';
      }

      if (error instanceof ZgwFout && error.status === 400
        && error.invalidParams.some((param) => param.code === 'pending-relations')) {
        return 'pending-relations';
      }

      if (error instanceof ZgwFout && (error.status === 0 || error.status >= 500) && await this.isWeg(url)) {
        return 'verwijderd';
      }

      throw error;
    }
  }

  async isWeg(url) {
    try {
      await this.verzoek('GET', url);
      return false;
    } catch (error) {
      return error instanceof ZgwFout && error.status === 404;
    }
  }

  async verzoek(methode, url) {
    const dienst = this.dienstVoor(url);
    const pogingen = methode === 'GET' ? this.maxPogingen : 1;
    let laatsteFout;

    for (let poging = 1; poging <= pogingen; poging += 1) {
      try {
        return await this.eenVerzoek(methode, url, dienst);
      } catch (error) {
        laatsteFout = error;

        if (!(error instanceof ZgwFout) || !error.tijdelijk || poging === pogingen) {
          throw error;
        }

        if (this.wachttijdMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.wachttijdMs * 2 ** (poging - 1)));
        }
      }
    }

    throw laatsteFout;
  }

  async eenVerzoek(methode, url, dienst) {
    const headers = { Accept: 'application/json' };

    if (dienst !== 'selectielijst') {
      headers.Authorization = `Bearer ${this.token()}`;
    }

    // De Zaken API eist Accept-Crs bij resources met geometrie (zaakgeometrie).
    if (dienst === 'zaken') {
      headers['Accept-Crs'] = 'EPSG:4326';
    }

    const zonderQuery = url.split('?')[0];
    let response;

    try {
      response = await this.fetch(url, { method: methode, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ZgwFout(
        `${methode} ${zonderQuery}: ${timeout ? `geen antwoord binnen ${this.timeoutMs} ms` : 'verbinding mislukt'}.`,
        { status: 0, code: timeout ? 'TIMEOUT' : 'NETWERKFOUT', methode, url: zonderQuery }
      );
    }

    if (response.status === 204) {
      return { status: 204, body: undefined };
    }

    const tekst = await response.text();
    const body = leesJson(tekst);

    if (!response.ok) {
      const detail = body?.detail || body?.title || '';
      throw new ZgwFout(
        `${methode} ${zonderQuery}: HTTP ${response.status}${body?.code ? ` ${body.code}` : ''}${detail ? ` – ${detail}` : ''}.`,
        {
          status: response.status,
          code: body?.code || `HTTP_${response.status}`,
          methode,
          url: zonderQuery,
          invalidParams: Array.isArray(body?.invalidParams) ? body.invalidParams : []
        }
      );
    }

    if (body === undefined && tekst.trim() !== '') {
      throw new ZgwFout(`${methode} ${zonderQuery}: antwoord is geen JSON.`, { status: response.status, code: 'GEEN_JSON', methode, url: zonderQuery });
    }

    return { status: response.status, body };
  }

  dienstVoor(url) {
    let doel;

    try {
      doel = new URL(url);
    } catch {
      throw new ZgwFout(`Ongeldige URL: ${url}`, { code: 'ONGELDIGE_URL' });
    }

    const gevonden = this.diensten.find(({ root }) => doel.toString().startsWith(root));

    if (!gevonden) {
      throw new ZgwFout(`URL valt buiten de ingestelde Open Zaak-API's: ${doel.origin}${doel.pathname}`, {
        code: 'ONBEKENDE_URL',
        url: `${doel.origin}${doel.pathname}`
      });
    }

    return gevonden.naam;
  }

  token() {
    return maakZgwToken({ clientId: this.clientId, secret: this.secret, gebruiker: this.gebruiker, nu: this.klok() });
  }
}

// ZGW-autorisatie: een zelf ondertekend JWT (HS256) met client-id en secret uit Open Zaak.
export function maakZgwToken({ clientId, secret, gebruiker = clientId, nu = new Date() }) {
  const kop = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const inhoud = base64url(JSON.stringify({
    iss: clientId,
    iat: Math.floor(nu.getTime() / 1000),
    client_id: clientId,
    user_id: gebruiker,
    user_representation: gebruiker
  }));
  const handtekening = crypto.createHmac('sha256', secret).update(`${kop}.${inhoud}`).digest('base64url');
  return `${kop}.${inhoud}.${handtekening}`;
}

// Het laatste padsegment van een ZGW-URL is de UUID van de resource.
export function uuidUitUrl(url) {
  return new URL(url).pathname.split('/').filter(Boolean).at(-1);
}

function normaliseerRoot(root) {
  const url = new URL(root);
  return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
}

function metParams(url, params) {
  if (!params) {
    return url;
  }

  const doel = new URL(url);

  for (const [sleutel, waarde] of Object.entries(params)) {
    if (waarde !== undefined && waarde !== null) {
      doel.searchParams.set(sleutel, String(waarde));
    }
  }

  return doel.toString();
}

function leesJson(tekst) {
  if (!tekst) {
    return undefined;
  }

  try {
    return JSON.parse(tekst);
  } catch {
    return undefined;
  }
}

function base64url(tekst) {
  return Buffer.from(tekst).toString('base64url');
}
