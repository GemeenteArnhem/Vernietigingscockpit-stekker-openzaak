# Vernietigingscockpit stekker Open Zaak

Stekker voor de Vernietigingscockpit met **Open Zaak** als bron. De stekker implementeert **Stekker API v2.0.0** (`spec/stekker-openapi-spec-v2.0.0.yaml`, kopie uit de architectuurrepo `Vernietigingscockpit`, `designrules/api/stekker-openapi-spec.yaml`); MDTO is leidend (ADR-0005), identiteit en momentopname volgen ADR-0007.

De selectie- en vernietigingslogica volgt [Open Archiefbeheer](https://github.com/maykinmedia/open-archiefbeheer) (Maykin Media, EUPL-1.2), opnieuw geschreven in JavaScript. Analyse en besluiten: `D:\Werk\Cockpit review\analyse-openzaak-stekker.md` (B-OZ1 t/m B-OZ4).

> **Stand:** de stekker werkt tegen een echte Open Zaak 1.30.0 (`npm run test:openzaak`) en tegen een nagebootste Open Zaak (`npm test`), en draait in de Cockpit-acceptatieomgeving (`Vernietigingscockpit-code/infrastructure/acceptatie`, taakdefinitie *Zaken OpenZaak*).

## Opbouw

```text
src/
  api/                    HTTP-laag (Stekker API v2), JWT-controle, response-mapping
  application/            selectie- en vernietigingsservice, idempotentie, bron-poort (bron.js)
  config/                 stekker-, MDTO-, scenario- en auth-configuratie
  domain/                 statussen, MDTO-XML-specificatie, technische sleutel
  infrastructure/
    openzaak/             bron Open Zaak (volgt)
    repositories/         opslag op het runtime-volume: selecties, vernietigingen, journaal, idempotency-keys
test/
  helpers/geheugen-bron.js  bron in het geheugen met zaken, documenten, besluiten en gedeelde documenten
```

De services kennen alleen de **bron-poort** (`src/application/bron.js`):

| Functie | Doet |
| --- | --- |
| `selecteer({ peildatum, leverNietV })` | levert MDTO-kandidaten, elk met een momentopname van zijn onderdelen |
| `controleer(kandidaat)` | vlak vóór vernietigen: staat de zaak er nog precies zo? Anders `NOT_FOUND` of `CHANGED` (`ONDERDELEN_GEWIJZIGD`) |
| `vernietig(kandidaat, { journaal, clock })` | verwijdert onderdelen en daarna de zaak; legt elke stap vast in het journaal |

## Vernietiging per kandidaat

1. Hoort de technische sleutel niet bij de kandidaat: `FAILED` / `BRONID_MISMATCH`, er gebeurt niets.
2. Staat de kandidaat in het journaal als klaar (hervatting na een crash): `SUCCESS` met het oorspronkelijke tijdstip.
3. Nog niets gedaan: `controleer`. Wijkt de zaak af van de momentopname, dan `NOT_FOUND` of `CHANGED` en wordt niets vernietigd. Is er al wel iets gedaan (hervatting), dan wordt de controle overgeslagen: de bron zou zijn eigen verwijderingen als wijziging zien.
4. `vernietig`, met maximaal `VERNIETIGING_MAX_POGINGEN` pogingen en oplopende wachttijd. Het journaal zorgt dat een nieuwe poging verdergaat waar de vorige stopte.
5. Lukt het niet (B-OZ3): `FAILED` met `DEELS_VERNIETIGD` als er al onderdelen weg zijn (met de lijst in de foutmelding), anders `VERNIETIGING_MISLUKT`.

Een onderdeel dat ook bij een ander object hoort, wordt **ontkoppeld** en niet vernietigd; de kandidaat is dan gewoon `SUCCESS` (B-OZ2). De MDTO-specificatie noemt alle onderdelen in `bevatOnderdeel` en meldt de ontkoppelde in `eventResultaat`. Besluiten en besluitdocumenten tellen als onderdeel (B-OZ4).

Het journaal staat op het runtime-volume: `runtime/journaal/{vernietigingId}/{hash van kandidaat-id}.jsonl`, één JSON-regel per stap, met `datasync`.

## Selectie

`OpenZaakBron.selecteer` (`src/infrastructure/openzaak/openzaak-bron.js`, mapping in `mapping.js`):

1. Haalt alle zaken op met `einddatum__isnull=false` en `archiefactiedatum__lt` = dag na de peildatum, met `expand=resultaat,resultaat.resultaattype,zaaktype`. Bewust zonder filter op archiefnominatie.
2. Slaat over: archiefstatus `overgedragen`; zaken buiten `OPENZAAK_ZAAKTYPEN` (als ingesteld); `blijvend_bewaren` (behalve met `SCENARIO_LEVER_NIET_V`).
3. **Waarschuwing, niet geselecteerd:** zaak zonder archiefnominatie; zaak zonder selectielijstklasse (op de zaak of het resultaattype); selectielijstklasse waarvan het procestype geen jaar heeft (dan is er geen selectielijstcode, ADR-0008).
4. Per kandidaat (hooguit `OPENZAAK_PARALLEL` tegelijk) de **onderdelen**: documenten via zaakinformatieobjecten, besluiten, en documenten van die besluiten via besluitinformatieobjecten; een document dat via meer wegen aan de zaak hangt telt één keer. Die lijst (met URL's) is de **momentopname** (ADR-0007, DR-04).
5. Hoofdzaak, deelzaken en relevante andere zaken komen als `gerelateerdInformatieobject` ("Refereert aan") bij de kandidaat; elke zaak blijft een eigen kandidaat.

Een fout van Open Zaak of de Selectielijst API laat de hele selectie mislukken (`FAILED`); de Cockpit kan opnieuw selecteren.

| MDTO | Open Zaak |
| --- | --- |
| `vernietigingskandidaatId` | `vk-<zaak-uuid>` |
| `identificatie` | zaak-URL (technische sleutel) en zaaknummer `identificatie` |
| `naam` / `omschrijving` | `omschrijving` (anders zaaknummer) / `toelichting` |
| `aggregatieniveau` | `Dossier` |
| `classificatie` | zaaktype (omschrijving, identificatie; catalogus-URL als begrippenlijst) |
| `dekkingInTijd` | `Looptijd`: `startdatum` – `einddatum` |
| `waardering` | `archiefnominatie`: `vernietigen` = V, `blijvend_bewaren` = B |
| `bewaartermijn` | trigger = `brondatumArchiefprocedure.afleidingswijze` (Cockpit-termijntriggers), start = `startdatumBewaartermijn`, looptijd = `archiefactietermijn`, einddatum = `archiefactiedatum` |
| `informatiecategorie` | selectielijstklasse: `volledigNummer` – `naam`; selectielijst van het procestype-jaar met selectielijstcode `GEM-<jaar>` en bron `Cockpit-selectielijsten` (ADR-0008) |
| `activiteit` | naam van het selectielijst-procestype |
| `aantalObjecten` | aantal onderdelen (documenten + besluiten + besluitdocumenten) |
| `aantalBetrokkenen` | aantal rollen |

## Vernietiging in Open Zaak

**Controle vlak vóór vernietigen** (`OpenZaakBron.controleer`, alleen als er voor de kandidaat nog niets is gebeurd):

| Situatie | Resultaat | Foutcode |
| --- | --- | --- |
| zaak bestaat niet meer | `NOT_FOUND` | `NOT_FOUND` |
| archiefstatus nu `overgedragen` | `CHANGED` | `OVERGEDRAGEN` |
| archiefnominatie gewijzigd | `CHANGED` | `ARCHIEFNOMINATIE_GEWIJZIGD` |
| archiefactiedatum gewijzigd | `CHANGED` | `ARCHIEFACTIEDATUM_GEWIJZIGD` |
| archiefactiedatum ligt na vandaag (bijv. selectie met peildatum in de toekomst) | `SKIPPED` | `NOG_NIET_VERNIETIGBAAR` |
| er hangt nog een deelzaak aan de zaak (Open Zaak zou die stil meeverwijderen) | `SKIPPED` | `DEELZAKEN_AANWEZIG` |
| document of besluit bijgekomen of verdwenen | `CHANGED` | `ONDERDELEN_GEWIJZIGD` |

Een andere omschrijving of status van de zaak houdt de vernietiging niet tegen.

**Volgorde** (`OpenZaakBron.vernietig`, naar Open Archiefbeheer `_delete_destruction_list_item`), alles op basis van de momentopname:

1. besluitinformatieobjecten;
2. besluiten (`pending-relations` = ontkoppeld);
3. zaakinformatieobjecten;
4. documenten (`pending-relations` = ontkoppeld: het document hoort nog bij iets anders en blijft bestaan);
5. vangnet: hangt er nu een document, besluit of deelzaak aan de zaak dat niet in de momentopname stond, dan stopt het hier (`DEELS_VERNIETIGD`);
6. de zaak (Open Zaak ruimt rollen, statussen, resultaat en zaakobjecten op).

Binnen een batch verwerkt de stekker eerst de zaken zonder deelzaken en dan de hoofdzaken; zijn hoofdzaak en deelzaak samen vrijgegeven, dan lukt het in één keer. De resultaten staan in de volgorde van de batch.

Elke stap staat in het journaal voordat de volgende begint; een herhaalde aanroep slaat afgeronde stappen over en `404` telt als al weg. Vóór het verwijderen van de zaak staat er een startregel in het journaal; gaat het antwoord verloren, dan geeft de nieuwe poging `404` en geldt het tijdstip van de startregel als `eventTijd`. Externe registers (Objecten API) doen nog niet mee.

Afwijkend van OAB: OAB slaat bij zaakinformatieobjecten de URL van de koppeling op als 'te verwijderen document' (en onder een andere `resource_type`), waardoor documenten die alleen via de zaak gekoppeld zijn niet verwijderd lijken te worden. De stekker gebruikt de document-URL uit de momentopname.

## Rechten in Open Zaak

De stekker heeft een eigen applicatie in Open Zaak (Autorisaties), zonder 'alle autorisaties':

| Component | Scopes | Per |
| --- | --- | --- |
| Zaken (`zrc`) | `zaken.lezen`, `zaken.verwijderen`, **`zaken.geforceerd-bijwerken`** | zaaktype, max. vertrouwelijkheid `zeer_geheim` |
| Documenten (`drc`) | `documenten.lezen`, `documenten.verwijderen` | informatieobjecttype, max. vertrouwelijkheid `zeer_geheim` |
| Besluiten (`brc`) | `besluiten.lezen`, `besluiten.verwijderen` | besluittype |
| Catalogi (`ztc`) | `catalogi.lezen` | |

`zaken.geforceerd-bijwerken` is nodig omdat Open Zaak elke wijziging aan een **gesloten** zaak weigert zonder die scope, ook het verwijderen van koppelingen en besluiten (`403` "Je mag geen gegevens aanpassen van een gesloten zaak"). Een te lage maximale vertrouwelijkheid laat zaken stil uit de selectie vallen.

## Echte Open Zaak (lokaal en in de integratietest)

`compose.openzaak.yaml` start Open Zaak **1.30.0** met PostGIS en Redis; `openzaak-init` zet de inloggegevens van het seed-account (alle rechten) en de stekker klaar. `scripts/seed-openzaak.mjs` vult Open Zaak via de gewone API's: catalogus, zaaktype (selectielijst 2020, P7Y, afleidingswijze `afgehandeld`), het voorbeeld ZAAK-2018-0042 (drie documenten, besluit met besluitbrief, D2 gedeeld met ZAAK-2019-0107), randgevallen (blijvend bewaren, zonder nominatie, overgedragen, hoofdzaak met deelzaak) en `--aantal` gewone zaken; daarna de applicatie van de stekker via de Autorisaties API. Zaken worden afgesloten met een eindstatus in 2018; Open Zaak berekent zelf de archiefactiedatum (2025-06-30).

```powershell
npm run test:openzaak          # lege Open Zaak, seed, test/integratie, opruimen (OPENZAAK_BEHOUD=1 laat hem staan)
```

Zelf ontwikkelen: zet `OPENZAAK_DB_WACHTWOORD`, `OPENZAAK_SECRET_KEY`, `OPENZAAK_ADMIN_WACHTWOORD`, `OPENZAAK_SEED_SECRET` en `OPENZAAK_SECRET` (willekeurig) in `.env.openzaak` (niet in git) en:

```powershell
docker compose -f compose.openzaak.yaml --env-file .env.openzaak -p stekker-openzaak-dev up -d
```

Beheer: `http://localhost:8490/admin/` (gebruiker `admin`).

**Gedrag van Open Zaak 1.30.0** (getoetst; de nagebootste Open Zaak volgt dit):

- filters: `archiefactiedatum__lt` bestaat, `__lte` niet; een onbekende queryparameter geeft `400`;
- een URL met een hostnaam zonder punt (bijv. `http://openzaak:8000/...`) is voor Open Zaak geen geldige URL, ook niet in een filter: geef Open Zaak in Docker een volledige naam (de acceptatieomgeving gebruikt de alias `openzaak.acceptatie.local`);
- DELETE van een zaak met besluiten: `400` `related-besluiten`;
- DELETE van een besluit met besluitinformatieobjecten: `500`;
- DELETE van een document met nog een koppeling: `400 pending-relations`;
- DELETE van een zaak ruimt koppelingen, rollen en resultaat op; de documenten blijven als losse documenten staan;
- DELETE van een hoofdzaak verwijdert ook de deelzaken, zonder eigen log of controle;
- DELETE van een gesloten zaak geeft een `500` nádat de zaak al is verwijderd (fout bij het herberekenen van de ETag). De client vraagt na een serverfout de resource op; `404` telt als verwijderd.

## Verbinding met Open Zaak

`src/infrastructure/openzaak/zgw-client.js`, naar Open Archiefbeheer (`clients.py`, `zaken/tasks.py`):

- elk verzoek krijgt een vers ZGW-JWT (HS256 met client-id en secret; `iss`, `client_id`, `iat`, `user_id`); de Selectielijst API krijgt geen token;
- GET's op de Zaken API krijgen `Accept-Crs: EPSG:4326`;
- lijsten worden pagina voor pagina gevolgd via `next`; ZIO- en BIO-lijsten zijn arrays;
- GET wordt herhaald bij 429, 502, 503, 504, time-out en netwerkfout (oplopende wachttijd); DELETE niet: de vernietigingsservice herhaalt de hele stap met het journaal;
- DELETE-uitkomst zoals OAB: `204` = verwijderd, `404` = al weg, `400 pending-relations` = blijft bestaan (hoort nog bij iets anders), anders een fout;
- het token gaat **alleen** naar de ingestelde API-roots: een URL uit een antwoord (`next`, een documentverwijzing) naar een andere host of API wordt geweigerd (`ONBEKENDE_URL`);
- foutmeldingen bevatten methode, pad (zonder query) en de ZGW-foutcode, nooit headers of tokens.

Tests draaien tegen een nagebootste Open Zaak (`test/helpers/nep-openzaak.js`): Zaken, Documenten, Besluiten, Catalogi en Selectielijst in het geheugen, met paginering, `expand`, JWT-controle, `pending-relations` en instelbare storingen. Aannames die nog tegen een echte Open Zaak getoetst worden staan bovenin dat bestand.

## Configuratie

| Variabele | Standaard |
| --- | --- |
| `PORT` | `3000` |
| `STEKKER_NAAM` | `OpenZaak-stekker` |
| `STEKKER_CONFIGURATIEVERSIE` | `openzaak-2026-10-10` |
| `STEKKER_DATASOURCE_NAME` | `openzaak` |
| `STEKKER_DEFAULT_PEILDATUM` | de dag waarop de selectie start |
| `STEKKER_RUNTIME_SELECTIES_PATH` / `_VERNIETIGINGEN_PATH` / `_JOURNAAL_PATH` / `_IDEMPOTENCY_PATH` / `_LOCK_PATH` | onder `runtime/` |
| `SELECTIE_PROCESSING_DELAY_MS` | `100` (`0` = synchroon, alleen voor tests) |
| `VERNIETIGING_PROCESSING_DELAY_MS` | `100` (pauze vóór elke batch; `0` = synchroon) |
| `VERNIETIGING_MAX_POGINGEN` | `3` |
| `VERNIETIGING_WACHTTIJD_POGING_MS` | `2000` (verdubbelt per poging) |
| `MAX_BODY_BYTES` | `1048576` |
| `LOG_REQUESTS` | `true` |
| `OPENZAAK_ZAKEN_URL`, `_DOCUMENTEN_URL`, `_BESLUITEN_URL`, `_CATALOGI_URL` | verplicht; API-roots, bijv. `http://openzaak:8000/zaken/api/v1/` |
| `OPENZAAK_CLIENT_ID`, `OPENZAAK_SECRET` | verplicht; applicatie in Open Zaak (ZGW-JWT, HS256) |
| `SELECTIELIJST_URL` | `https://selectielijst.openzaak.nl/api/v1/` (openbaar, geen token) |
| `OPENZAAK_TIMEOUT_MS` | `30000` per verzoek |
| `OPENZAAK_PARALLEL` | `8` gelijktijdige verzoeken bij het ophalen van onderdelen |
| `OPENZAAK_GET_POGINGEN` | `3` pogingen per GET bij 429/502/503/504, time-out of netwerkfout |
| `OPENZAAK_ZAAKTYPEN` | leeg = alle; anders kommagescheiden zaaktype-identificaties |
| `STEKKER_ARCHIEFVORMER` | `Gemeente Voorbeeld` |
| `STEKKER_IDENTIFICATIEBRON_TECHNISCH` | `Open Zaak Zaken API (zaak-URL)` |
| `STEKKER_IDENTIFICATIEBRON_KENMERK` | `Zaaknummering gemeente Voorbeeld` |
| `STEKKER_IDENTIFICATIEBRON_DOCUMENT` | `Documentnummering gemeente Voorbeeld` |
| `STEKKER_IDENTIFICATIEBRON_BESLUIT` | `Besluitnummering gemeente Voorbeeld` |
| `STEKKER_VERNIETIGINGSMETHODE` | `Verwijderd via bronfunctie` |
| `STEKKER_VERNIETIGINGSMETHODE_TOELICHTING` | toelichting over de DELETE-endpoints, zonder back-ups en audittrail |

Authenticatie (`AUTH_ENABLED`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`), scenario's voor foutpaden (`SCENARIO_*`), Idempotency-Key, foutafhandeling, runtime-lock en Traefik-compose werken zoals in de teststekker (`Vernietigingscockpit-stekker-test`, README); de instellingen staan in `.env.example`.

## Lokaal draaien

```powershell
npm ci
npm test
npm run test:contract
npm start
```
