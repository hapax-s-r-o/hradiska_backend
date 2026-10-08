#!/usr/bin/env node
/**
 * pridaj-jazyk.cjs — pridá jazykovú verziu (locale) do Strapi.
 *
 * Plugin i18n má zoznam jazykov v databáze, nie v konfigurácii, takže sa
 * nedá pridať nasadením kódu. Cez verejné REST API to tiež nejde (`/api/i18n/
 * locales` je len na čítanie a aj to pre prihláseného), preto sa jazyk zakladá
 * zvnútra Strapi — rovnako ako zápis prekladu.
 *
 * Spúšťa sa TAM, KDE JE DATABÁZA:
 *
 *   node scripts/preklad/pridaj-jazyk.cjs --kod=de --nazov="German (de)"
 *   node scripts/preklad/pridaj-jazyk.cjs --kod=de --nazov="German (de)" --zapis
 *
 * Bez `--zapis` len vypíše, čo by spravil. Keď jazyk už existuje, nerobí nič.
 */

/* CommonJS zámerne — `import` z @strapi/strapi padá na adresárovom importe
   `lodash/fp` vnútri balíka (ERR_UNSUPPORTED_DIR_IMPORT). */
const { resolve } = require('node:path');
const { createStrapi } = require('@strapi/strapi');

const KOREN = resolve(__dirname, '..', '..');
const arg = (m, d = null) => (process.argv.find((a) => a.startsWith(m))?.slice(m.length)) ?? d;
const ZAPIS = process.argv.includes('--zapis');
const KOD = arg('--kod=');
const NAZOV = arg('--nazov=');

if (!KOD) { console.error('chýba --kod=<napr. de>'); process.exit(1); }

(async () => {
  process.chdir(KOREN);
  const app = await createStrapi({ distDir: resolve(KOREN, 'dist') }).load();
  try {
    const sluzba = app.plugin('i18n').service('locales');
    const jestvujuce = await sluzba.find();
    const kody = jestvujuce.map((l) => l.code);
    console.log('jazyky v databáze:', kody.join(', '));

    if (kody.includes(KOD)) {
      console.log(`jazyk ${KOD} už existuje — nerobím nič`);
      return;
    }
    if (!ZAPIS) {
      console.log(`pridal by som ${KOD} (${NAZOV || KOD}) — spusti s --zapis`);
      return;
    }

    const novy = await sluzba.create({ code: KOD, name: NAZOV || KOD, isDefault: false });
    console.log('pridané:', novy.code, '·', novy.name);

    const po = await sluzba.find();
    console.log('jazyky po zápise:', po.map((l) => l.code).join(', '));
  } finally {
    await app.destroy();
  }
})().catch((e) => { console.error(e); process.exit(1); });
