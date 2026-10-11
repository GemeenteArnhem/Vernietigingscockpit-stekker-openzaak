import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

// Nagebootste Open Zaak voor tests: de delen van de Zaken, Documenten, Besluiten en Catalogi
// API (en de Selectielijst API) die de stekker gebruikt, in het geheugen. Volgt het gedrag dat
// Open Archiefbeheer verwacht: gepagineerde lijsten met `next`, `expand` met `_expand`,
// ZIO- en BIO-lijsten als array, `400 pending-relations` voor een document of besluit dat nog
// ergens aan hangt, en `404` voor wat al weg is.
//
// Gedrag getoetst tegen Open Zaak 1.30.0 (npm run test:openzaak):
// - DELETE van een zaak met besluiten geeft `400` met code `related-besluiten`;
// - DELETE van een besluit met besluitinformatieobjecten geeft een `500` (fout in Open Zaak);
// - DELETE van een document met nog een koppeling geeft `400 pending-relations`;
// - DELETE van een zaak ruimt zaakinformatieobjecten, rollen en resultaat op (de documenten
//   blijven als losse documenten staan) en verwijdert ook de deelzaken, zonder controle;
// - DELETE van een gesloten zaak geeft na het verwijderen een `500` (ETag-fout); dat bootst
//   een test na met `storing({ naUitvoeren: true })`.

export const CLIENT_ID = 'stekker-test';
export const SECRET = 'nep-openzaak-geheim-voor-tests';

const ROOTS = {
  zaken: '/zaken/api/v1/',
  documenten: '/documenten/api/v1/',
  besluiten: '/besluiten/api/v1/',
  catalogi: '/catalogi/api/v1/',
  selectielijst: '/selectielijst/api/v1/'
};

export class NepOpenZaak {
  constructor({ paginaGrootte = 100, clientId = CLIENT_ID, secret = SECRET } = {}) {
    this.paginaGrootte = paginaGrootte;
    this.clientId = clientId;
    this.secret = secret;
    this.tabellen = {
      zaken: new Map(),
      zaaktypen: new Map(),
      resultaattypen: new Map(),
      resultaten: new Map(),
      rollen: new Map(),
      zaakinformatieobjecten: new Map(),
      zaakobjecten: new Map(),
      enkelvoudiginformatieobjecten: new Map(),
      besluiten: new Map(),
      besluitinformatieobjecten: new Map(),
      procestypen: new Map(),
      selectielijstresultaten: new Map()
    };
    this.storingen = [];
    this.log = [];
    this.vertragingMs = 0;
    this.volgnummer = 0;
  }

  async start() {
    this.server = http.createServer((request, response) => {
      this.behandel(request, response).catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'error', detail: error.message }));
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.basis = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get diensten() {
    return Object.fromEntries(Object.entries(ROOTS).map(([naam, pad]) => [naam, `${this.basis}${pad}`]));
  }

  // --- Testgegevens ---

  // Zaaktype met resultaattype en selectielijstkoppeling; geeft de URL's terug.
  maakZaaktype({
    identificatie = 'WMO-AANVRAAG',
    omschrijving = 'Aanvraag Wmo-voorziening',
    archiefnominatie = 'vernietigen',
    archiefactietermijn = 'P7Y',
    afleidingswijze = 'afgehandeld'
  } = {}) {
    const procestype = this.voeg('procestypen', 'selectielijst', 'procestypen', {
      nummer: 7,
      jaar: 2020,
      naam: 'Verstrekken van een voorziening'
    });
    const selectielijstklasse = this.voeg('selectielijstresultaten', 'selectielijst', 'resultaten', {
      procesType: procestype.url,
      nummer: 2,
      volledigNummer: '7.1.2',
      naam: 'Toegekend',
      waardering: archiefnominatie === 'vernietigen' ? 'vernietigen' : 'blijvend_bewaren',
      bewaartermijn: archiefactietermijn
    });
    const zaaktype = this.voeg('zaaktypen', 'catalogi', 'zaaktypen', {
      identificatie,
      omschrijving,
      catalogus: `${this.diensten.catalogi}catalogussen/00000000-0000-4000-8000-000000000001`,
      selectielijstProcestype: procestype.url
    });
    const resultaattype = this.voeg('resultaattypen', 'catalogi', 'resultaattypen', {
      zaaktype: zaaktype.url,
      omschrijving: 'Toegekend',
      archiefnominatie,
      archiefactietermijn,
      selectielijstklasse: selectielijstklasse.url,
      brondatumArchiefprocedure: { afleidingswijze, datumkenmerk: '', einddatumBekend: false, objecttype: '', registratie: '', procestermijn: null }
    });

    return { zaaktype: zaaktype.url, resultaattype: resultaattype.url, selectielijstklasse: selectielijstklasse.url, procestype: procestype.url };
  }

  // Zaak met documenten en besluiten; geeft de URL's terug. `documenten` en `besluiten` zijn
  // aantallen of lijsten met titels; een besluit kan eigen documenten hebben.
  voegZaakToe({
    identificatie,
    omschrijving = `Aanvraag traplift ${identificatie}`,
    zaaktype,
    archiefnominatie = 'vernietigen',
    archiefstatus = 'nog_te_archiveren',
    startdatum = '2018-01-15',
    einddatum = '2018-06-30',
    archiefactiedatum = '2025-07-01',
    startdatumBewaartermijn = '2018-07-01',
    documenten = 2,
    besluiten = [],
    rollen = 1
  }) {
    const typen = zaaktype ?? this.standaardZaaktype ?? (this.standaardZaaktype = this.maakZaaktype());
    const zaak = this.voeg('zaken', 'zaken', 'zaken', {
      identificatie,
      bronorganisatie: '002220647',
      omschrijving,
      zaaktype: typen.zaaktype,
      startdatum,
      einddatum,
      archiefnominatie,
      archiefstatus,
      archiefactiedatum,
      startdatumBewaartermijn,
      selectielijstklasse: typen.selectielijstklasse,
      hoofdzaak: null,
      deelzaken: [],
      relevanteAndereZaken: [],
      rollen: [],
      resultaat: null
    });
    const resultaat = this.voeg('resultaten', 'zaken', 'resultaten', { zaak: zaak.url, resultaattype: typen.resultaattype, toelichting: '' });
    zaak.resultaat = resultaat.url;

    for (let index = 0; index < rollen; index += 1) {
      const rol = this.voeg('rollen', 'zaken', 'rollen', { zaak: zaak.url, betrokkeneType: 'natuurlijk_persoon', roltoelichting: 'Aanvrager' });
      zaak.rollen.push(rol.url);
    }

    const titels = Array.isArray(documenten) ? documenten : Array.from({ length: documenten }, (_, index) => `Document ${index + 1}`);
    const documentUrls = titels.map((titel, index) => {
      const document = this.maakDocument({ identificatie: `${identificatie}-D${index + 1}`, titel });
      this.koppelDocument(zaak.url, document);
      return document;
    });
    const besluitUrls = besluiten.map((besluit, index) => {
      const nieuw = this.voeg('besluiten', 'besluiten', 'besluiten', {
        identificatie: `${identificatie}-B${index + 1}`,
        verantwoordelijkeOrganisatie: '002220647',
        besluittype: `${this.diensten.catalogi}besluittypen/00000000-0000-4000-8000-000000000002`,
        zaak: zaak.url,
        datum: einddatum
      });
      const besluitDocumenten = (besluit.documenten ?? []).map((titel, documentIndex) => {
        const document = this.maakDocument({ identificatie: `${identificatie}-B${index + 1}-D${documentIndex + 1}`, titel });
        this.voeg('besluitinformatieobjecten', 'besluiten', 'besluitinformatieobjecten', { besluit: nieuw.url, informatieobject: document });
        return document;
      });
      return { besluit: nieuw.url, documenten: besluitDocumenten };
    });

    return { zaak: zaak.url, documenten: documentUrls, besluiten: besluitUrls };
  }

  maakDocument({ identificatie, titel }) {
    return this.voeg('enkelvoudiginformatieobjecten', 'documenten', 'enkelvoudiginformatieobjecten', {
      identificatie,
      bronorganisatie: '002220647',
      titel,
      informatieobjecttype: `${this.diensten.catalogi}informatieobjecttypen/00000000-0000-4000-8000-000000000003`
    }).url;
  }

  koppelDocument(zaakUrl, documentUrl) {
    return this.voeg('zaakinformatieobjecten', 'zaken', 'zaakinformatieobjecten', { zaak: zaakUrl, informatieobject: documentUrl }).url;
  }

  wijzigZaak(zaakUrl, velden) {
    Object.assign(this.vind('zaken', zaakUrl), velden);
  }

  bestaat(url) {
    return Object.values(this.tabellen).some((tabel) => tabel.has(url));
  }

  // Laat de eerstvolgende `keer` verzoeken die passen bij methode en pad falen met `status`.
  // Met `naUitvoeren` wordt het verzoek wél uitgevoerd en gaat alleen het antwoord 'verloren'.
  storing({ methode, pad, status = 503, keer = 1, body, naUitvoeren = false }) {
    this.storingen.push({ methode, pad, status, keer, body, naUitvoeren });
  }

  // --- HTTP ---

  async behandel(request, response) {
    const url = new URL(request.url, this.basis);
    this.log.push(`${request.method} ${url.pathname}`);

    if (this.vertragingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.vertragingMs));
    }

    const stuur = (status, body, headers = {}) => {
      if (response.destroyed) {
        return;
      }

      response.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };

    const storing = this.storingen.find((item) => item.keer > 0
      && (!item.methode || item.methode === request.method)
      && (!item.pad || item.pad.test(url.pathname)));

    if (storing) {
      storing.keer -= 1;

      if (storing.naUitvoeren) {
        await this.voerUit(request, url, () => {});
      }

      return stuur(storing.status, storing.body ?? { code: 'storing', detail: 'Gesimuleerde storing.' });
    }

    return this.voerUit(request, url, stuur);
  }

  async voerUit(request, url, stuur) {
    const fout = (status, code, detail, invalidParams = []) => stuur(status, { type: '', code, title: detail, status, detail, instance: '', invalidParams }, { 'content-type': 'application/problem+json' });

    const dienst = Object.entries(ROOTS).find(([, root]) => url.pathname.startsWith(root))?.[0];

    if (!dienst) {
      return fout(404, 'not_found', 'Onbekend pad.');
    }

    if (dienst !== 'selectielijst') {
      const autorisatie = this.controleerToken(request.headers.authorization);

      if (autorisatie) {
        return fout(403, autorisatie, 'Niet geautoriseerd.');
      }
    }

    if (dienst === 'zaken' && request.method === 'GET' && !request.headers['accept-crs']) {
      return fout(412, 'missing-accept-crs-header', 'Accept-Crs header ontbreekt.');
    }

    const [resource, uuid, ...rest] = url.pathname.slice(ROOTS[dienst].length).split('/').filter(Boolean);

    if (rest.length > 0) {
      return fout(404, 'not_found', 'Onbekend pad.');
    }

    const tabel = tabelVoor(dienst, resource);

    if (!tabel) {
      return fout(404, 'not_found', 'Onbekende resource.');
    }

    if (!uuid) {
      if (request.method !== 'GET') {
        return fout(405, 'method_not_allowed', 'Methode niet toegestaan.');
      }

      return stuur(200, this.lijst(tabel, url));
    }

    const itemUrl = `${this.basis}${url.pathname}`;
    const item = this.tabellen[tabel].get(itemUrl);

    if (!item) {
      return fout(404, 'not_found', 'Niet gevonden.');
    }

    if (request.method === 'GET') {
      return stuur(200, this.metExpand(tabel, item, url.searchParams.get('expand')));
    }

    if (request.method === 'DELETE') {
      const blokkade = this.blokkadeBijVerwijderen(tabel, item);

      if (blokkade?.status === 500) {
        return fout(500, 'error', 'Internal Server Error');
      }

      if (blokkade) {
        return fout(400, 'invalid', 'Kan niet verwijderen.', [{ name: 'nonFieldErrors', code: blokkade.code, reason: blokkade.reden }]);
      }

      this.verwijder(tabel, item);
      return stuur(204);
    }

    return fout(405, 'method_not_allowed', 'Methode niet toegestaan.');
  }

  lijst(tabel, url) {
    const params = url.searchParams;
    const items = [...this.tabellen[tabel].values()].filter((item) => voldoet(tabel, item, params));

    // Zoals Open Zaak: ZIO- en BIO-lijsten zijn niet gepagineerd.
    if (tabel === 'zaakinformatieobjecten' || tabel === 'besluitinformatieobjecten' || tabel === 'procestypen') {
      return items;
    }

    const pagina = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
    const start = (pagina - 1) * this.paginaGrootte;
    const deel = items.slice(start, start + this.paginaGrootte);
    const volgende = new URL(url);
    volgende.searchParams.set('page', String(pagina + 1));

    return {
      count: items.length,
      next: start + this.paginaGrootte < items.length ? `${this.basis}${volgende.pathname}${volgende.search}` : null,
      previous: null,
      results: deel.map((item) => this.metExpand(tabel, item, params.get('expand')))
    };
  }

  metExpand(tabel, item, expand) {
    if (tabel !== 'zaken' || !expand) {
      return structuredClone(item);
    }

    const velden = new Set(expand.split(','));
    const _expand = {};

    if (velden.has('zaaktype')) {
      _expand.zaaktype = structuredClone(this.tabellen.zaaktypen.get(item.zaaktype));
    }

    if (velden.has('resultaat') && item.resultaat) {
      const resultaat = structuredClone(this.tabellen.resultaten.get(item.resultaat));

      if (velden.has('resultaat.resultaattype')) {
        resultaat._expand = { resultaattype: structuredClone(this.tabellen.resultaattypen.get(resultaat.resultaattype)) };
      }

      _expand.resultaat = resultaat;
    }

    if (velden.has('rollen')) {
      _expand.rollen = item.rollen.map((rol) => structuredClone(this.tabellen.rollen.get(rol)));
    }

    return { ...structuredClone(item), _expand };
  }

  blokkadeBijVerwijderen(tabel, item) {
    const verwijzingen = (naar, veld, waarde) => [...this.tabellen[naar].values()].some((ander) => ander[veld] === waarde);

    if (tabel === 'enkelvoudiginformatieobjecten'
      && (verwijzingen('zaakinformatieobjecten', 'informatieobject', item.url) || verwijzingen('besluitinformatieobjecten', 'informatieobject', item.url))) {
      return { code: 'pending-relations', reden: 'Alle relaties met dit document moeten verbroken worden voor je het document zelf mag verwijderen.' };
    }

    if (tabel === 'besluiten' && verwijzingen('besluitinformatieobjecten', 'besluit', item.url)) {
      return { status: 500 };
    }

    if (tabel === 'zaken' && verwijzingen('besluiten', 'zaak', item.url)) {
      return { code: 'related-besluiten', reden: 'De zaak heeft (een) gerelateerd besluit(en).' };
    }

    return undefined;
  }

  verwijder(tabel, item) {
    this.tabellen[tabel].delete(item.url);

    if (tabel === 'zaken') {
      // Deelzaken gaan stil mee, zoals in Open Zaak.
      for (const deelzaak of [...this.tabellen.zaken.values()].filter((zaak) => zaak.hoofdzaak === item.url)) {
        this.verwijder('zaken', deelzaak);
      }

      if (item.hoofdzaak && this.tabellen.zaken.has(item.hoofdzaak)) {
        const hoofdzaak = this.tabellen.zaken.get(item.hoofdzaak);
        hoofdzaak.deelzaken = hoofdzaak.deelzaken.filter((url) => url !== item.url);
      }

      for (const afhankelijk of ['zaakinformatieobjecten', 'rollen', 'resultaten', 'zaakobjecten']) {
        for (const [url, ander] of this.tabellen[afhankelijk]) {
          if (ander.zaak === item.url) {
            this.tabellen[afhankelijk].delete(url);
          }
        }
      }
    }
  }

  controleerToken(autorisatie) {
    const token = /^Bearer (.+)$/.exec(autorisatie ?? '')?.[1];

    if (!token) {
      return 'not_authenticated';
    }

    const [kop, inhoud, handtekening] = token.split('.');

    try {
      const header = JSON.parse(Buffer.from(kop, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(inhoud, 'base64url').toString());
      const verwacht = crypto.createHmac('sha256', this.secret).update(`${kop}.${inhoud}`).digest('base64url');

      if (header.alg !== 'HS256' || handtekening !== verwacht || claims.client_id !== this.clientId || !Number.isInteger(claims.iat)) {
        return 'permission_denied';
      }

      this.laatsteClaims = claims;
      return undefined;
    } catch {
      return 'permission_denied';
    }
  }

  voeg(tabel, dienst, resource, velden) {
    this.volgnummer += 1;
    const uuid = `00000000-0000-4000-8000-${String(this.volgnummer).padStart(12, '0')}`;
    const item = { url: `${this.diensten[dienst]}${resource}/${uuid}`, uuid, ...velden };
    this.tabellen[tabel].set(item.url, item);
    return item;
  }

  vind(tabel, url) {
    const item = this.tabellen[tabel].get(url);

    if (!item) {
      throw new Error(`${tabel}: ${url} bestaat niet.`);
    }

    return item;
  }
}

function tabelVoor(dienst, resource) {
  const tabellen = {
    zaken: ['zaken', 'resultaten', 'rollen', 'zaakinformatieobjecten', 'zaakobjecten'],
    documenten: ['enkelvoudiginformatieobjecten'],
    besluiten: ['besluiten', 'besluitinformatieobjecten'],
    catalogi: ['zaaktypen', 'resultaattypen'],
    selectielijst: ['procestypen']
  };

  if (dienst === 'selectielijst' && resource === 'resultaten') {
    return 'selectielijstresultaten';
  }

  return tabellen[dienst]?.includes(resource) ? resource : undefined;
}

// Filters zoals de stekker (en OAB) ze gebruikt; onbekende parameters worden genegeerd.
function voldoet(tabel, item, params) {
  for (const [sleutel, waarde] of params) {
    if (sleutel === 'page' || sleutel === 'expand') {
      continue;
    }

    if (sleutel === 'zaak' || sleutel === 'besluit' || sleutel === 'archiefnominatie' || sleutel === 'archiefstatus' || sleutel === 'zaaktype') {
      if (item[sleutel] !== waarde) {
        return false;
      }
    } else if (sleutel === 'einddatum__isnull') {
      if ((item.einddatum === null || item.einddatum === undefined) !== (waarde === 'true')) {
        return false;
      }
    } else if (sleutel === 'archiefactiedatum__lte') {
      if (!item.archiefactiedatum || item.archiefactiedatum > waarde) {
        return false;
      }
    } else if (sleutel === 'archiefactiedatum__lt') {
      if (!item.archiefactiedatum || item.archiefactiedatum >= waarde) {
        return false;
      }
    }
  }

  return tabel !== undefined;
}
