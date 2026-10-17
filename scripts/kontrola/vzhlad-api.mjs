#!/usr/bin/env node
/**
 * TEST KONTRAKTU API „vzhľad webu“ (plán úpravy webu, časť 10.1).
 *
 * Beží proti LOKÁLNEMU Strapi (kópia ostrej DB) a mení v ňom údaje: ukladá a zverejňuje
 * vzhľad, prepisuje poradie a názvy kategórií, domovskú galériu, nahráva a maže skúšobné
 * súbory. Na konci všetko vráti do stavu pred testom a overí to (aj priamo v DB).
 *
 * Spustenie (z koreňa BE, Strapi beží na 1337 s ENV_PATH=.env.lokalne-vzhlad):
 *   node scripts/kontrola/vzhlad-api.mjs --rezim=vyvoj       # Strapi v develop s VZHLAD_SKUSOBNA_CHYBA=1
 *   node scripts/kontrola/vzhlad-api.mjs --rezim=produkcia   # Strapi s NODE_ENV=production
 * Voľby: --url=http://127.0.0.1:1337  --env=.env.lokalne-vzhlad  --vystup=.tmp/vzhlad-api-vysledok.txt
 *
 * Tokeny redaktora a člena si test vyrobí sám rovnako ako `users-permissions` `jwt.issue({ id })`
 * (jsonwebtoken + JWT_SECRET z env súboru). Nikam ich nevypisuje; mená ani e-maily účtov tiež nie.
 * Priamo do DB zapisuje test len pri upratovaní (riadok vzhľadu a jeho história, časové značky
 * kategórií a galérie, riadky väzby galérie — len návrat na pôvodné hodnoty) — inak všetko cez API.
 * Raz počas testu zmaže riadok histórie, aby overil poistku „predošlý stav sa do histórie doplní“.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

/* ───────────── nastavenie ───────────── */

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARG = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? '1'] : [a, '1'];
  }),
);
const URL_API = (ARG.url || 'http://127.0.0.1:1337').replace(/\/$/, '');
const REZIM = ARG.rezim || 'vyvoj';
const ENV_SUBOR = path.resolve(KOREN, ARG.env || '.env.lokalne-vzhlad');
const VYSTUP = path.resolve(KOREN, ARG.vystup || '.tmp/vzhlad-api-vysledok.txt');

if (!['vyvoj', 'produkcia'].includes(REZIM)) {
  console.error('--rezim musí byť vyvoj alebo produkcia');
  process.exit(2);
}
// Test mení údaje — nikdy nie proti inému než lokálnemu serveru.
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_API)) {
  console.error(`Test smie bežať len proti lokálnemu serveru (dostal som ${URL_API}).`);
  process.exit(2);
}
if (!fs.existsSync(ENV_SUBOR)) {
  console.error(`Chýba env súbor ${ENV_SUBOR}`);
  process.exit(2);
}
const ENV = dotenv.parse(fs.readFileSync(ENV_SUBOR));
if (!ENV.JWT_SECRET) {
  console.error('V env súbore chýba JWT_SECRET.');
  process.exit(2);
}
const DB_CESTA = path.resolve(KOREN, ENV.DATABASE_FILENAME || '.tmp/data.db');

fs.mkdirSync(path.dirname(VYSTUP), { recursive: true });
fs.writeFileSync(VYSTUP, `Test kontraktu API vzhľadu webu — ${new Date().toISOString()} — režim ${REZIM} — ${URL_API}\n`);
const log = (s) => {
  console.log(s);
  fs.appendFileSync(VYSTUP, s + '\n');
};

let pocet = 0;
let preslo = 0;
const zlyhane = [];
function over(nazov, ok, detail = '') {
  pocet++;
  if (ok) {
    preslo++;
    log(`  ok    ${nazov}`);
  } else {
    zlyhane.push(nazov);
    log(`  CHYBA ${nazov}${detail ? ` — ${detail}` : ''}`);
  }
  return !!ok;
}
const sekcia = (s) => log(`\n## ${s}`);

/** Porovnanie bez ohľadu na poradie kľúčov. */
const stabilne = (x) =>
  JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const rovnake = (a, b) => stabilne(a) === stabilne(b);
const kopia = (x) => JSON.parse(JSON.stringify(x));

/* ───────────── DB (čítanie) a tokeny ───────────── */

const dbr = new Database(DB_CESTA, { readonly: true, fileMustExist: true });
dbr.pragma('busy_timeout = 5000');
const tabulkaExistuje = (t) => !!dbr.prepare("select 1 from sqlite_master where type='table' and name=?").get(t);

const ucty = dbr
  .prepare(
    `select u.id, r.type from up_users u
     join up_users_role_lnk l on l.user_id = u.id join up_roles r on r.id = l.role_id
     where coalesce(u.blocked, 0) = 0 and coalesce(u.confirmed, 0) = 1 order by u.id`,
  )
  .all();
const redaktori = ucty.filter((u) => u.type === 'authenticated');
const clen = ucty.find((u) => u.type === 'member');
if (!redaktori.length || !clen) {
  console.error('V DB chýba potvrdený redaktor (rola authenticated) alebo člen (rola member).');
  process.exit(2);
}
// Rovnako ako users-permissions `jwt.issue({ id })` (predvolené jwtOptions = expiresIn 30d; tu stačí hodina).
const token = (id) => jwt.sign({ id }, ENV.JWT_SECRET, { expiresIn: '1h' });
const R1 = token(redaktori[0].id);
const R2 = token((redaktori[1] || redaktori[0]).id);
const CLEN = token(clen.id);

/* ───────────── HTTP ───────────── */

async function api(metoda, cesta, { tok, telo, hlavicky = {} } = {}) {
  const h = { ...hlavicky };
  if (tok) h.Authorization = `Bearer ${tok}`;
  let body;
  if (telo instanceof FormData) body = telo;
  else if (telo !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(telo);
  }
  const t0 = Date.now();
  const r = await fetch(URL_API + cesta, { method: metoda, headers: h, body });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: r.status, json, text, h: r.headers, ms: Date.now() - t0 };
}
const V = '/api/vzhlad-webu';
const koncept = async () => (await api('GET', `${V}/koncept`, { tok: R1 })).json;
const verejny = async () => api('GET', V);
const chybyZ = (r) => r.json?.error?.details?.chyby || [];
const kod = (r) => r.json?.error?.details?.kod;

/* ───────────── snímka stavu pred testom ───────────── */

function snimkaDb() {
  const kategorie = dbr.prepare('select document_id d, name, slug, "order" o from blog_categories order by id').all();
  const casy = dbr.prepare('select id, updated_at, published_at from blog_categories order by id').all();
  const casGalerie = dbr.prepare('select id, updated_at, published_at from domovska_galeria order by id').all();
  const vazbyGalerie = dbr
    .prepare("select * from files_related_mph where related_type = 'api::domovska-galeria.domovska-galeria' and field = 'fotky' order by id")
    .all();
  const galeria = dbr
    .prepare(
      `select f.file_id id from files_related_mph f join domovska_galeria g on g.id = f.related_id
       where f.related_type = 'api::domovska-galeria.domovska-galeria' and f.field = 'fotky' order by f."order"`,
    )
    .all()
    .map((r) => r.id);
  const vzhlad = tabulkaExistuje('vzhlad_webu') ? dbr.prepare('select * from vzhlad_webu order by id').all() : [];
  const historia = tabulkaExistuje('vzhlad_webu_verzie') ? dbr.prepare('select id from vzhlad_webu_verzie order by id').all().map((r) => r.id) : [];
  const subory = dbr.prepare('select count(*) n, max(id) mx from files').get();
  const priecinky = dbr.prepare('select count(*) n from upload_folders').get().n;
  return { kategorie, galeria, vzhlad, historia, subory, priecinky, casy, casGalerie, vazbyGalerie };
}

/* ───────────── skúšobné údaje z DB ───────────── */

function udajeZDb() {
  const kategorie = dbr
    .prepare('select document_id dokument, slug, name nazov, "order" o from blog_categories order by "order", id')
    .all();
  const clanky = dbr
    .prepare(
      `select p.document_id dokument, p.slug, p.title from blog_posts p
       where p.locale = 'sk' and p.published_at is not null
         and exists (select 1 from files_related_mph f where f.related_id = p.id and f.related_type = 'api::blog-post.blog-post' and f.field = 'coverImage')
         and exists (select 1 from blog_posts q where q.document_id = p.document_id and q.locale = 'en' and q.published_at is not null)
         and exists (select 1 from blog_posts q where q.document_id = p.document_id and q.locale = 'de' and q.published_at is not null)
       order by p.id limit 10`,
    )
    .all();
  const nezverejneny = dbr
    .prepare(
      `select p.document_id dokument, p.slug from blog_posts p where p.locale = 'sk'
       and not exists (select 1 from blog_posts q where q.document_id = p.document_id and q.locale = 'sk' and q.published_at is not null) limit 1`,
    )
    .get();
  const obrazky = dbr
    .prepare("select id from files where url like '/uploads/kategoria\\_%' escape '\\' and mime like 'image/%' order by id")
    .all()
    .map((r) => r.id);
  const neobrazok = dbr.prepare("select id from files where mime not like 'image/%' order by id limit 1").get()?.id;
  const chranenyNepouzity = dbr.prepare("select id from files where url = '/uploads/Mapa_200_a9dd1593d9.jpg'").get()?.id;
  // Článok s kategóriou (na lifecycle kategórie a názov v indexe).
  const sKategoriou = dbr
    .prepare(
      `select p.slug, c.document_id kategoria from blog_posts p
       join blog_posts_category_lnk l on l.blog_post_id = p.id join blog_categories c on c.id = l.blog_category_id
       where p.locale = 'sk' and p.published_at is not null order by p.id limit 1`,
    )
    .get();
  return { kategorie, clanky, nezverejneny, obrazky, neobrazok, chranenyNepouzity, sKategoriou };
}

const t = (sk, en = null, de = null) => ({ sk, en, de });
const odk = (x) => ({ dokument: x.dokument, slug: x.slug });
const KLUCE = ['tabule', 'publikacie', 'dane', 'rekonstrukcie', 'vyskumy', 'vypravy', 'prednasky'];

/**
 * Platný vzhľad zo skutočných údajov DB.
 *  poradie: zoznam kategórií v poradí menu ([] = poradie neurčuje), nazvy: documentId → nový sk názov,
 *  fotky: výber galérie (undefined = null, galériu neurčuje), uprav: funkcia na doladenie.
 */
function vzhlad(d, { poradie = [], nazvy = {}, fotky, uprav } = {}) {
  const K = d.kategorie;
  const C = d.clanky;
  const v = {
    schema: 1,
    domov: {
      uvod: { nadtitulok: t('Encyklopédia hradísk Slovenska', 'Encyclopedia of Slovak Hillforts'), nadpis: t('Slovanské hradiská'), znak: null },
      dlazdice: {
        viditelne: true,
        skupiny: [
          { id: 'typy', nadpis: null, polozky: K.slice(0, 5).map((k, i) => ({ id: `d${i + 1}`, kategoria: odk(k), pocet: true })) },
          { id: 'pramene', nadpis: t('Pramene a tradícia', 'Sources and tradition'), polozky: K.slice(5, 9).map((k, i) => ({ id: `p${i + 1}`, kategoria: odk(k), pocet: false })) },
        ],
      },
      hladanie: {
        viditelne: true,
        vyzva: t('Nájdi hradisko vo svojom okolí'),
        popularneViditelne: true,
        popularne: C.slice(0, 3).map((c) => ({ text: t(c.title.slice(0, 60)), clanok: odk(c) })),
      },
      sekcie: [
        { id: 'mapa', typ: 'mapa', viditelna: true },
        {
          id: 'dalsi-obsah',
          typ: 'dalsi-obsah',
          viditelna: true,
          nadpis: t('Ďalší obsah'),
          riadky: [
            { id: 'r1', kategoria: odk(K[0]), nadpis: null, pocet: 4, vyber: 'najnovsie', zoradenie: 'zverejnenie', lenSObrazkom: true, clanky: [], obrazky: [] },
            {
              id: 'r2',
              kategoria: odk(K[1]),
              nadpis: t('Vybrané'),
              pocet: 3,
              vyber: 'rucne',
              zoradenie: 'abecedne',
              lenSObrazkom: false,
              clanky: C.slice(3, 6).map(odk),
              obrazky: [{ clanok: odk(C[3]), obrazok: { id: d.obrazky[0], pozicia: '50% 40%' } }],
            },
          ],
        },
        { id: 'cinnost', typ: 'cinnost', viditelna: true },
        {
          id: 'kronika',
          typ: 'kronika',
          viditelna: true,
          uvodnyClanok: odk(C[6]),
          pripnute: [odk(C[7])],
          obrazok: { cesta: '/uploads/kategoria_strazna_a_hospodarska_funkcia_e1e876fe12.jpg' },
          fotogaleriaViditelna: true,
        },
      ],
      fotogaleria: fotky === undefined ? null : { fotky },
      pridajteSa: {
        viditelna: true,
        nadtitulok: t('Pridajte sa k nám'),
        nadpis: t('Staňte sa našimi spolupracovníkmi'),
        citat: t('Bez minulosti niet budúcnosti.'),
        uvod: t('Hľadáme ľudí, ktorí chcú pomôcť.\nNapíšte nám.'),
        email: 'info@example.sk',
        prosby: [{ nadpis: t('Fotografie'), text: t('Pošlite nám fotky hradísk.') }],
      },
    },
    kategorie: K.map((k, i) => ({
      kategoria: odk(k),
      nazov: nazvy[k.dokument] ? t(nazvy[k.dokument], `${nazvy[k.dokument]} EN`, `${nazvy[k.dokument]} DE`) : null,
      titulok: null,
      popisokDlazdice: t(k.nazov.slice(0, 40)),
      popisokMenu: i === 2 ? { sk: 'Strážna funkcia', en: null } : null,
      popis: null,
      obrazok: d.obrazky[i] ? { id: d.obrazky[i] } : null,
      tvary: i === 0 ? { sk: ['hradisko', 'hradiská', 'hradísk'], en: 'hillforts', de: null } : null,
      clanky: { zoradenie: 'zverejnenie', pripnute: i === 0 ? [odk(C[8])] : [] },
    })),
    cinnost: {
      nadpis: t('Čo združenie robí'),
      polozky: KLUCE.map((kl) => ({
        kluc: kl,
        nazov: t(`Činnosť ${kl}`),
        popis: t(`Popis činnosti ${kl}.`),
        obrazok: { cesta: '/znak_kopije.webp', vlastny: true },
        viditelna: true,
        naDomovskej: !['tabule', 'rekonstrukcie'].includes(kl),
      })),
    },
    menu: { poradie: poradie.map(odk), hlavnyRiadok: poradie.slice(0, 6).map(odk), skryte: poradie.length ? [odk(poradie[poradie.length - 1])] : [] },
    pata: {
      stlpce: [
        {
          id: 'kategorie',
          nadpis: t('Kategórie'),
          odkazy: [
            { text: t(K[0].nazov), ciel: { druh: 'kategoria', kategoria: odk(K[0]) } },
            { text: t('Aktuality'), ciel: { druh: 'cesta', cesta: '/aktuality?cinnost=vyskumy' } },
            { text: t('Článok'), ciel: { druh: 'clanok', clanok: odk(C[9] || C[0]) } },
            { text: t('Napíšte nám'), ciel: { druh: 'url', url: 'mailto:info@example.sk' } },
          ],
        },
      ],
      siete: [
        { druh: 'facebook', url: 'https://www.facebook.com/hradiska' },
        { druh: 'email', url: 'mailto:info@example.sk' },
      ],
    },
  };
  if (uprav) uprav(v);
  return v;
}

/** PNG s farbou podľa `seme`, `n`×`n` px (od 300 px Strapi vyrobí zmenšeninu thumbnail). */
function png(n, seme) {
  const crc = (b) => zlib.crc32(b) >>> 0;
  const kus = (typ, data) => {
    const d = Buffer.concat([Buffer.from(typ), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(d));
    return Buffer.concat([len, d, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bitová hĺbka
  ihdr[9] = 2; // RGB
  const riadok = Buffer.alloc(1 + n * 3);
  for (let x = 0; x < n; x++) riadok.set([(seme * 53) & 255, (x * 7 + seme) & 255, 120], 1 + x * 3);
  const surove = Buffer.concat(Array.from({ length: n }, () => riadok));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    kus('IHDR', ihdr),
    kus('IDAT', zlib.deflateSync(surove)),
    kus('IEND', Buffer.alloc(0)),
  ]);
}

async function nahraj(tok, meno, seme) {
  const fd = new FormData();
  fd.append('files', new Blob([png(300, seme)], { type: 'image/png' }), meno);
  const r = await api('POST', '/api/upload', { tok, telo: fd });
  return { r, subor: Array.isArray(r.json) ? r.json[0] : null };
}

/* ───────────── test ───────────── */

const PRED = snimkaDb();
const D = udajeZDb();
const nahrate = []; // id skúšobných súborov (zmažú sa pri upratovaní)
const ROUTY = [
  ['GET', `${V}/koncept`],
  ['PUT', `${V}/koncept`, {}],
  ['POST', `${V}/zverejnit`, {}],
  ['GET', `${V}/historia`],
  ['GET', `${V}/historia/1`],
  ['POST', `${V}/obnovit/1`, {}],
  ['GET', `${V}/pouzitie-suboru/1`],
];

async function hlavnyTest() {
  log(`Účty: redaktorov ${redaktori.length}, člen 1 (id nevypisujem). Kategórií ${D.kategorie.length}, článkov na skúšku ${D.clanky.length}.`);
  if (D.clanky.length < 10 || D.obrazky.length < 7 || !D.nezverejneny || !D.neobrazok || !D.chranenyNepouzity || !D.sKategoriou) {
    throw new Error('V DB chýbajú údaje, z ktorých test skladá vzhľad (články s obálkou v sk/en/de, obrázky kategórií …).');
  }
  const prazdnyNaZaciatku = !PRED.vzhlad.length || (PRED.vzhlad[0].koncept === null && PRED.vzhlad[0].zverejnene === null);
  const verziaPred = PRED.vzhlad[0]?.verzia_zverejnena ?? 0;

  /* 1. Verejný GET bez vzhľadu */
  sekcia('Verejný GET');
  {
    const r = await verejny();
    over('GET /api/vzhlad-webu bez prihlásenia → 200', r.status === 200, `stav ${r.status}`);
    over('Cache-Control: public, max-age=30, stale-while-revalidate=300', r.h.get('cache-control') === 'public, max-age=30, stale-while-revalidate=300', r.h.get('cache-control'));
    over(`ETag "v${verziaPred}"`, r.h.get('etag') === `"v${verziaPred}"`, r.h.get('etag'));
    if (prazdnyNaZaciatku) {
      over('bez vzhľadu: { data:null, verzia, subory:{}, kategorie:{}, clanky:{} }', rovnake(r.json, { data: null, verzia: verziaPred, subory: {}, kategorie: {}, clanky: {} }), r.text.slice(0, 200));
    }
    const r2 = await api('GET', V, { hlavicky: { 'If-None-Match': `"v${verziaPred}"` } });
    over('If-None-Match so zhodou → 304 bez tela', r2.status === 304 && !r2.text, `stav ${r2.status}`);
  }

  /* 2. Oprávnenia */
  sekcia('Oprávnenia (bez prihlásenia 401, člen 403)');
  for (const [m, c, telo] of ROUTY) {
    const a = await api(m, c, { telo });
    over(`${m} ${c.replace(V, '')} bez prihlásenia → 401`, a.status === 401, `stav ${a.status}`);
    const b = await api(m, c, { telo, tok: 'neplatny.token.xyz' });
    over(`${m} ${c.replace(V, '')} s neplatným tokenom → 401`, b.status === 401, `stav ${b.status}`);
    const e = await api(m, c, { telo, tok: CLEN });
    over(`${m} ${c.replace(V, '')} člen → 403`, e.status === 403, `stav ${e.status}`);
  }

  /* 3. Kontrola údajov */
  sekcia('Kontrola údajov (400 s cestou k poľu)');
  let K0 = await koncept();
  over('redaktor 200: GET /koncept', !!K0 && typeof K0.verziaKonceptu === 'number' && !!K0.db);
  const zaklad0 = K0.verziaKonceptu;
  const zDb = K0.db;
  const zaklad = vzhlad(D);
  const dlhy = (n) => 'a'.repeat(n);
  const pripady = [
    // [názov, úprava vzhľadu, očakávaná cesta]
    ['neznáma schéma', (v) => (v.schema = 2), 'schema'],
    ['nepoznaný kľúč v koreni', (v) => (v.navyse = 1), 'navyse'],
    ['nepoznaný kľúč vnorený', (v) => (v.domov.uvod.farba = 'red'), 'domov.uvod.farba'],
    ['chýba povinné pole', (v) => delete v.domov.hladanie.vyzva, 'domov.hladanie.vyzva'],
    ['zlý typ (áno/nie)', (v) => (v.domov.dlazdice.viditelne = 'ano'), 'domov.dlazdice.viditelne'],
    ['chýba slovenčina', (v) => (v.domov.uvod.nadpis = { en: 'Slavic hillforts' }), 'domov.uvod.nadpis.sk'],
    ['prázdna slovenčina', (v) => (v.domov.uvod.nadpis.sk = '   '), 'domov.uvod.nadpis.sk'],
    ['HTML <b> v texte', (v) => (v.kategorie[0].popisokDlazdice.sk = '<b>Kniežatá</b>'), 'kategorie[0].popisokDlazdice.sk'],
    ['znak > v preklade', (v) => (v.domov.uvod.nadtitulok.en = 'a > b'), 'domov.uvod.nadtitulok.en'],
    ['riadiaci znak v texte', (v) => (v.domov.uvod.nadpis.sk = 'Slovanské\u0007'), 'domov.uvod.nadpis.sk'],
    ['popisok dlaždice > 40', (v) => (v.kategorie[0].popisokDlazdice.sk = dlhy(41)), 'kategorie[0].popisokDlazdice.sk'],
    ['popisok menu > 40 (v EN)', (v) => (v.kategorie[2].popisokMenu = { en: dlhy(41) }), 'kategorie[2].popisokMenu.en'],
    ['názov > 100', (v) => (v.kategorie[1].nazov = t(dlhy(101))), 'kategorie[1].nazov.sk'],
    ['popis > 500', (v) => (v.kategorie[0].popis = t(dlhy(501))), 'kategorie[0].popis.sk'],
    ['nadpis > 120', (v) => (v.domov.uvod.nadpis = t(dlhy(121))), 'domov.uvod.nadpis.sk'],
    ['citát > 200', (v) => (v.domov.pridajteSa.citat = t(dlhy(201))), 'domov.pridajteSa.citat.sk'],
    ['skupín dlaždíc > 4', (v) => (v.domov.dlazdice.skupiny = [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, nadpis: null, polozky: [{ id: `x${i}`, kategoria: odk(D.kategorie[i]), pocet: true }] }))), 'domov.dlazdice.skupiny'],
    ['žiadna skupina dlaždíc', (v) => (v.domov.dlazdice.skupiny = []), 'domov.dlazdice.skupiny'],
    ['prázdna skupina dlaždíc', (v) => (v.domov.dlazdice.skupiny[1].polozky = []), 'domov.dlazdice.skupiny[1].polozky'],
    ['dlaždíc v skupine > 12', (v) => (v.domov.dlazdice.skupiny[0].polozky = D.kategorie.slice(0, 13).map((k, i) => ({ id: `z${i}`, kategoria: odk(k), pocet: true }))), 'domov.dlazdice.skupiny[0].polozky'],
    ['riadkov článkov > 8', (v) => (v.domov.sekcie[1].riadky = Array.from({ length: 9 }, (_, i) => ({ ...kopia(v.domov.sekcie[1].riadky[0]), id: `q${i}` }))), 'domov.sekcie[1].riadky'],
    ['článkov v riadku > 8', (v) => (v.domov.sekcie[1].riadky[1].clanky = D.clanky.slice(0, 9).map(odk).concat([])), 'domov.sekcie[1].riadky[1].clanky'],
    ['počet v riadku 9', (v) => (v.domov.sekcie[1].riadky[0].pocet = 9), 'domov.sekcie[1].riadky[0].pocet'],
    ['počet v riadku 0', (v) => (v.domov.sekcie[1].riadky[0].pocet = 0), 'domov.sekcie[1].riadky[0].pocet'],
    ['výber riadku neznámy', (v) => (v.domov.sekcie[1].riadky[0].vyber = 'nahodne'), 'domov.sekcie[1].riadky[0].vyber'],
    ['pripnutých v kronike > 8', (v) => (v.domov.sekcie[3].pripnute = D.clanky.slice(0, 9).map(odk)), 'domov.sekcie[3].pripnute'],
    ['ten istý článok pripnutý dvakrát', (v) => (v.domov.sekcie[3].pripnute = [odk(D.clanky[7]), odk(D.clanky[7])]), 'domov.sekcie[3].pripnute[1]'],
    ['populárnych > 6', (v) => (v.domov.hladanie.popularne = D.clanky.slice(0, 7).map((c) => ({ text: t('x'), clanok: odk(c) }))), 'domov.hladanie.popularne'],
    ['fotiek galérie > 12', (v) => (v.domov.fotogaleria = { fotky: Array.from({ length: 13 }, (_, i) => i + 1) }), 'domov.fotogaleria.fotky'],
    ['fotka v galérii dvakrát', (v) => (v.domov.fotogaleria = { fotky: [D.obrazky[0], D.obrazky[0]] }), 'domov.fotogaleria.fotky[1]'],
    ['id mimo VZOR_ID', (v) => (v.domov.dlazdice.skupiny[0].polozky[0].id = 'D 1'), 'domov.dlazdice.skupiny[0].polozky[0].id'],
    ['id dlaždice dvakrát (v dvoch skupinách)', (v) => (v.domov.dlazdice.skupiny[1].polozky[0].id = 'd1'), 'domov.dlazdice.skupiny[1].polozky[0].id'],
    ['id sekcie dvakrát', (v) => (v.domov.sekcie[2].id = 'mapa'), 'domov.sekcie[2].id'],
    ['neznámy typ sekcie', (v) => (v.domov.sekcie[0].typ = 'banner'), 'domov.sekcie[0].typ'],
    ['sekcia mapa dvakrát', (v) => v.domov.sekcie.push({ id: 'mapa2', typ: 'mapa', viditelna: false }), 'domov.sekcie[4].typ'],
    ['chýba činnosť (kľúč)', (v) => v.cinnost.polozky.pop(), 'cinnost.polozky'],
    ['činnosť dvakrát', (v) => (v.cinnost.polozky[1].kluc = 'tabule'), 'cinnost.polozky[1].kluc'],
    ['kategória vo vzhľade kategórií dvakrát', (v) => (v.kategorie[1].kategoria = odk(D.kategorie[0])), 'kategorie[1].kategoria'],
    ['tvary: nie 3', (v) => (v.kategorie[0].tvary.sk = ['hradisko', 'hradiská']), 'kategorie[0].tvary.sk'],
    ['neplatné documentId', (v) => (v.domov.dlazdice.skupiny[0].polozky[0].kategoria.dokument = 'ABC!'), 'domov.dlazdice.skupiny[0].polozky[0].kategoria.dokument'],
    ['obrázok: zlá cesta', (v) => (v.domov.sekcie[3].obrazok = { cesta: 'javascript:alert(1)' }), 'domov.sekcie[3].obrazok.cesta'],
    ['obrázok: cesta mimo /uploads a bez prípony', (v) => (v.domov.sekcie[3].obrazok = { cesta: '/uploads/../../etc/passwd' }), 'domov.sekcie[3].obrazok.cesta'],
    ['obrázok: id 0', (v) => (v.kategorie[0].obrazok = { id: 0 }), 'kategorie[0].obrazok.id'],
    ['obrázok: id aj cesta naraz', (v) => (v.kategorie[0].obrazok = { id: D.obrazky[0], cesta: '/logo.png' }), 'kategorie[0].obrazok.cesta'],
    ['obrázok: výrez s CSS', (v) => (v.kategorie[0].obrazok = { id: D.obrazky[0], pozicia: '50% 40%; color:red' }), 'kategorie[0].obrazok.pozicia'],
    ['odkaz: cesta javascript:', (v) => (v.pata.stlpce[0].odkazy[1].ciel = { druh: 'cesta', cesta: 'javascript:alert(1)' }), 'pata.stlpce[0].odkazy[1].ciel.cesta'],
    ['odkaz: cesta //iny-web', (v) => (v.pata.stlpce[0].odkazy[1].ciel = { druh: 'cesta', cesta: '//iny-web' }), 'pata.stlpce[0].odkazy[1].ciel.cesta'],
    ['odkaz: http:// (nie https)', (v) => (v.pata.stlpce[0].odkazy[3].ciel = { druh: 'url', url: 'http://example.sk' }), 'pata.stlpce[0].odkazy[3].ciel.url'],
    ['odkaz: javascript: url', (v) => (v.pata.stlpce[0].odkazy[3].ciel = { druh: 'url', url: 'javascript:alert(1)' }), 'pata.stlpce[0].odkazy[3].ciel.url'],
    ['odkaz: neznámy druh cieľa', (v) => (v.pata.stlpce[0].odkazy[3].ciel = { druh: 'skript', url: 'x' }), 'pata.stlpce[0].odkazy[3].ciel.druh'],
    ['sieť facebook s mailto:', (v) => (v.pata.siete[0].url = 'mailto:a@b.sk'), 'pata.siete[0].url'],
    ['e-mail v „Pridajte sa“', (v) => (v.domov.pridajteSa.email = 'nie-je-email'), 'domov.pridajteSa.email'],
    ['menu: hlavný riadok mimo poradia', (v) => {
      v.menu.poradie = D.kategorie.slice(1).map(odk);
      v.menu.hlavnyRiadok = [odk(D.kategorie[0])];
      v.menu.skryte = [];
    }, 'menu.hlavnyRiadok[0]'],
    ['menu: skryté mimo poradia', (v) => {
      v.menu.poradie = D.kategorie.slice(1).map(odk);
      v.menu.hlavnyRiadok = [];
      v.menu.skryte = [odk(D.kategorie[0])];
    }, 'menu.skryte[0]'],
    ['menu: kategória v poradí dvakrát', (v) => (v.menu.poradie = [odk(D.kategorie[0]), odk(D.kategorie[0])]), 'menu.poradie[1]'],
    ['menu: v hlavnom riadku aj skrytá', (v) => {
      v.menu.poradie = D.kategorie.map(odk);
      v.menu.hlavnyRiadok = [odk(D.kategorie[0])];
      v.menu.skryte = [odk(D.kategorie[0])];
    }, 'menu.skryte[0]'],
    // odkazy proti DB
    ['neexistujúca kategória', (v) => (v.domov.dlazdice.skupiny[0].polozky[0].kategoria = { dokument: 'zzzzzzzzzzzzzzzzzzzzzzzz', slug: 'nie-je' }), 'domov.dlazdice.skupiny[0].polozky[0].kategoria'],
    ['kategória bez documentId', (v) => (v.domov.dlazdice.skupiny[0].polozky[0].kategoria = { dokument: null, slug: D.kategorie[0].slug }), 'domov.dlazdice.skupiny[0].polozky[0].kategoria'],
    ['nezverejnený článok', (v) => (v.domov.hladanie.popularne[0].clanok = odk(D.nezverejneny)), 'domov.hladanie.popularne[0].clanok'],
    ['neexistujúci článok', (v) => (v.domov.sekcie[3].uvodnyClanok = { dokument: 'zzzzzzzzzzzzzzzzzzzzzzzz', slug: 'nie-je' }), 'domov.sekcie[3].uvodnyClanok'],
    ['neexistujúci súbor', (v) => (v.kategorie[0].obrazok = { id: 99999999 }), 'kategorie[0].obrazok'],
    ['súbor nie je obrázok', (v) => (v.kategorie[0].obrazok = { id: D.neobrazok }), 'kategorie[0].obrazok'],
    ['menu.poradie bez niektorej kategórie', (v) => {
      v.menu.poradie = D.kategorie.slice(1).map(odk);
      v.menu.hlavnyRiadok = [];
      v.menu.skryte = [];
    }, 'menu.poradie'],
  ];
  for (const [nazov, uprav, cesta] of pripady) {
    const v = kopia(zaklad);
    uprav(v);
    const r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: zaklad0, data: v, zakladDb: zDb } });
    const ch = chybyZ(r);
    over(`400 ${nazov} → ${cesta}`, r.status === 400 && ch.some((c) => c.cesta === cesta && typeof c.sprava === 'string' && c.sprava.length > 3), `stav ${r.status}, cesty: ${ch.map((c) => c.cesta).slice(0, 4).join(' | ')}`);
  }
  // telo dopytu
  const telá = [
    ['chýba zaklad', { data: zaklad, zakladDb: zDb }, 'zaklad'],
    ['zaklad nie je číslo', { zaklad: 'x', data: zaklad, zakladDb: zDb }, 'zaklad'],
    ['chýba zakladDb', { zaklad: zaklad0, data: zaklad }, 'zakladDb'],
    ['zlé zakladDb', { zaklad: zaklad0, data: zaklad, zakladDb: { poradie: { x: 1 }, nazvy: {}, fotogaleria: 'a' } }, 'zakladDb.fotogaleria'],
    ['nepoznaný kľúč v tele', { zaklad: zaklad0, data: zaklad, zakladDb: zDb, navyse: 1 }, 'telo.navyse'],
    ['telo je zoznam', [1, 2], ''],
  ];
  for (const [nazov, telo, cesta] of telá) {
    const r = await api('PUT', `${V}/koncept`, { tok: R1, telo });
    over(`400 PUT telo: ${nazov} → ${cesta || '(koreň)'}`, r.status === 400 && chybyZ(r).some((c) => c.cesta === cesta), `stav ${r.status}, ${chybyZ(r).map((c) => c.cesta).join(' | ')}`);
  }
  for (const [nazov, telo] of [['poznámka s HTML', { zaklad: zaklad0, poznamka: '<b>x</b>' }], ['poznámka > 200', { zaklad: zaklad0, poznamka: dlhy(201) }], ['zverejnenie bez zaklad', {}]]) {
    const r = await api('POST', `${V}/zverejnit`, { tok: R1, telo });
    over(`400 POST /zverejnit: ${nazov}`, r.status === 400, `stav ${r.status}`);
  }
  K0 = await koncept();
  over('neplatné pokusy nezmenili koncept ani verziu', K0.verziaKonceptu === zaklad0 && rovnake(K0.koncept, PRED.vzhlad[0]?.koncept ? JSON.parse(PRED.vzhlad[0].koncept) : null));

  /* 4. Uloženie konceptu */
  sekcia('Uloženie konceptu');
  const webPred = await verejny();
  let r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: zaklad0, data: zaklad, zakladDb: zDb } });
  over('redaktor 200: PUT /koncept (platný vzhľad)', r.status === 200 && r.json?.verziaKonceptu === zaklad0 + 1, `stav ${r.status} ${r.text.slice(0, 300)}`);
  let K = await koncept();
  over('GET /koncept vráti uložený koncept a zakladDb', rovnake(K.koncept, zaklad) && rovnake(K.zakladDb, zDb));
  over('GET /koncept: tvar OdpovedKonceptu', ['koncept', 'zakladDb', 'zverejnene', 'verziaKonceptu', 'verziaZverejnena', 'konceptUpravil', 'konceptUpravene', 'zverejnilKto', 'zverejneneKedy', 'db', 'subory', 'kategorie', 'clanky'].every((k) => k in K));
  over('GET /koncept: rozriešené kategórie (všetky z DB)', Object.keys(K.kategorie).length === D.kategorie.length && D.kategorie.every((k) => K.kategorie[k.dokument]?.slug === k.slug));
  over('GET /koncept: rozriešené články v sk/en/de', D.clanky.slice(0, 9).every((c) => K.clanky[c.dokument]?.sk?.slug === c.slug && K.clanky[c.dokument]?.en && K.clanky[c.dokument]?.de));
  over('GET /koncept: rozriešené súbory (obrázky kategórií aj obálky článkov)', D.obrazky.slice(0, D.kategorie.length).every((id) => K.subory[String(id)]?.url) && Object.values(K.clanky).every((c) => !c.sk?.obrazok || K.subory[String(c.sk.obrazok)]));
  const webPo = await verejny();
  over('uloženie konceptu web nezmenilo (verejný GET rovnaký)', webPo.text === webPred.text && webPo.h.get('etag') === webPred.h.get('etag'));

  /* 5. Súbeh */
  sekcia('Súbeh (409)');
  const z1 = K.verziaKonceptu;
  const vA = vzhlad(D, { uprav: (v) => (v.domov.uvod.nadpis = t('Verzia A')) });
  const vB = vzhlad(D, { uprav: (v) => (v.domov.uvod.nadpis = t('Verzia B')) });
  const a = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: z1, data: vA, zakladDb: zDb } });
  const b = await api('PUT', `${V}/koncept`, { tok: R2, telo: { zaklad: z1, data: vB, zakladDb: zDb } });
  over('prvé uloženie z verzie N → 200', a.status === 200);
  over('druhé uloženie z tej istej verzie N → 409', b.status === 409 && kod(b) === 'koncept-zmeneny', `stav ${b.status}`);
  const det = b.json?.error?.details || {};
  over('409 nesie aktuálny koncept, kto a kedy ho uložil', rovnake(det.koncept, vA) && typeof det.konceptUpravil === 'string' && det.konceptUpravil.length > 0 && !Number.isNaN(Date.parse(det.konceptUpravene)) && det.verziaKonceptu === z1 + 1);
  const [p1, p2] = await Promise.all([
    api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: z1 + 1, data: vA, zakladDb: zDb } }),
    api('PUT', `${V}/koncept`, { tok: R2, telo: { zaklad: z1 + 1, data: vB, zakladDb: zDb } }),
  ]);
  over('dve súbežné uloženia z tej istej verzie: práve jedno 200, druhé 409', [p1.status, p2.status].sort().join() === '200,409', `${p1.status}, ${p2.status}`);

  /* 6. Zverejnenie */
  sekcia('Zverejnenie, história a zápisy do existujúcich typov');
  K = await koncept();
  const kX = D.kategorie[3]; // premenuje sa
  const poradie1 = [...D.kategorie].reverse();
  const fotky1 = D.obrazky.slice(0, 4);
  const P1 = vzhlad(D, { poradie: poradie1, nazvy: { [kX.dokument]: `${kX.nazov} (test)` }, fotky: fotky1 });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P1, zakladDb: K.db } });
  over('PUT koncept P1 (nové poradie, názov, galéria)', r.status === 200, `stav ${r.status} ${r.text.slice(0, 300)}`);
  // zahriať pamäť indexu, počtov a vzhľadu (dôkaz, že ich zverejnenie zmaže)
  await api('GET', '/api/search-index');
  await api('GET', '/api/pocty-kategorii');
  await verejny();
  const histPred = (await api('GET', `${V}/historia`, { tok: R1 })).json?.verzie?.length ?? -1;
  const zverPred = K.verziaZverejnena;
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: 'test-kontraktu P1' } });
  over('redaktor 200: POST /zverejnit', r.status === 200 && r.json?.verziaZverejnena === zverPred + 1, `stav ${r.status} ${r.text.slice(0, 300)}`);
  const v1 = r.json?.verziaZverejnena;
  const zap = r.json?.zapisy || [];
  const menenychPoradi = poradie1.filter((k, i) => PRED.kategorie.find((x) => x.d === k.dokument).o !== (i + 1) * 10).length;
  over(`odpoveď vymenúva zápisy (poradie ${menenychPoradi}×, názov 1×, galéria 1×)`, zap.filter((z) => z.druh === 'poradie').length === menenychPoradi && zap.filter((z) => z.druh === 'nazov').length === 1 && zap.filter((z) => z.druh === 'fotogaleria').length === 1, JSON.stringify(zap.map((z) => z.druh)));
  const poZverejneni = snimkaDb();
  over('blog-category.order = 10, 20, 30 … podľa menu.poradie', poradie1.every((k, i) => poZverejneni.kategorie.find((x) => x.d === k.dokument)?.o === (i + 1) * 10));
  over('blog-category.name = kategorie[].nazov.sk', poZverejneni.kategorie.find((x) => x.d === kX.dokument)?.name === `${kX.nazov} (test)`);
  over('slugy kategórií sa nezmenili', rovnake(poZverejneni.kategorie.map((k) => k.slug), PRED.kategorie.map((k) => k.slug)));
  over('domovska-galeria.fotky = vybrané fotky v poradí (DB)', rovnake(poZverejneni.galeria, fotky1), JSON.stringify(poZverejneni.galeria));
  const gal = await api('GET', '/api/domovska-galeria?populate=fotky');
  over('domovska-galeria cez REST (staré verzie webu) ukazuje nový výber', rovnake((gal.json?.data?.fotky || []).map((f) => f.id), fotky1));
  const katRest = await api('GET', '/api/blog-categories?sort=order:asc&pagination[pageSize]=100');
  over('/api/blog-categories zoradené podľa nového poradia', rovnake((katRest.json?.data || []).map((k) => k.documentId), poradie1.map((k) => k.dokument)));
  const hist = (await api('GET', `${V}/historia`, { tok: R1 })).json?.verzie || [];
  over('redaktor 200: GET /historia; pribudla verzia s poznámkou a autorom', hist.length === histPred + 1 && hist[0].verzia === v1 && hist[0].poznamka === 'test-kontraktu P1' && !!hist[0].zverejnil && !!hist[0].zverejnene && !('obsah' in hist[0]));
  const h1 = await api('GET', `${V}/historia/${v1}`, { tok: R1 });
  over('redaktor 200: GET /historia/:verzia vráti obsah zverejnenia', h1.status === 200 && rovnake(h1.json?.obsah, P1) && !!h1.json?.subory);
  const w = await verejny();
  over('verejný GET: data = zverejnený koncept, verzia', w.status === 200 && rovnake(w.json?.data, P1) && w.json?.verzia === v1);
  over(`verejný GET: ETag "v${v1}"`, w.h.get('etag') === `"v${v1}"`);
  const idObrazkov = [...new Set([...D.obrazky.slice(0, D.kategorie.length), ...fotky1])];
  over('verejný GET: rozriešené fotky {id,url,width,height,alt,formats}', idObrazkov.every((id) => {
    const s = w.json?.subory?.[String(id)];
    return s && s.id === id && typeof s.url === 'string' && 'width' in s && 'height' in s && 'alt' in s && typeof s.formats === 'object';
  }));
  over('verejný GET: kategórie z DB s novým názvom a poradím', w.json?.kategorie?.[kX.dokument]?.nazov === `${kX.nazov} (test)` && w.json?.kategorie?.[poradie1[0].dokument]?.poradie === 10);
  over('verejný GET: články v sk/en/de so slugom, názvom a obrázkom', D.clanky.slice(0, 9).every((c) => ['sk', 'en', 'de'].every((j) => w.json?.clanky?.[c.dokument]?.[j]?.slug && typeof w.json.clanky[c.dokument][j].nazov === 'string')));
  over('verejný GET: obálky článkov sú v subory', Object.values(w.json?.clanky || {}).flatMap((c) => Object.values(c)).every((c) => !c.obrazok || w.json.subory[String(c.obrazok)]));
  const n304 = await api('GET', V, { hlavicky: { 'If-None-Match': `"v${v1}"` } });
  over('304 pri If-None-Match "vN"', n304.status === 304 && !n304.text);
  const w304 = await api('GET', V, { hlavicky: { 'If-None-Match': `W/"v${v1}"` } });
  over('304 aj pri slabej značke W/"vN"', w304.status === 304);
  const n200 = await api('GET', V, { hlavicky: { 'If-None-Match': `"v${v1 + 99}"` } });
  over('200 pri inom ETagu', n200.status === 200 && rovnake(n200.json?.data, P1));
  const idx = await api('GET', '/api/search-index?bezTextu=1');
  const vKatX = (idx.json?.items || []).filter((i) => i.categorySlug === kX.slug);
  over('search-index má nový názov kategórie hneď po zverejnení (lifecycle)', vKatX.length > 0 && vKatX.every((i) => i.categoryName === `${kX.nazov} (test)`), `${vKatX.length} článkov`);
  K = await koncept();
  over('po zverejnení: koncept má nový základ = DB po zápisoch', K.zakladDb?.poradie?.[poradie1[0].dokument] === 10 && rovnake(K.zakladDb?.fotogaleria, fotky1) && K.verziaZverejnena === v1);

  /* 7. Atomickosť */
  sekcia('Atomickosť zverejnenia (chyba po všetkých zápisoch)');
  const poradie2 = [...D.kategorie.slice(7), ...D.kategorie.slice(0, 7)];
  const P2 = vzhlad(D, { poradie: poradie2, nazvy: { [kX.dokument]: `${kX.nazov} (test2)` }, fotky: [...PRED.galeria].reverse() });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P2, zakladDb: K.db } });
  over('PUT koncept P2', r.status === 200, `stav ${r.status}`);
  const stavPred = snimkaDb();
  const webPredA = await verejny();
  const histPredA = (await api('GET', `${V}/historia`, { tok: R1 })).json.verzie.length;
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: '__skusobna-chyba__' } });
  if (REZIM === 'vyvoj') {
    over('skúšobná chyba po zápisoch → 500 (kod skusobna-chyba)', r.status === 500 && kod(r) === 'skusobna-chyba', `stav ${r.status} ${r.text.slice(0, 200)}`);
    over('pred chybou prebehli zápisy do kategórií a galérie (poradie aj názov aj fotky)', (r.json?.error?.details?.zapisov ?? 0) >= D.kategorie.length, `zápisov ${r.json?.error?.details?.zapisov}`);
    over(`zverejnenie s chybou trvalo ${r.ms} ms (< 15 s: nič nečakalo na spojenie mimo transakcie)`, r.ms < 15000);
    const stavPo = snimkaDb();
    over('nič sa nezapísalo: poradie kategórií', rovnake(stavPo.kategorie, stavPred.kategorie));
    over('nič sa nezapísalo: domovská galéria', rovnake(stavPo.galeria, stavPred.galeria));
    over('nič sa nezapísalo: história (DB aj API)', rovnake(stavPo.historia, stavPred.historia) && (await api('GET', `${V}/historia`, { tok: R1 })).json.verzie.length === histPredA);
    over('nič sa nezapísalo: riadok vzhľadu (zverejnené, verzia)', rovnake(stavPo.vzhlad.map((x) => [x.zverejnene, x.verzia_zverejnena, x.zaklad_db]), stavPred.vzhlad.map((x) => [x.zverejnene, x.verzia_zverejnena, x.zaklad_db])));
    const webPoA = await verejny();
    over('nič sa nezapísalo: verejný GET rovnaký', webPoA.text === webPredA.text);
    const idxA = await api('GET', '/api/search-index?bezTextu=1');
    over('search-index po vrátení transakcie má pôvodný (P1) názov', (idxA.json?.items || []).filter((i) => i.categorySlug === kX.slug).every((i) => i.categoryName === `${kX.nazov} (test)`));
  } else {
    over('v produkcii poznámka „__skusobna-chyba__“ chybu nevyvolá (bežné zverejnenie 200)', r.status === 200, `stav ${r.status} ${r.text.slice(0, 200)}`);
  }

  /* 8. Trojcestné zlúčenie */
  sekcia('Trojcestné zlúčenie s DB');
  K = await koncept();
  const dbK = K.db;
  const poradie3 = [...D.kategorie.slice(3), ...D.kategorie.slice(0, 3)];
  const kY = poradie3[poradie3.length - 1];
  const P3 = vzhlad(D, { poradie: poradie3, nazvy: { [kX.dokument]: `${kX.nazov} (test3)` }, fotky: D.obrazky.slice(2, 7) });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P3, zakladDb: dbK } });
  over('PUT koncept P3', r.status === 200);
  // niekto medzitým zmení poradie jednej kategórie na obrazovke Kategórie
  r = await api('PUT', `/api/blog-categories/${kY.dokument}`, { tok: R1, telo: { data: { order: 999 } } });
  over('zmena poradia kategórie mimo vzhľadu (REST, ako obrazovka Kategórie)', r.status === 200);
  const stavPredK = snimkaDb();
  const histPredK = stavPredK.historia.length;
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1 } });
  const konf = r.json?.error?.details?.konflikty || [];
  over('zmenené poradie v DB → 409 konflikt-db', r.status === 409 && kod(r) === 'konflikt-db', `stav ${r.status}`);
  over('konflikt menuje práve tú kategóriu a pole', konf.length === 1 && konf[0].druh === 'poradie' && konf[0].kategoria === kY.dokument && konf[0].db === 999 && konf[0].cesta === `menu.poradie[${poradie3.length - 1}]`, JSON.stringify(konf.map((k) => [k.druh, k.cesta])));
  const stavPoK = snimkaDb();
  over('pri konflikte sa nezapísalo nič (kategórie, galéria, história, vzhľad)', rovnake(stavPoK.kategorie, stavPredK.kategorie) && rovnake(stavPoK.galeria, stavPredK.galeria) && stavPoK.historia.length === histPredK && rovnake(stavPoK.vzhlad, stavPredK.vzhlad));
  // nekonfliktné vetvy: koncept pole nemení / DB už má cieľ / zapíše sa
  K = await koncept();
  const kW = D.kategorie[5];
  const kZ = D.kategorie[6];
  const P4 = vzhlad(D, { poradie: [], nazvy: { [kX.dokument]: `${kX.nazov} (test4)`, [kW.dokument]: `${kW.nazov} (W4)` } });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P4, zakladDb: K.db } });
  over('PUT koncept P4', r.status === 200);
  await api('PUT', `/api/blog-categories/${kW.dokument}`, { tok: R1, telo: { data: { name: `${kW.nazov} (W4)` } } }); // to isté ako koncept
  await api('PUT', `/api/blog-categories/${kZ.dokument}`, { tok: R1, telo: { data: { name: `${kZ.nazov} (mimo)` } } }); // koncept ju nemení
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: 'test-kontraktu P4' } });
  over('zverejnenie bez konfliktu → 200', r.status === 200, `stav ${r.status} ${r.text.slice(0, 300)}`);
  const zap4 = r.json?.zapisy || [];
  over('zapíše sa len to, čo koncept mení a DB nie (1× názov)', zap4.length === 1 && zap4[0].druh === 'nazov' && zap4[0].kategoria === kX.dokument, JSON.stringify(zap4));
  const s4 = snimkaDb();
  const nazov = (s, k) => s.kategorie.find((x) => x.d === k.dokument);
  over('DB: zapísaný názov, rovnaká zmena ponechaná, cudzia zmena neprepísaná, cudzie poradie ponechané', nazov(s4, kX).name === `${kX.nazov} (test4)` && nazov(s4, kW).name === `${kW.nazov} (W4)` && nazov(s4, kZ).name === `${kZ.nazov} (mimo)` && nazov(s4, kY).o === 999);
  over('fotogaleria: null → galéria sa nemení', rovnake(s4.galeria, stavPoK.galeria));

  /* 9. Obnovenie */
  sekcia('Obnovenie verzie z histórie');
  K = await koncept();
  const webPredO = await verejny();
  r = await api('POST', `${V}/obnovit/${v1}`, { tok: R1, telo: { zaklad: K.verziaKonceptu } });
  over('redaktor 200: POST /obnovit/:verzia', r.status === 200 && r.json?.verziaKonceptu === K.verziaKonceptu + 1 && r.json?.obnovenaVerzia === v1);
  const KO = await koncept();
  over('koncept = obnovená verzia, základ = DB teraz', rovnake(KO.koncept, P1) && rovnake(KO.zakladDb, KO.db));
  const webPoO = await verejny();
  over('obnovenie web nezmenilo', webPoO.text === webPredO.text);
  r = await api('POST', `${V}/obnovit/99999`, { tok: R1, telo: {} });
  over('obnovenie neexistujúcej verzie → 404', r.status === 404);
  r = await api('POST', `${V}/obnovit/${v1}`, { tok: R1, telo: { zaklad: KO.verziaKonceptu - 1 } });
  over('obnovenie so starým zaklad → 409', r.status === 409 && kod(r) === 'koncept-zmeneny');
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: KO.verziaKonceptu, poznamka: 'test-kontraktu obnovenie P1' } });
  over('zverejnenie obnovenej verzie → 200', r.status === 200, `stav ${r.status} ${r.text.slice(0, 300)}`);
  const sO = snimkaDb();
  over('po zverejnení obnovenej verzie: poradie, názov a galéria ako v P1', poradie1.every((k, i) => nazov(sO, k).o === (i + 1) * 10) && nazov(sO, kX).name === `${kX.nazov} (test)` && rovnake(sO.galeria, fotky1));
  over('verejný GET po obnovení = P1', rovnake((await verejny()).json?.data, P1));

  /* 10. Ochrana fotiek */
  sekcia('Ochrana fotiek pred zmazaním');
  const T = {};
  for (const [kluc, seme] of [['T1', 11], ['T2', 22], ['T3', 33]]) {
    const { r: u, subor } = await nahraj(R1, `vzhlad-test-${kluc.toLowerCase()}.png`, seme);
    over(`nahratie skúšobného súboru ${kluc} → 201`, u.status === 201 && subor?.id, `stav ${u.status}`);
    if (subor?.id) {
      T[kluc] = subor;
      nahrate.push(subor.id);
    }
  }
  const { r: uc, subor: TC } = await nahraj(CLEN, 'vzhlad-test-clen.png', 44);
  over('člen smie nahrať súbor (avatar) ako doteraz → 201', uc.status === 201 && TC?.id, `stav ${uc.status}`);
  if (TC?.id) nahrate.push(TC.id);
  if (TC?.id) {
    const dc = await api('DELETE', `/api/upload/files/${TC.id}`, { tok: CLEN });
    over('člen nesmie mazať súbory ako doteraz → 403', dc.status === 403, `stav ${dc.status}`);
  }
  const f1 = await api('GET', `/api/upload/files/${T.T1.id}`, { tok: R1 });
  over('GET /api/upload/files/:id funguje', f1.status === 200 && f1.json?.id === T.T1.id);
  const fz = await api('GET', `/api/upload/files?filters[id][$eq]=${T.T1.id}`, { tok: R1 });
  over('GET /api/upload/files (zoznam) funguje', fz.status === 200 && Array.isArray(fz.json) && fz.json.length === 1);
  const thumb = T.T1.formats?.thumbnail?.url;
  over('skúšobný obrázok má zmenšeninu thumbnail', typeof thumb === 'string');
  // a) zverejní sa vzhľad s T3
  K = await koncept();
  const P5 = vzhlad(D, { uprav: (v) => (v.cinnost.polozky[0].obrazok = { id: T.T3.id }) });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P5, zakladDb: K.db } });
  over('PUT koncept s T3', r.status === 200, `stav ${r.status} ${r.text.slice(0, 300)}`);
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: 'test-kontraktu fotky' } });
  over('zverejnenie vzhľadu s T3', r.status === 200);
  // b) T1 len v koncepte — podľa id aj podľa mena zmenšeniny v ceste
  K = await koncept();
  const P6 = vzhlad(D, {
    uprav: (v) => {
      v.kategorie[0].obrazok = { id: T.T1.id };
      v.domov.sekcie[3].obrazok = { cesta: `/uploads/${thumb.split('/').pop()}` };
    },
  });
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: P6, zakladDb: K.db } });
  over('PUT koncept s T1 (bez T3)', r.status === 200, `stav ${r.status} ${r.text.slice(0, 300)}`);
  let pu = await api('GET', `${V}/pouzitie-suboru/${T.T1.id}`, { tok: R1 });
  over('redaktor 200: GET /pouzitie-suboru/:id', pu.status === 200 && pu.json?.id === T.T1.id);
  over('použitie T1: koncept podľa id aj podľa mena zmenšeniny (formats)', ['kategorie[0].obrazok', 'domov.sekcie[3].obrazok'].every((c) => pu.json.miesta.some((m) => m.zdroj === 'koncept' && m.cesta === c)) && pu.json.mozeSaZmazat === false, JSON.stringify(pu.json?.miesta));
  let del = await api('DELETE', `/api/upload/files/${T.T1.id}`, { tok: R1 });
  over('zmazanie fotky použitej v koncepte → 409 s vysvetlením po slovensky', del.status === 409 && /Fotku nemožno zmazať/.test(del.json?.error?.message || '') && kod(del) === 'subor-pouzity', `stav ${del.status}`);
  over('fotka po odmietnutí ostala', (await api('GET', `/api/upload/files/${T.T1.id}`, { tok: R1 })).status === 200);
  pu = await api('GET', `${V}/pouzitie-suboru/${T.T3.id}`, { tok: R1 });
  over('použitie T3: zverejnené a história (nie koncept)', pu.json?.miesta?.some((m) => m.zdroj === 'zverejnene') && pu.json.miesta.some((m) => m.zdroj === 'historia') && !pu.json.miesta.some((m) => m.zdroj === 'koncept'));
  del = await api('DELETE', `/api/upload/files/${T.T3.id}`, { tok: R1 });
  over('zmazanie fotky zo zverejneného vzhľadu → 409', del.status === 409);
  // c) T1 z konceptu preč → dá sa zmazať (nikdy nebola zverejnená)
  K = await koncept();
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: vzhlad(D), zakladDb: K.db } });
  del = await api('DELETE', `/api/upload/files/${T.T1.id}`, { tok: R1 });
  over('po odstránení z konceptu sa T1 dá zmazať → 200', r.status === 200 && del.status === 200, `PUT ${r.status}, DELETE ${del.status}`);
  // d) zverejnenie bez T3: T3 ostane len v histórii (posledných 10 verzií chráni)
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1 } });
  pu = await api('GET', `${V}/pouzitie-suboru/${T.T3.id}`, { tok: R1 });
  over('T3 už len v histórii → stále chránená', r.status === 200 && pu.json?.miesta?.length > 0 && pu.json.miesta.every((m) => m.zdroj === 'historia') && pu.json.mozeSaZmazat === false);
  del = await api('DELETE', `/api/upload/files/${T.T3.id}`, { tok: R1 });
  over('zmazanie fotky z histórie (posledných 10) → 409', del.status === 409);
  pu = await api('GET', `${V}/pouzitie-suboru/${D.chranenyNepouzity}`, { tok: R1 });
  over('chránený súbor starých verzií: chraneny=true, vo vzhľade nie je', pu.json?.chraneny === true && pu.json.miesta.length === 0);
  del = await api('DELETE', `/api/upload/files/${D.chranenyNepouzity}`, { tok: R1 });
  over('zmazanie chráneného súboru → 409', del.status === 409 && /staršie verzie webu/.test(del.json?.error?.message || ''), `stav ${del.status}`);
  over('chránený súbor ostal', (await api('GET', `/api/upload/files/${D.chranenyNepouzity}`, { tok: R1 })).status === 200);
  pu = await api('GET', `${V}/pouzitie-suboru/${T.T2.id}`, { tok: R1 });
  over('nepoužitý súbor: mozeSaZmazat=true', pu.json?.mozeSaZmazat === true && pu.json.miesta.length === 0 && pu.json.chraneny === false);
  del = await api('DELETE', `/api/upload/files/${T.T2.id}`, { tok: R1 });
  over('zmazanie nepoužitého súboru → 200 (ako doteraz)', del.status === 200 && del.json?.id === T.T2.id, `stav ${del.status}`);
  over('nepoužitý súbor je zmazaný (404)', (await api('GET', `/api/upload/files/${T.T2.id}`, { tok: R1 })).status === 404);
  if (TC?.id) {
    del = await api('DELETE', `/api/upload/files/${TC.id}`, { tok: R1 });
    over('redaktor zmaže súbor člena → 200', del.status === 200);
  }
  pu = await api('GET', `${V}/pouzitie-suboru/99999999`, { tok: R1 });
  over('použitie neexistujúceho súboru → 404', pu.status === 404);

  /* 11. Lifecycle kategórie */
  sekcia('Lifecycle kategórie (index, počty, vzhľad hneď)');
  const L = D.kategorie.find((k) => k.dokument === D.sKategoriou.kategoria);
  const nazovL = snimkaDb().kategorie.find((k) => k.d === L.dokument).name;
  await api('GET', '/api/search-index?bezTextu=1');
  await api('GET', '/api/pocty-kategorii');
  await verejny();
  r = await api('PUT', `/api/blog-categories/${L.dokument}`, { tok: R1, telo: { data: { name: `${nazovL} (lc)` } } });
  over('premenovanie kategórie (REST) → 200', r.status === 200);
  const idxL = await api('GET', '/api/search-index?bezTextu=1');
  const clL = (idxL.json?.items || []).find((i) => i.slug === D.sKategoriou.slug);
  over('search-index má nový názov kategórie hneď', clL?.categoryName === `${nazovL} (lc)`, clL?.categoryName);
  over('vzhľad (verejný GET) má nový názov kategórie hneď', (await verejny()).json?.kategorie?.[L.dokument]?.nazov === `${nazovL} (lc)`);
  r = await api('PUT', `/api/blog-categories/${L.dokument}`, { tok: R1, telo: { data: { slug: `${L.slug}-lc` } } });
  const pocty = (await api('GET', '/api/pocty-kategorii')).json?.pocty || {};
  over('počty majú nový slug kategórie hneď', r.status === 200 && `${L.slug}-lc` in pocty && !(L.slug in pocty));
  over('search-index má nový slug kategórie hneď', ((await api('GET', '/api/search-index?bezTextu=1')).json?.items || []).find((i) => i.slug === D.sKategoriou.slug)?.categorySlug === `${L.slug}-lc`);
  r = await api('PUT', `/api/blog-categories/${L.dokument}`, { tok: R1, telo: { data: { slug: L.slug, name: nazovL } } });
  over('vrátenie slugu a názvu → počty s pôvodným slugom', r.status === 200 && L.slug in ((await api('GET', '/api/pocty-kategorii')).json?.pocty || {}));

  /* 12. Poistka: predošlý stav v histórii */
  sekcia('Predošlý zverejnený stav je vždy v histórii');
  K = await koncept();
  {
    const dbw = new Database(DB_CESTA, { fileMustExist: true });
    dbw.pragma('busy_timeout = 5000');
    dbw.prepare('delete from vzhlad_webu_verzie where verzia = ?').run(K.verziaZverejnena);
    dbw.close();
  }
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu } });
  const hp = (await api('GET', `${V}/historia`, { tok: R1 })).json?.verzie || [];
  over('chýbajúca predošlá verzia sa pri zverejnení doplní do histórie', r.status === 200 && r.json?.doplnenaPredoslaVerzia === true && hp.some((h) => h.verzia === K.verziaZverejnena) && hp[0].verzia === K.verziaZverejnena + 1);
  const hv = await api('GET', `${V}/historia/${K.verziaZverejnena}`, { tok: R1 });
  over('doplnená verzia má obsah predošlého zverejnenia', rovnake(hv.json?.obsah, K.zverejnene));

  /* 13. Prázdny vzhľad */
  sekcia('Zverejnenie prázdneho vzhľadu (návrat na základný)');
  K = await koncept();
  const sPredPrazdnym = snimkaDb();
  r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: null } });
  over('PUT koncept data:null → 200', r.status === 200);
  r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: 'test-kontraktu prázdny' } });
  const wp = await verejny();
  over('zverejnenie prázdneho → verejný GET data:null, nová verzia', r.status === 200 && wp.json?.data === null && wp.json?.verzia === r.json?.verziaZverejnena && rovnake(wp.json.subory, {}));
  const sP = snimkaDb();
  over('prázdne zverejnenie nezapísalo nič do kategórií ani galérie', r.json?.zapisy?.length === 0 && rovnake(sP.kategorie, sPredPrazdnym.kategorie) && rovnake(sP.galeria, sPredPrazdnym.galeria));
}

/* ───────────── upratovanie ───────────── */

async function uprac() {
  sekcia('Upratovanie: návrat DB do stavu pred testom');
  // 1. kategórie cez REST (lifecycles zmažú pamäť indexu, počtov a vzhľadu)
  const teraz = snimkaDb();
  for (const k of PRED.kategorie) {
    const n = teraz.kategorie.find((x) => x.d === k.d);
    if (n && (n.name !== k.name || n.slug !== k.slug || n.o !== k.o)) {
      const r = await api('PUT', `/api/blog-categories/${k.d}`, { tok: R1, telo: { data: { name: k.name, slug: k.slug, order: k.o } } });
      if (r.status !== 200) log(`  ! kategória ${k.slug}: návrat zlyhal (${r.status})`);
    }
  }
  // 2. galéria: redakcia na ňu nemá REST právo — vráti ju zverejnenie vzhľadu s pôvodným výberom
  if (!rovnake(snimkaDb().galeria, PRED.galeria)) {
    const K = await koncept();
    const v = vzhlad(udajeZDb(), { fotky: PRED.galeria });
    let r = await api('PUT', `${V}/koncept`, { tok: R1, telo: { zaklad: K.verziaKonceptu, data: v, zakladDb: K.db } });
    if (r.status === 200) r = await api('POST', `${V}/zverejnit`, { tok: R1, telo: { zaklad: K.verziaKonceptu + 1, poznamka: 'test-kontraktu upratovanie' } });
    if (r.status !== 200) log(`  ! galéria: návrat zlyhal (${r.status} ${r.text.slice(0, 200)})`);
  }
  // 3. riadok vzhľadu a jeho história priamo v DB (API históriu mazať nevie — zámerne)
  if (tabulkaExistuje('vzhlad_webu')) {
    const dbw = new Database(DB_CESTA, { fileMustExist: true });
    dbw.pragma('busy_timeout = 5000');
    dbw.transaction(() => {
      const povodne = new Set(PRED.historia);
      for (const { id } of dbw.prepare('select id from vzhlad_webu_verzie').all()) {
        if (!povodne.has(id)) dbw.prepare('delete from vzhlad_webu_verzie where id = ?').run(id);
      }
      const predIds = new Set(PRED.vzhlad.map((x) => x.id));
      for (const { id } of dbw.prepare('select id from vzhlad_webu').all()) {
        if (!predIds.has(id)) dbw.prepare('delete from vzhlad_webu where id = ?').run(id);
      }
      for (const row of PRED.vzhlad) {
        const stlpce = Object.keys(row).filter((c) => c !== 'id');
        dbw.prepare(`update vzhlad_webu set ${stlpce.map((c) => `"${c}" = @${c}`).join(', ')} where id = @id`).run(row);
      }
    })();
    dbw.close();
  }
  /* 3b. Časové značky a riadky väzby galérie: návrat cez API ich nastavil na „teraz“ a väzby
     galérie vznikli nanovo s inými id. Obsah je už rovnaký; toto vráti aj tieto stopy, aby
     DB (a odpovede /api/blog-categories s updatedAt) boli presne ako pred testom. Len keď obsah sedí. */
  {
    const s = snimkaDb();
    const dbw = new Database(DB_CESTA, { fileMustExist: true });
    dbw.pragma('busy_timeout = 5000');
    dbw.transaction(() => {
      if (rovnake(s.kategorie, PRED.kategorie)) {
        const u = dbw.prepare('update blog_categories set updated_at = @updated_at, published_at = @published_at where id = @id');
        for (const c of PRED.casy) u.run(c);
      }
      if (rovnake(s.galeria, PRED.galeria)) {
        const u = dbw.prepare('update domovska_galeria set updated_at = @updated_at, published_at = @published_at where id = @id');
        for (const c of PRED.casGalerie) u.run(c);
        dbw.prepare("delete from files_related_mph where related_type = 'api::domovska-galeria.domovska-galeria' and field = 'fotky'").run();
        const stlpce = Object.keys(PRED.vazbyGalerie[0] || {});
        if (stlpce.length) {
          const ins = dbw.prepare(`insert into files_related_mph (${stlpce.map((c) => `"${c}"`).join(', ')}) values (${stlpce.map((c) => `@${c}`).join(', ')})`);
          for (const v of PRED.vazbyGalerie) ins.run(v);
        }
      }
    })();
    dbw.close();
  }
  // 4. skúšobné súbory (po vyčistení histórie už nie sú nikde použité)
  for (const id of nahrate) {
    const r = await api('GET', `/api/upload/files/${id}`, { tok: R1 });
    if (r.status === 404) continue;
    const d = await api('DELETE', `/api/upload/files/${id}`, { tok: R1 });
    if (d.status !== 200) log(`  ! súbor ${id}: zmazanie zlyhalo (${d.status})`);
  }

  // overenie
  const PO = snimkaDb();
  over('upratanie: kategórie (documentId, názov, slug, poradie) ako pred testom', rovnake(PO.kategorie, PRED.kategorie));
  over('upratanie: domovská galéria ako pred testom', rovnake(PO.galeria, PRED.galeria), JSON.stringify(PO.galeria));
  over('upratanie: časové značky kategórií a galérie a väzby galérie ako pred testom', rovnake(PO.casy, PRED.casy) && rovnake(PO.casGalerie, PRED.casGalerie) && rovnake(PO.vazbyGalerie, PRED.vazbyGalerie));
  over('upratanie: riadok vzhľadu ako pred testom (DB)', rovnake(PO.vzhlad, PRED.vzhlad));
  over('upratanie: história vzhľadu ako pred testom (DB)', rovnake(PO.historia, PRED.historia));
  over('upratanie: skúšobné súbory zmazané (počet súborov ako pred testom)', PO.subory.n === PRED.subory.n && dbr.prepare(`select count(*) n from files where id in (${nahrate.map(Number).join(',') || 0})`).get().n === 0);
  over('upratanie: priečinky knižnice médií ako pred testom', PO.priecinky === PRED.priecinky);
  const w = await verejny();
  const v0 = PRED.vzhlad[0]?.verzia_zverejnena ?? 0;
  over('upratanie: verejný GET ako pred testom', w.status === 200 && w.json?.verzia === v0 && (PRED.vzhlad[0]?.zverejnene ? true : w.json?.data === null));
  const K = await koncept();
  over('upratanie: GET /koncept ako pred testom', K.verziaKonceptu === (PRED.vzhlad[0]?.verzia_konceptu ?? 0) && rovnake(K.koncept, PRED.vzhlad[0]?.koncept ? JSON.parse(PRED.vzhlad[0].koncept) : null) && rovnake(K.db.fotogaleria, PRED.galeria));
  const h = (await api('GET', `${V}/historia`, { tok: R1 })).json?.verzie || [];
  over('upratanie: GET /historia ako pred testom', h.length === PRED.historia.length);
  const idx = await api('GET', '/api/search-index?bezTextu=1');
  const L = PRED.kategorie.find((k) => k.d === D.sKategoriou.kategoria);
  over('upratanie: search-index má pôvodné názvy kategórií', (idx.json?.items || []).find((i) => i.slug === D.sKategoriou.slug)?.categoryName === L?.name);
}

let vysledok = 0;
try {
  await hlavnyTest();
} catch (e) {
  over('test dobehol bez výnimky', false, e?.stack || String(e));
} finally {
  try {
    await uprac();
  } catch (e) {
    over('upratovanie dobehlo bez výnimky', false, e?.stack || String(e));
  }
  log(`\nVýsledok: prešlo ${preslo} z ${pocet}${zlyhane.length ? ` — ZLYHALO ${zlyhane.length}:\n  - ${zlyhane.join('\n  - ')}` : ''}`);
  log(`Záznam: ${path.relative(KOREN, VYSTUP)}`);
  vysledok = zlyhane.length ? 1 : 0;
  dbr.close();
}
process.exit(vysledok);
