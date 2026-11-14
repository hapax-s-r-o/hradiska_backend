#!/usr/bin/env node
/**
 * TEST VOĽNÝCH ODKAZOV NA SERVERI — rad pod hľadaním (`domov.odkazy`), tlačidlá a odkazy pod
 * činnosťou (`cinnost.tlacidla`, `cinnost.odkazy`); požiadavka klienta K2, K3 (14. 11. 2026).
 *
 * Beží LEN proti lokálnemu Strapi s kópiou ostrej DB (mení v nej koncept a zverejnený vzhľad):
 *   1. koncept bez nových polí sa uloží (staršie koncepty),
 *   2. koncept s novými poliami sa uloží; odpoveď rozrieši článok (sk/en/de), kategóriu a obrázok,
 *   3. zlé údaje (nepoznaný kľúč, http://, článok bez documentId, neexistujúci súbor) server odmietne 400,
 *   4. zverejnenie: verejné GET vráti nové polia aj rozriešené odkazy; obrázok je chránený
 *      (`pouzitie-suboru` ho hlási ako použitý).
 *
 *   node scripts/kontrola/vzhlad-volne-odkazy.mjs [--url=http://127.0.0.1:1337] [--env=<cesta k .env>] [--zalozit=<vzhlad-v1-odpoved.json>]
 * Tokeny redaktora vyrobí ako `users-permissions` (`jwt.sign({ id }, JWT_SECRET)`); nikam ich nevypisuje.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARG = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const URL_API = (ARG.url || 'http://127.0.0.1:1337').replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_API)) { console.error('Len lokálny server.'); process.exit(2); }
const ENV = dotenv.parse(fs.readFileSync(path.resolve(KOREN, ARG.env || process.env.ENV_PATH || '.env.lokalne-vzhlad')));
const DB = new Database(path.resolve(KOREN, ENV.DATABASE_FILENAME || '.tmp/data.db'), { readonly: true, fileMustExist: true });

let pocet = 0; let preslo = 0;
const over = (n, ok, d = '') => { pocet++; if (ok) preslo++; console.log(`  ${ok ? 'ok   ' : 'CHYBA'} ${n}${!ok && d ? ` — ${d}` : ''}`); };
const kopia = (x) => JSON.parse(JSON.stringify(x));

const redaktor = DB.prepare(`select u.id from up_users u join up_users_role_lnk l on l.user_id = u.id join up_roles r on r.id = l.role_id
  where r.type = 'authenticated' and coalesce(u.blocked,0) = 0 and coalesce(u.confirmed,0) = 1 order by u.id limit 1`).get();
if (!redaktor) { console.error('V DB chýba redaktor.'); process.exit(2); }
const TOK = jwt.sign({ id: redaktor.id }, ENV.JWT_SECRET, { expiresIn: '1h' });

async function api(metoda, cesta, telo) {
  const h = { Authorization: `Bearer ${TOK}` };
  if (telo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(URL_API + cesta, { method: metoda, headers: h, body: telo === undefined ? undefined : JSON.stringify(telo) });
  const t = await r.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch { /* nie JSON */ }
  return { status: r.status, json, text: t };
}
const V = '/api/vzhlad-webu';
const chyby = (r) => (r.json?.error?.details?.chyby || []).map((c) => c.cesta);

/* Údaje z DB: článok so všetkými tromi jazykmi a titulnou fotkou, kategória, súbor. */
const clanok = DB.prepare(`select p.document_id d, p.slug from blog_posts p where p.locale='sk' and p.published_at is not null
  and exists (select 1 from blog_posts q where q.document_id=p.document_id and q.locale='en' and q.published_at is not null)
  and exists (select 1 from blog_posts q where q.document_id=p.document_id and q.locale='de' and q.published_at is not null)
  order by p.id limit 1`).get();
const kategoria = DB.prepare(`select document_id d, slug from blog_categories where slug='informacne-tabule' limit 1`).get()
  || DB.prepare('select document_id d, slug from blog_categories order by id limit 1').get();
const subor = DB.prepare(`select id from files where mime like 'image/%' order by id desc limit 1`).get();
const maxSubor = DB.prepare('select max(id) m from files').get().m;

console.log(`[voľné odkazy – server] ${URL_API}`);
let k = (await api('GET', `${V}/koncept`)).json;
/* Bez konceptu aj zverejneného vzhľadu sa koncept založí zo súboru (`--zalozit=<odpoveď vzhľadu v1>`,
   napr. FE scripts/vzhlad/vystup/vzhlad-v1-odpoved.json — tá istá DB, tie isté documentId). */
if (!k.koncept && !k.zverejnene && ARG.zalozit) {
  const v1 = JSON.parse(fs.readFileSync(path.resolve(ARG.zalozit), 'utf8'));
  const r0 = await api('PUT', `${V}/koncept`, { zaklad: k.verziaKonceptu, data: v1.data ?? v1, zakladDb: k.db });
  over('založenie konceptu zo súboru', r0.status === 200, `${r0.status} ${r0.text.slice(0, 300)}`);
  k = (await api('GET', `${V}/koncept`)).json;
}
const zaklad = k.koncept ?? k.zverejnene;
if (!zaklad) { console.error('Koncept ani zverejnený vzhľad nie je — spustiť s --zalozit=<súbor> alebo najprv založiť v editore.'); process.exit(2); }
const zakladDb = k.koncept ? k.zakladDb : k.db;

const bez = kopia(zaklad);
delete bez.domov.odkazy; delete bez.cinnost.tlacidla; delete bez.cinnost.odkazy;
let r = await api('PUT', `${V}/koncept`, { zaklad: k.verziaKonceptu, data: bez, zakladDb });
over('koncept BEZ nových polí sa uloží (staršie koncepty)', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
k = (await api('GET', `${V}/koncept`)).json;

const s = kopia(bez);
s.domov.odkazy = {
  viditelne: true,
  polozky: [
    { id: 'clanok', text: { sk: 'Článok', en: 'Article', de: 'Artikel', enZo: 'Článok', deZo: 'Článok' }, obrazok: { id: subor.id }, ciel: { druh: 'clanok', clanok: { dokument: clanok.d, slug: clanok.slug } }, viditelny: true },
    { id: 'web', text: { sk: 'Iný web' }, obrazok: null, ciel: { druh: 'url', url: 'https://www.example.org/' }, viditelny: true },
  ],
};
s.cinnost.tlacidla = { viditelne: true, polozky: [{ id: 'tabule', text: { sk: 'Tabule' }, obrazok: null, ciel: { druh: 'kategoria', kategoria: { dokument: kategoria.d, slug: kategoria.slug } }, viditelny: true, hlavny: true }] };
s.cinnost.odkazy = { viditelne: true, polozky: [{ id: 'bez-ciela', text: { sk: 'Bez cieľa' }, obrazok: null, ciel: null, viditelny: false }] };
r = await api('PUT', `${V}/koncept`, { zaklad: k.verziaKonceptu, data: s, zakladDb });
over('koncept S novými poliami sa uloží', r.status === 200, `${r.status} ${r.text.slice(0, 300)}`);
k = (await api('GET', `${V}/koncept`)).json;
over('koncept sa vráti s novými poliami', JSON.stringify(k.koncept?.domov?.odkazy) === JSON.stringify(s.domov.odkazy) && k.koncept?.cinnost?.tlacidla?.polozky?.[0]?.hlavny === true);
const roz = k.clanky?.[clanok.d];
over('server rozriešil článok odkazu v sk, en aj de', !!(roz?.sk?.slug && roz?.en?.slug && roz?.de?.slug), JSON.stringify(roz).slice(0, 200));
over('… obrázok odkazu', !!k.subory?.[String(subor.id)]?.url);
over('… kategóriu tlačidla', k.kategorie?.[kategoria.d]?.slug === kategoria.slug);

const zle = [
  ['nepoznaný kľúč v odkaze', (v) => { v.domov.odkazy.polozky[0].navyse = 1; }, 'domov.odkazy.polozky[0].navyse'],
  ['adresa http://', (v) => { v.domov.odkazy.polozky[1].ciel.url = 'http://www.example.org/'; }, 'domov.odkazy.polozky[1].ciel.url'],
  ['článok bez documentId', (v) => { v.domov.odkazy.polozky[0].ciel.clanok.dokument = null; }, 'domov.odkazy.polozky[0].ciel.clanok'],
  ['neexistujúci súbor', (v) => { v.domov.odkazy.polozky[0].obrazok = { id: maxSubor + 1000 }; }, 'domov.odkazy.polozky[0].obrazok'],
  ['dve rovnaké id', (v) => { v.domov.odkazy.polozky[1].id = 'clanok'; }, 'domov.odkazy.polozky[1].id'],
];
for (const [n, uprav, cesta] of zle) {
  const v = kopia(s); uprav(v);
  r = await api('PUT', `${V}/koncept`, { zaklad: k.verziaKonceptu, data: v, zakladDb: k.zakladDb });
  over(`400: ${n}`, r.status === 400 && chyby(r).includes(cesta), `${r.status} ${chyby(r).join(' | ')}`);
}

k = (await api('GET', `${V}/koncept`)).json;
r = await api('POST', `${V}/zverejnit`, { zaklad: k.verziaKonceptu, poznamka: 'test voľných odkazov' });
over('zverejnenie s novými poliami', r.status === 200, `${r.status} ${r.text.slice(0, 300)}`);
const ver = await fetch(`${URL_API}${V}`).then((x) => x.json());
over('verejné GET vráti nové polia', !!ver.data?.domov?.odkazy && !!ver.data?.cinnost?.tlacidla && !!ver.data?.cinnost?.odkazy);
over('verejné GET rozrieši článok a obrázok odkazu', !!ver.clanky?.[clanok.d]?.en?.slug && !!ver.subory?.[String(subor.id)]);
r = await api('GET', `${V}/pouzitie-suboru/${subor.id}`);
over('obrázok odkazu je chránený (pouzitie-suboru)', r.status === 200 && JSON.stringify(r.json).includes('domov.odkazy'), r.text.slice(0, 300));

console.log(`\n[voľné odkazy – server] prešlo ${preslo} z ${pocet}`);
process.exit(preslo === pocet ? 0 : 1);
