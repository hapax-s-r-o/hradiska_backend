# Vzhľad webu — backend (API)

Backend pre úpravu „prezentácie“ webu (dlaždice, sekcie domovskej, menu, päta, obrázky a popisy
kategórií) z administrácie. Plán je mimo repozitára (`hradiska-plan-uprava-webu-2026-10-17.md`),
toto je opis toho, čo je v BE naozaj postavené (fáza F1).

| súbor | čo je v ňom |
|---|---|
| `src/api/vzhlad-webu/typy.ts` | spoločná definícia údajov — **bajt po bajte rovnaká ako FE `src/lib/vzhlad/typy.ts`** (`scripts/vzhlad/porovnaj-typy.mjs`) |
| `src/api/vzhlad-webu/kontrola.ts` | kontrola údajov; čistý modul (importuje len `./typy`), kopíruje sa do FE |
| `src/api/vzhlad-webu/zlucenie.ts` | čo zverejnenie zapíše do existujúcich typov, trojcestné zlúčenie; čistý modul |
| `src/api/vzhlad-webu/pamat.ts` | verejná odpoveď v pamäti servera |
| `src/api/vzhlad-webu/services/vzhlad-webu.ts` | koncept, zverejnenie (transakcia), história, rozriešenie, použitie fotiek |
| `src/api/vzhlad-webu/controllers/vzhlad-webu.ts`, `routes/vzhlad.ts` | endpointy |
| `src/api/vzhlad-webu/chranene-subory.json` | chránené súbory starých verzií webu (generuje skript) |
| `src/extensions/upload/strapi-server.ts` | ochrana fotiek pred zmazaním |
| `src/api/blog-category/content-types/blog-category/lifecycles.ts` | zmena kategórie zmaže pamäť indexu, počtov a vzhľadu |
| `scripts/kontrola/vzhlad-api.mjs` | test kontraktu (plán 10.1) |
| `scripts/vzhlad/porovnaj-typy.mjs`, `scripts/vzhlad/chranene-subory.mjs` | pomocné skripty |

Existujúce schémy sa nemenili (len pridávanie, plán časť 3).

## Dátový model

Bez Strapi konceptov (`draftAndPublish: false`) a bez i18n — koncept, zverejnenie aj jazyky si typ rieši
výslovne (plán 4.1). Ani jeden typ nemá REST cesty ani verejné práva; všetko ide cez endpointy nižšie.
Oba typy sú **skryté v paneli Strapi** (`pluginOptions.content-manager.visible` a `content-type-builder.visible`
= `false`): ručná úprava JSON v paneli by obišla kontrolu údajov, súbeh aj históriu. Návrat na staršiu verziu
ide cez `POST /api/vzhlad-webu/obnovit/:verzia` a zverejnenie.

**`api::vzhlad-webu.vzhlad-webu`** (single type, tabuľka `vzhlad_webu`)

| pole | typ | význam |
|---|---|---|
| `koncept` | json | rozpracovaný vzhľad (`Vzhlad` alebo `null` = prázdny) |
| `zakladDb` | json | `ZakladDb`: hodnoty v DB, z ktorých koncept vychádza (trojcestné zlúčenie) |
| `zverejnene` | json | to, čo vidí web (`Vzhlad` alebo `null`) |
| `verziaKonceptu` | integer | +1 pri každom uložení konceptu (PUT, obnovenie) — kontrola súbehu |
| `verziaZverejnena` | integer | +1 pri každom zverejnení — `verzia` a ETag pre web |
| `konceptUpravil` / `konceptUpravene` | string / datetime | kto (username) a kedy naposledy uložil koncept |
| `zverejnilKto` / `zverejneneKedy` | string / datetime | kto a kedy zverejnil |

Riadok vznikne pri prvom zápise (nie pri štarte servera). Kým neexistuje, API sa správa ako pri prázdnom vzhľade.

**`api::vzhlad-webu-verzia.vzhlad-webu-verzia`** (kolekcia, tabuľka `vzhlad_webu_verzie`) — história:
`verzia` (int), `obsah` (json, zverejnený vzhľad), `zakladDb` (json), `zverejnil` (string), `zverejnene` (datetime),
`poznamka` (string ≤ 200). Uchováva sa **100 najnovších** (`LIMITY.historia`), staršie sa pri zverejnení zmažú.

## Endpointy

Všetky pod `/api`. Chyby majú tvar Strapi: `{ "data": null, "error": { "status", "name", "message", "details" } }`;
`details.kod` je strojovo čitateľný dôvod.

| metóda a cesta | kto | čo robí |
|---|---|---|
| `GET /vzhlad-webu` | verejné | `OdpovedVzhladu` (typy.ts) |
| `GET /vzhlad-webu/koncept` | redaktor | `OdpovedKonceptu` (typy.ts) |
| `PUT /vzhlad-webu/koncept` | redaktor | uloží koncept |
| `POST /vzhlad-webu/zverejnit` | redaktor | zverejní koncept |
| `GET /vzhlad-webu/historia` | redaktor | zoznam verzií bez obsahu |
| `GET /vzhlad-webu/historia/:verzia` | redaktor | jedna verzia celá + rozriešené odkazy |
| `POST /vzhlad-webu/obnovit/:verzia` | redaktor | verziu z histórie skopíruje do konceptu (nezverejní) |
| `GET /vzhlad-webu/pouzitie-suboru/:id` | redaktor | kde je súbor použitý a či sa dá zmazať |

### Kto je redaktor

- Rola `authenticated` (staff), ako všade v BE. Člen (rola `member`) dostane **403**, bez hlavičky `Authorization` **401**,
  neplatný token **401**.
- Práva na akcie (`api::vzhlad-webu.vzhlad-webu.koncept`, `ulozKoncept`, `zverejnit`, `historia`, `verziaHistorie`,
  `obnovit`, `pouzitieSuboru`) pridáva pri štarte `setupStaffUserPermissions` v `src/index.ts`, nie ručne v DB.
- Prečo vlastná stratégia v `routes/vzhlad.ts`: users-permissions berie požiadavku bez tokenu ako rolu Public
  a vrátil by 403. Malá stratégia pred ňou odmietne požiadavku bez hlavičky `Authorization` ako 401;
  token a právo na akciu potom overí users-permissions bežným spôsobom. Controller si rolu overí ešte raz.
- API tokeny Strapi (panel → API Tokens) na tieto cesty nefungujú (len prihlásenie redaktora).

### `GET /api/vzhlad-webu` (verejné)

```json
{ "data": { "schema": 1, "domov": { … }, … }, "verzia": 7,
  "subory":    { "6344": { "id": 6344, "url": "/uploads/…", "width": 1280, "height": 960, "alt": null,
                           "formats": { "small": { "url": "/uploads/small_…", "width": 500, "height": 375 } } } },
  "kategorie": { "<documentId>": { "slug": "refugia", "nazov": "Refugiá", "poradie": 40 } },
  "clanky":    { "<documentId>": { "sk": { "slug": "…", "nazov": "…", "obrazok": 1234 }, "en": { … }, "de": { … } } } }
```

- `subory`: každý obrázok, na ktorý vzhľad odkazuje číslom (`{ id }`, `domov.fotogaleria.fotky`), a titulné fotky článkov z `clanky`.
  `formats` len `thumbnail`/`small`/`medium`/`large`, ktoré súbor naozaj má.
- `kategorie`: **všetky** kategórie z DB (slug, názov a `order` práve teraz; `order` bez hodnoty = 100 ako v schéme).
- `clanky`: všetky články, na ktoré vzhľad odkazuje, v jazykoch, v ktorých sú **zverejnené** (chýbajúci jazyk = kľúč chýba).
- Bez zverejneného vzhľadu: `{ "data": null, "verzia": <verziaZverejnena>, "subory": {}, "kategorie": {}, "clanky": {} }`
  (pred prvým zverejnením `verzia: 0`; po zverejnení prázdneho vzhľadu číslo tej verzie).
- Hlavičky: `Cache-Control: public, max-age=30, stale-while-revalidate=300`,
  `ETag: "v<verzia>-<prvých 12 znakov sha1 tela>"` (napr. `"v7-3f2a9c01be44"`).
  `If-None-Match` so zhodou (aj slabá značka `W/"…"`, zoznam, `*`) → **304** bez tela.
  Odtlačok tela je v ETagu preto, že telo nesie aj aktuálne slugy a názvy článkov a kategórií: ich premenovanie
  dá nový ETag aj bez nového zverejnenia. Klient má posielať späť presne ETag, ktorý dostal (holé `"v7"` sa nezhoduje).
- Odpoveď je v pamäti servera. Platí len pre verziu, ktorú má DB práve teraz (jeden malý dopyt pri každej požiadavke),
  a zmaže sa pri zverejnení a pri zmene článku, kategórie alebo súboru (lifecycles).

### `GET /api/vzhlad-webu/koncept`

`OdpovedKonceptu`: `koncept`, `zakladDb`, `zverejnene`, `verziaKonceptu`, `verziaZverejnena`, `konceptUpravil`,
`konceptUpravene`, `zverejnilKto`, `zverejneneKedy`, `db` (aktuálne hodnoty v DB v tvare `ZakladDb`) a rozriešené
`subory`/`kategorie`/`clanky` pre koncept aj zverejnené spolu. Zoznam rozdielov koncept ↔ zverejnené server nepočíta
(typy.ts ho nemá) — editor ho má z `koncept` a `zverejnene`.

### `PUT /api/vzhlad-webu/koncept`

Telo `{ "zaklad": <verziaKonceptu, z ktorej úprava vychádza>, "data": <Vzhlad | null>, "zakladDb": <ZakladDb> }`.

- `zakladDb` je povinné, keď `data` nie je `null`. Editor ho berie z `db` pri načítaní konceptu (alebo zo `zakladDb`
  odpovede zverejnenia) a posiela ho späť nezmenené.
- `data: null` = prázdny koncept (zverejnením sa web vráti na základný vzhľad — návrat podľa plánu, krok D5).
- **400** `neplatne-udaje`, `details.chyby: ChybaVzhladu[]` — kontrola tvaru aj odkazov (nižšie). Cesty chýb sú
  relatívne k vzhľadu (`domov.dlazdice.skupiny[1].polozky[0].kategoria`), chyby tela dopytu majú `zaklad`,
  `zakladDb…`, `data` alebo `telo.<kľúč>`.
- **409** `koncept-zmeneny`, keď `zaklad ≠ verziaKonceptu`: `details` = `{ verziaKonceptu, koncept, zakladDb,
  konceptUpravil, konceptUpravene }` (aktuálny koncept, kto a kedy ho uložil). Porovnanie a zápis sú jeden príkaz
  (`UPDATE … WHERE verziaKonceptu = zaklad`), takže ani dve súbežné uloženia neprejdú obe.
- **200** `{ verziaKonceptu, konceptUpravil, konceptUpravene }`.

### `POST /api/vzhlad-webu/zverejnit`

Telo `{ "zaklad": <verziaKonceptu>, "poznamka"?: "Nové obrázky kategórií" }` (poznámka ≤ 200 znakov, bez `< >`).

V **jednej transakcii** (`strapi.db.transaction`):

1. `zaklad ≠ verziaKonceptu` → 409 `koncept-zmeneny` (ako pri PUT).
2. Koncept znova prejde kontrolou tvaru aj odkazov (od uloženia mohla zmiznúť kategória, článok alebo fotka) → 400.
3. Trojcestné zlúčenie so `zakladDb` (nižšie). Konflikt → **409** `konflikt-db`, `details.konflikty: [{ cesta, druh,
   kategoria?, zaklad, koncept, db, sprava }]`, `details.db` = DB teraz. Nezapíše sa nič.
4. Ak predošlý zverejnený stav v histórii chýba (bežne nie, poistka po obnove DB), doplní sa.
5. Nová verzia do histórie (`obsah` = koncept, `zverejnil`, `zverejnene`, `poznamka`, `zakladDb`).
6. Zápisy do existujúcich typov (Document Service, teda s validáciou schémy a lifecycles):
   - `menu.poradie` (len keď nie je prázdne) → `blog-category.order` = 10, 20, 30 … podľa poradia;
   - `kategorie[].nazov.sk` (len keď `nazov` nie je `null`) → `blog-category.name`;
   - `domov.fotogaleria.fotky` (len keď `fotogaleria` nie je `null`) → `domovska-galeria.fotky` v tomto poradí.
   - Slug kategórie sa nemení nikdy.
7. `zverejnene = koncept`, `verziaZverejnena + 1`, kto, kedy; `zakladDb` konceptu sa nastaví na hodnoty v DB po
   zápisoch (koncept je s DB zladený — ďalšie zverejnenie neprepíše, čo medzitým zmení niekto iný).
   `verziaKonceptu` sa nemení.
8. Orezanie histórie na 100 verzií.

Potom sa zmaže pamäť vzhľadu, indexu a počtov. **200** `{ verziaZverejnena, verziaKonceptu, zverejnilKto,
zverejneneKedy, zakladDb, zapisy, doplnenaPredoslaVerzia }`, kde `zapisy` sú vykonané zápisy z kroku 6
(`{ druh: 'poradie'|'nazov'|'fotogaleria', kategoria?, z, na }`).

**Trojcestné zlúčenie** — pre každé pole zvlášť (poradie každej kategórie, názov každej kategórie, výber galérie);
`zaklad` = `zakladDb`, `koncept` = čo chce koncept, `db` = DB teraz:

| prípad | výsledok |
|---|---|
| koncept = zaklad | koncept pole nemení → nezapisuje sa (aj keď DB medzitým zmenil niekto iný) |
| db = koncept | DB už má cieľovú hodnotu → nezapisuje sa, nie je to konflikt |
| db = zaklad | zapíše sa koncept |
| inak (aj keď pole v `zakladDb` chýba) | **konflikt** → 409, nezapíše sa nič |

Názvy sa porovnávajú v tvare NFC (rovnaký názov v inom zápise diakritiky nie je zmena).

**Transakcie (zistené a overené testom):** Document Service aj `strapi.db.query` si transakciu berú z AsyncLocalStorage
(`transactionCtx` v `@strapi/database`; Document Service každú operáciu balí do `strapi.db.transaction`, ktorá sa vo
vnútri vonkajšej len pripojí). Volania vnútri `strapi.db.transaction(async () => …)` teda do transakcie patria bez
odovzdávania `trx`. Overenie: test vyvolá chybu po všetkých zápisoch (história, kategórie, galéria, riadok vzhľadu)
a skontroluje, že v DB nezostalo nič; s vypnutou transakciou (skúšobná úprava kódu) tie isté kontroly zlyhajú.
Na SQLite má knex jediné spojenie — volanie mimo transakcie by čakalo na jej koniec až do limitu 60 s, takže
zverejnenie za desiatky milisekúnd je zároveň dôkaz, že nič neuteklo mimo nej.

**Skúšobná chyba (len test):** keď server beží mimo produkcie (`NODE_ENV !== 'production'`) a so
`VZHLAD_SKUSOBNA_CHYBA=1`, zverejnenie s poznámkou `__skusobna-chyba__` po všetkých zápisoch spadne (500
`skusobna-chyba`, `details.zapisov`). V produkcii to nevyvolá nič — test v produkčnom režime overuje, že taká
poznámka sa normálne zverejní.

### `GET /api/vzhlad-webu/historia`, `GET /api/vzhlad-webu/historia/:verzia`

- Zoznam: `{ "verzie": [ { "verzia", "zverejnil", "zverejnene", "poznamka" } ] }`, najnovšia prvá. Prvá položka je
  aktuálne zverejnená verzia (do histórie sa ukladá každé zverejnenie hneď).
- Jedna verzia: `{ verzia, obsah, zakladDb, zverejnil, zverejnene, poznamka, subory, kategorie, clanky }`; neexistuje → 404.

### `POST /api/vzhlad-webu/obnovit/:verzia`

Telo voliteľne `{ "zaklad": <verziaKonceptu> }` (keď je, nesúlad → 409 `koncept-zmeneny`). Skopíruje `obsah` verzie
do konceptu, `zakladDb` = DB teraz (obnovená verzia tak pri zverejnení vráti aj svoje poradie, názvy a galériu ako
zámernú zmenu), `verziaKonceptu + 1`. Web sa nezmení. Obsah sa pri obnovení nekontroluje proti DB (môže odkazovať
na zmazanú kategóriu — editor ju ukáže a zverejnenie ju nepustí). **200** `{ verziaKonceptu, obnovenaVerzia,
konceptUpravil, konceptUpravene }`; neexistujúca verzia → 404.

### `GET /api/vzhlad-webu/pouzitie-suboru/:id`

```json
{ "id": 6344, "subor": { "id": 6344, "name": "…", "url": "/uploads/…", "mime": "image/jpeg" },
  "miesta": [ { "zdroj": "koncept", "cesta": "kategorie[0].obrazok" },
              { "zdroj": "historia", "verzia": 5, "cesta": "domov.fotogaleria.fotky[2]" } ],
  "chraneny": false, "mozeSaZmazat": false }
```

`zdroj` je `koncept`, `zverejnene` alebo `historia` (posledných 10 verzií). Súbor sa nájde podľa `id` aj podľa mena
v ceste `{ cesta: "/uploads/…" }` (originál aj zmenšeniny z `formats`). Neexistujúci súbor → 404.

## Kontrola údajov (`kontrola.ts`)

`skontrolujTvar(v)` (bez DB) a `skontrolujOdkazy(v, { kategorie, clanky, subory })` (proti DB) vrátia `ChybaVzhladu[]`
— všetky chyby naraz (najviac 200), správy po slovensky. Pravidlá:

- `schema` musí byť 1; nepoznaný kľúč kdekoľvek je chyba; povinné polia a typy podľa `typy.ts`.
- Texty: `sk` povinná (nie prázdna) všade, kde je typ `Text`; dĺžky z `LIMITY` (popisok dlaždice a menu 40, názov 100,
  nadpis 120, popis 500, citát a nadpis prosby 200, úvod a text prosby 1000, e-mail 120, adresa 500); **žiadne `<` ani `>`**
  a žiadne riadiace znaky (nový riadok je povolený) — platí aj pre `en`, `de`, `enZo`, `deZo`.
- Počty: skupín dlaždíc 1–4, dlaždíc v skupine 1–12, riadkov článkov ≤ 8, článkov v riadku ≤ 8 a `pocet` 1–8,
  pripnutých ≤ 8, populárnych ≤ 6, fotiek galérie ≤ 12, stĺpcov päty ≤ 4, odkazov v stĺpci ≤ 12, prosieb ≤ 6,
  sietí ≤ 12, sekcií ≤ 12.
- Id (`VZOR_ID`) jedinečné v rámci druhu: skupiny, dlaždice (naprieč skupinami), sekcie, riadky článkov, stĺpce päty.
- Sekcie: len typy z `TYPY_SEKCII`, každý najviac raz okrem `dalsi-obsah`. Činnosť: každý `KlucCinnosti` práve raz.
- Bez opakovania: kategória vo `kategorie`, v `menu.*`; článok v jednom zozname (pripnuté, riadok); fotka v galérii;
  iný obrázok pre ten istý článok v riadku.
- Menu: keď `poradie` nie je prázdne, `hlavnyRiadok` aj `skryte` musia byť v ňom; kategória nesmie byť naraz v hlavnom
  riadku aj skrytá; (proti DB) `poradie` musí obsahovať **každú** kategóriu z DB.
- Obrázok: `{ id }` (kladné celé číslo) alebo `{ cesta }` podľa `VZOR_CESTY_OBRAZKA`, `pozicia` len „50% 40%“ (0–100 %).
- Odkazy: cesta webu podľa `VZOR_CESTY` a navyše nie `//…` (prehliadač by to bral ako iný web); inak len `https://…`
  (platná adresa bez mena a hesla) alebo `mailto:…`; sieť `email` len `mailto:`, ostatné siete len `https://`.
- Proti DB: každá kategória (documentId) existuje; každý článok existuje a je **zverejnený v slovenčine**; každé `id`
  súboru existuje a je obrázok (`mime image/*`); na serveri musí mať každý odkaz `dokument` (documentId), slug nestačí.

`skontrolujZakladDb(z)` kontroluje tvar `zakladDb`, `zbierajOdkazy(v)` vráti všetky odkazy na kategórie, články a obrázky
s cestou k poľu.

## Ochrana fotiek (`src/extensions/upload/strapi-server.ts`)

`DELETE /api/upload/files/:id` (content API — tým maže administrácia webu) vráti **409** `subor-pouzity` s vysvetlením
po slovensky a s `details` z `pouzitie-suboru`, ak je súbor

- použitý vo vzhľade: koncept, zverejnené, posledných 10 verzií histórie, alebo
- na zozname chránených súborov starých verzií webu a appky (`chranene-subory.json`).

Inak (aj neexistujúci súbor) pokračuje pôvodná akcia bez zmeny; nahrávanie, zoznam a úprava údajov o súbore sa nemenia.

- **Zoznam chránených** generuje `node scripts/vzhlad/chranene-subory.mjs [cesta-k-FE]` zo všetkých ciest `/uploads/…`
  v FE `src/data/categories.ts`, `src/data/cinnost.ts`, `src/design-lab/LabAktuality.tsx`, `src/components/ArticleCard.tsx`
  (bez komentárov) plus ich varianty `thumbnail_`, `small_`, `medium_`, `large_`. Mená sa len pridávajú (staré verzie
  ich používajú ďalej). Porovnáva sa podľa mena súboru v `url` aj vo `formats`.
- **Panel Strapi (`/admin`) maže cez iné API a ochranu obíde.** Fotky mazať len v administrácii webu.
- Nechránená ostáva aj výmena obsahu súboru (`POST /api/upload?id=<id>` so súborom) — mení adresu súboru.
  Administrácia webu ju nepoužíva (posiela len údaje o súbore), plán ju nerieši.

## Lifecycle kategórie a pamäť

- `blog-category` (create, update, delete aj hromadné): zmaže pamäť vyhľadávacieho indexu a počtov (`invalidateSearchIndex`)
  a verejnú odpoveď vzhľadu. Premenovaná kategória je v indexe, počtoch aj vzhľade hneď.
- `blog-post` (existujúci lifecycle) navyše maže pamäť vzhľadu; `plugin::upload.file` (update, delete) tiež
  (subscribe v `src/index.ts`).

## Testy a skripty

Lokálne, proti kópii DB, Strapi na porte 1337 s `ENV_PATH=.env.lokalne-vzhlad` (pošta a push vypnuté). Nikdy nie
proti ostrému serveru — test to aj sám odmietne (beží len proti `127.0.0.1`/`localhost`).

```sh
# vývojový režim (so skúšobnou chybou na overenie transakcie)
VZHLAD_SKUSOBNA_CHYBA=1 ENV_PATH=.env.lokalne-vzhlad node node_modules/@strapi/strapi/bin/strapi.js develop
node scripts/kontrola/vzhlad-api.mjs --rezim=vyvoj

# produkčný režim (po `ENV_PATH=.env.lokalne-vzhlad NODE_ENV=production npx strapi build`; potom zmazať dist/build/uploads)
ENV_PATH=.env.lokalne-vzhlad NODE_ENV=production node node_modules/@strapi/strapi/bin/strapi.js start
node scripts/kontrola/vzhlad-api.mjs --rezim=produkcia

node scripts/vzhlad/porovnaj-typy.mjs        # typy.ts BE = FE, inak exit 1
node scripts/vzhlad/chranene-subory.mjs      # pregenerovať zoznam chránených súborov
```

`vzhlad-api.mjs` pokrýva plán 10.1: verejný GET (prázdny, tvar, rozriešené fotky, ETag, 304, nový ETag po premenovaní kategórie), 401/403/200 na všetkých
redaktorských cestách, každé pravidlo kontroly (400 s cestou k poľu), súbeh (aj dve súbežné uloženia), zverejnenie
(história, `order` 10/20/…, `name`, `domovska-galeria`, verejný GET, index), atomickosť (vo vývojovom režime), trojcestné
zlúčenie (konflikt aj nekonfliktné vetvy), obnovenie, ochranu fotiek (použitá v koncepte / zverejnenom / histórii,
chránená, nepoužitá; nahrávanie a mazanie ako doteraz), lifecycle kategórie, poistku histórie a zverejnenie prázdneho
vzhľadu. Výsledok počtom „prešlo N z N“, priebežne aj do `.tmp/vzhlad-api-vysledok.txt`.

Tokeny si test vyrobí rovnako ako `users-permissions` `jwt.issue({ id })` (JWT_SECRET z env súboru) a nikam ich nevypisuje.
Na konci vráti DB do stavu pred testom a overí to: kategórie (názov, slug, poradie aj časové značky), domovská galéria
(aj riadky väzby), riadok vzhľadu a jeho história, skúšobné súbory zmazané. Priamo do DB zapisuje len pri tomto návrate
(a raz počas testu zmaže riadok histórie, aby overil poistku) — inak všetko ide cez API.
