#!/usr/bin/env node
/**
 * Zoznam CHRÁNENÝCH súborov starých verzií webu → src/api/vzhlad-webu/chranene-subory.json
 *
 * Prečo: dnešný web (a Android appka s webom zabaleným v sebe, OTA balíky) má cesty
 * k obrázkom kategórií a činností napísané v kóde (`/uploads/…`). Keby niekto taký súbor
 * zmazal v administrácii, staré verzie by ukázali prázdne dlaždice — a tie sa už nedajú
 * opraviť inak než novým vydaním. Server preto zmazanie týchto súborov odmietne
 * (src/extensions/upload/strapi-server.ts).
 *
 * Zdroj: všetky `/uploads/…` cesty v súboroch FE nižšie, plus varianty, ktoré si web
 * skladá predponou (`thumbnail_`, `small_`, `medium_`, `large_`, viď `variant()`
 * v FE src/data/categories.ts). Porovnáva sa podľa mena súboru.
 *
 * Spustenie (z koreňa BE):  node scripts/vzhlad/chranene-subory.mjs [cesta-k-FE]
 * Predvolená cesta k FE je ../Webdesignforhradiskask. Skript FE len číta.
 * Zoznam sa pri zmene konštánt vo FE pregeneruje a commitne; súbory, ktoré raz
 * boli chránené, sa zo zoznamu NEodstraňujú (staré verzie ich používajú ďalej) —
 * skript preto nové mená k existujúcim pridáva.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const koren = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fe = path.resolve(koren, process.argv[2] || '../Webdesignforhradiskask');
const vystup = path.join(koren, 'src', 'api', 'vzhlad-webu', 'chranene-subory.json');

const ZDROJE = [
  'src/data/categories.ts',
  'src/data/cinnost.ts',
  'src/design-lab/LabAktuality.tsx',
  'src/components/ArticleCard.tsx',
];
const VARIANTY = ['thumbnail', 'small', 'medium', 'large'];
const VZOR = /\/uploads\/([A-Za-z0-9_.\-]+\.[A-Za-z0-9]+)/g;

const nove = new Set();
const zdroje = {};
for (const rel of ZDROJE) {
  const subor = path.join(fe, rel);
  if (!fs.existsSync(subor)) {
    console.error(`Chýba zdrojový súbor FE: ${subor}`);
    process.exit(1);
  }
  /* Komentáre von: v categories.ts je v komentári ukážka `/uploads/Foo.jpg`, to nie je
     súbor webu. Riadkový komentár len za medzerou alebo na začiatku riadka, nech sa
     nezje `https://…` v reťazci. */
  const obsah = fs
    .readFileSync(subor, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const mena = [...obsah.matchAll(VZOR)].map((m) => m[1]);
  zdroje[rel] = [...new Set(mena)].length;
  for (const meno of mena) {
    nove.add(meno);
    for (const v of VARIANTY) nove.add(`${v}_${meno}`);
  }
}

let predosle = [];
if (fs.existsSync(vystup)) {
  try {
    predosle = JSON.parse(fs.readFileSync(vystup, 'utf8')).subory || [];
  } catch {
    predosle = [];
  }
}
const vsetky = [...new Set([...predosle, ...nove])].sort();
const pridane = vsetky.filter((m) => !predosle.includes(m));

const json = {
  popis:
    'Súbory, ktoré používajú staré verzie webu a appky (cesty napísané v kóde FE). Server ich nedovolí zmazať. ' +
    'Generuje scripts/vzhlad/chranene-subory.mjs — ručne neupravovať; mená sa len pridávajú.',
  zdroje,
  subory: vsetky,
};
fs.writeFileSync(vystup, JSON.stringify(json, null, 2) + '\n');
console.log(`Chránených mien: ${vsetky.length} (nových ${pridane.length}) → ${path.relative(koren, vystup)}`);
for (const [rel, n] of Object.entries(zdroje)) console.log(`  ${rel}: ${n} ciest /uploads/…`);
