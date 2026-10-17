#!/usr/bin/env node
/**
 * Overí, že spoločná definícia vzhľadu je v oboch repozitároch bajt po bajte rovnaká:
 *   BE src/api/vzhlad-webu/typy.ts  ==  FE src/lib/vzhlad/typy.ts
 * Pri rozdiele vypíše prvý odlišný riadok a skončí s kódom 1.
 *
 * Spustenie (z koreňa BE):  node scripts/vzhlad/porovnaj-typy.mjs [cesta-k-FE]
 * Predvolená cesta k FE je ../Webdesignforhradiskask.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const koren = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fe = path.resolve(koren, process.argv[2] || '../Webdesignforhradiskask');
const be = path.join(koren, 'src', 'api', 'vzhlad-webu', 'typy.ts');
const feSubor = path.join(fe, 'src', 'lib', 'vzhlad', 'typy.ts');

for (const s of [be, feSubor]) {
  if (!fs.existsSync(s)) {
    console.error(`CHYBA: súbor neexistuje: ${s}`);
    process.exit(1);
  }
}
const a = fs.readFileSync(be);
const b = fs.readFileSync(feSubor);
if (a.equals(b)) {
  console.log(`OK: typy.ts sú rovnaké (${a.length} bajtov).`);
  process.exit(0);
}
const ra = a.toString('utf8').split('\n');
const rb = b.toString('utf8').split('\n');
let i = 0;
while (i < Math.max(ra.length, rb.length) && ra[i] === rb[i]) i++;
console.error(`ROZDIEL: typy.ts sa líšia (BE ${a.length} B, FE ${b.length} B), prvý rozdiel na riadku ${i + 1}:`);
console.error(`  BE: ${JSON.stringify(ra[i] ?? '<koniec súboru>')}`);
console.error(`  FE: ${JSON.stringify(rb[i] ?? '<koniec súboru>')}`);
process.exit(1);
