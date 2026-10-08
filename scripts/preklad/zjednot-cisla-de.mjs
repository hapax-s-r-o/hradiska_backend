#!/usr/bin/env node
/**
 * zjednot-cisla-de.mjs — zjednotí zápis čísel v nemeckých vstupných súboroch.
 *
 * Nemčina rozdeľuje tisíce bodkou, ale **až od piatich cifier**: `35.000`, no
 * `2000 Jahre`. Štvorciferné číslo sa nerozdeľuje — a je to zároveň poistka
 * proti tomu, aby sa z letopočtu stalo `1.663`.
 *
 * Prekladatelia tú hranicu trafia rôzne (v slovenskom origináli je `1 000`
 * s medzerou), preto sa to pred zápisom do databázy zrovná strojom. Beží to
 * nad priečinkom `preklady-de`, mení len textové polia a je idempotentné.
 *
 *   node scripts/preklad/zjednot-cisla-de.mjs           # len vypíše
 *   node scripts/preklad/zjednot-cisla-de.mjs --zapis   # aj prepíše súbory
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TU = dirname(fileURLToPath(import.meta.url));
const PREKLADY = resolve(TU, 'preklady-de');
const ZAPIS = process.argv.includes('--zapis');

/* Štvorciferné číslo s bodkou: `1.500` → `1500`. Päť a viac cifier
   (`35.000`) sa nechytí, lebo za bodkou nasledujú ďalšie tri cifry a pred
   ňou sú dve — vzor žiada presne jednu cifru pred bodkou. */
const STVORCIFERNE = /(?<!\d)([1-9])\.(\d{3})(?!\d)/g;

/** Polia, v ktorých je text pre čitateľa. Adresy a technické kľúče sa nechytia. */
const TEXTOVE = new Set(['text', 'caption', 'alt', 'value', 'description',
  'excerpt', 'title', 'metaTitle', 'metaDescription', 'year', 'label']);

let zmien = 0;
const prejdi = (uzol) => {
  if (Array.isArray(uzol)) return uzol.map(prejdi);
  if (!uzol || typeof uzol !== 'object') return uzol;
  const von = {};
  for (const [k, v] of Object.entries(uzol)) {
    if (TEXTOVE.has(k) && typeof v === 'string') {
      const novy = v.replace(STVORCIFERNE, (_, a, b) => { zmien++; return a + b; });
      von[k] = novy;
    } else {
      von[k] = prejdi(v);
    }
  }
  return von;
};

const subory = readdirSync(PREKLADY).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const upravene = [];
for (const f of subory) {
  const cesta = resolve(PREKLADY, f);
  const pred = readFileSync(cesta, 'utf8');
  zmien = 0;
  const data = prejdi(JSON.parse(pred));
  if (!zmien) continue;
  upravene.push({ subor: f.slice(0, -5), zmien });
  if (ZAPIS) writeFileSync(cesta, JSON.stringify(data, null, 1), 'utf8');
}

for (const u of upravene) console.log(`• ${u.subor} · ${u.zmien}×`);
console.log(`\nsúborov ${subory.length} · s oddeľovačom pri štvorcifernom čísle ${upravene.length}`);
if (upravene.length && !ZAPIS) console.log('(bez --zapis sa nič neprepísalo)');
if (upravene.length && ZAPIS) console.log('zoznam na prepísanie: ' + upravene.map((u) => u.subor).join(','));
