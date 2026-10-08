#!/usr/bin/env node
/**
 * nemcina-kontrola.mjs — kontrola nemeckých verzií článkov.
 *
 * Robí tri veci, ktoré sa pri angličtine ukázali ako potrebné, a jednu navyše:
 *
 *   1. SLOVENČINA V NEMČINE. Pri angličtine sa takto našlo 11 článkov, ktorým
 *      zrkadlenie štruktúry doplnilo bloky slovenským textom. Počítajú sa
 *      slovenské funkčné slová — vlastné mená a názvy lokalít sa teda
 *      nehlásia (tie v nemeckom texte byť majú).
 *
 *   2. ANGLIČTINA V NEMČINE. Nemecký preklad vzniká zo slovenčiny, ale
 *      prekladateľ má anglickú verziu poruke — keď sa niečo prekopíruje,
 *      je to vidieť na anglických funkčných slovách.
 *
 *   3. ZAKÁZANÉ TERMÍNY zo slovníka: *Burgstall* (v Rakúsku zaniknutý hrad),
 *      *Holz-Erde-Wall* (má byť -Mauer), *Akropolis* pri slovanskom hradisku,
 *      *slowakische* pri 9. storočí, *Slowenen*, *Römerzeit* ako obdobie.
 *
 *   4. NEMECKÝ ZÁPIS ČÍSEL: desatinná bodka (1.5 km) a anglická tisícová
 *      čiarka (35,000) sú v nemčine opačne než treba.
 *
 * Číta verejné API, nič nemení.
 *
 *   node scripts/kontrola/nemcina-kontrola.mjs            # len nálezy
 *   node scripts/kontrola/nemcina-kontrola.mjs --vsetko   # aj čisté články
 */

const API = 'http://188.245.47.29';
const VSETKO = process.argv.includes('--vsetko');
const HRANICA_SK = 4;   // slovenských funkčných slov na článok
const HRANICA_EN = 6;   // anglických funkčných slov na článok

/* Slovenské slová, ktoré nie sú ani nemecké, ani vlastné mená. */
const SLOVENSKE = ['sa', 'je', 'na', 'ktoré', 'ktorý', 'ktorá', 'bol', 'bola', 'boli', 'aby',
  'pre', 'ako', 'tiež', 'veľmi', 'preto', 'však', 'alebo', 'podľa', 'medzi', 'hradisko',
  'hradiska', 'bolo', 'tejto', 'tohto', 'svojho', 'nášho', 'iba', 'už', 'teda', 'okrem'];

/* Anglické slová, ktoré v nemeckom texte nemajú čo robiť. Pozor na slová
   spoločné obom jazykom (*in*, *so*, *was*, *war*, *die*) — tie tu nie sú. */
const ANGLICKE = ['the', 'and', 'with', 'from', 'that', 'this', 'were', 'have', 'been',
  'which', 'their', 'there', 'when', 'where', 'about', 'hillfort', 'hillforts', 'rampart',
  'settlement', 'century', 'during', 'between', 'through', 'however', 'also'];

const vzory = (slova) => slova.map((s) => new RegExp(`(^|[^\\p{L}])${s}([^\\p{L}]|$)`, 'giu'));
const VZORY_SK = vzory(SLOVENSKE);
const VZORY_EN = vzory(ANGLICKE);

/* Termíny, ktoré slovník zakazuje. Kľúč je vzor, hodnota vysvetlenie. */
const ZAKAZANE = [
  [/\bBurgstall\b/g, 'Burgstall → v Rakúsku znamená zaniknutý hrad (§11.1)'],
  [/\bHolz-Erde-Wall\b/g, 'Holz-Erde-Wall → má byť Holz-Erde-Mauer (§11.2)'],
  [/\bAkropolis\b/g, 'Akropolis → pri slovanskom hradisku Hauptburg (§11.3)'],
  [/\bslowakisch\w*\s+(Adlig|Fürst|Siedl|Burgwall|Stamm)/gi, 'slowakisch… pri 9. storočí (§11.9)'],
  [/\bSlowenen\b/g, 'Slowenen → Slovinci, nie Slovania (§12)'],
  [/\bRömerzeit\b/g, 'Römerzeit → ako obdobie die römische Kaiserzeit (§4)'],
  [/\bKärntner\b/g, 'Kärntner → pre 9. storočie Karantanen (§11f)'],
  [/\baltslowakisch\w*/gi, 'altslowakisch → altslawisch (§11f)'],
];

/* Anglický zápis čísel: desatinná bodka a tisícová čiarka. Nemčina má opak.
   Vynechávajú sa roky (1 234 by bolo zle, ale 1234 je rok) a verzie. */
const CISLA = [
  /* Desatinná BODKA (1.5 km). Pozor na nemecký tisícový oddeľovač `1.500` —
     ten má za bodkou práve tri cifry, desatinné miesto jednu či dve. */
  [/\b\d+\.\d{1,2}\s?(km|m|ha|kg|%)(?!\d)/g, 'desatinná bodka → v nemčine čiarka'],
  [/\b\d{1,3}(,\d{3})+\b/g, 'tisícová čiarka → v nemčine bodka'],
  /* Štvorciferné číslo s oddeľovačom (1.500) — nemčina ho nerozdeľuje,
     oddeľovač sa píše až od piatich cifier. */
  [/(?<!\d)[1-9]\.\d{3}(?!\d)/g, 'štvorciferné číslo s oddeľovačom → bez neho'],
];

const textClanku = (clanok) => {
  const von = [];
  const prejdi = (n) => {
    if (Array.isArray(n)) return n.forEach(prejdi);
    if (!n || typeof n !== 'object') return;
    /* BIBLIOGRAFIA SA NEPREKLADÁ (§14), takže anglické názvy diel a adresy
       v nej nie sú chyba — do jazykovej kontroly nepatria. Rovnako odkazy:
       `https://…/history-of-the-hellenic-navy/` obsahuje „the" a nie je to
       angličtina v texte. */
    if (n.__component === 'content.sources') return;
    if (typeof n.url === 'string') return;
    if (typeof n.text === 'string') von.push(n.text);
    for (const v of Object.values(n)) prejdi(v);
  };
  prejdi(clanok.blocks || []);
  for (const p of ['title', 'excerpt', 'metaTitle', 'metaDescription']) {
    if (typeof clanok[p] === 'string') von.push(clanok[p]);
  }
  return von.join('\n');
};

const spocitaj = (text, vzory) =>
  vzory.reduce((n, v) => n + (text.match(v) || []).length, 0);

async function main() {
  const clanky = [];
  for (let page = 1; page <= 20; page++) {
    const q = `${API}/api/blog-posts?locale=de&pagination[page]=${page}&pagination[pageSize]=50`
      + `&fields[0]=slug&fields[1]=title&fields[2]=excerpt&fields[3]=metaTitle&fields[4]=metaDescription`
      + `&populate[blocks][populate]=*`;
    let r;
    for (let pokus = 1; ; pokus++) {
      r = await fetch(q);
      if (r.status === 429 && pokus <= 8) { await new Promise((x) => setTimeout(x, 2000 * pokus)); continue; }
      break;
    }
    if (!r.ok) { console.error(`API ${r.status} na strane ${page}`); process.exit(1); }
    const j = await r.json();
    clanky.push(...(j.data || []));
    const p = j.meta?.pagination;
    if (!p || p.page >= p.pageCount) break;
  }

  let zle = 0;
  for (const c of clanky) {
    const t = textClanku(c);
    const sk = spocitaj(t, VZORY_SK);
    const en = spocitaj(t, VZORY_EN);
    const nalezy = [];
    if (sk >= HRANICA_SK) nalezy.push(`slovenčina ×${sk}`);
    if (en >= HRANICA_EN) nalezy.push(`angličtina ×${en}`);
    for (const [vzor, popis] of ZAKAZANE) {
      const n = (t.match(vzor) || []).length;
      if (n) nalezy.push(`${popis} ×${n}`);
    }
    for (const [vzor, popis] of CISLA) {
      const najdene = t.match(vzor) || [];
      if (najdene.length) nalezy.push(`${popis}: ${najdene.slice(0, 3).join(', ')}`);
    }
    if (nalezy.length) {
      zle++;
      console.log(`• ${c.slug}`);
      for (const n of nalezy) console.log(`    ${n}`);
    } else if (VSETKO) {
      console.log(`  ${c.slug} · čistý (sk ${sk}, en ${en})`);
    }
  }

  console.log(`\noverených ${clanky.length} nemeckých článkov · s nálezom ${zle}`);
  if (!clanky.length) console.log('(žiadne nemecké verzie zatiaľ nie sú)');
}

main().catch((e) => { console.error(e); process.exit(1); });
