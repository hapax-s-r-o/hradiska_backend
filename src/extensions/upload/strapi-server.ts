/**
 * Rozšírenie pluginu upload: ochrana fotiek (plán, časť 5.3).
 *
 * Zmazanie — `DELETE /api/upload/files/:id` (content API, tým maže administrácia webu) vráti 409
 * s vysvetlením, ak je súbor
 *  - použitý vo vzhľade webu (koncept, zverejnené, posledných 10 verzií histórie), alebo
 *  - na zozname chránených súborov starých verzií webu a appky (src/api/vzhlad-webu/chranene-subory.json).
 *
 * Výmena obsahu — `POST /api/upload?id=<id>` SO súborom. Strapi pri nej ponechá meno a adresu
 * súboru, ale obsah aj zmenšeniny vyrobí nanovo (a zmenšeniny, ktoré nový obrázok nemá, zmiznú).
 *  - Chránený súbor starých verzií (podľa mena v chranene-subory.json) → 409: staré verzie webu
 *    a appky by ukázali iný obrázok alebo prázdne miesto a opraviť sa to dá len novým vydaním.
 *  - Súbor použitý len vo vzhľade → výmena prejde (vzhľad ho odkazuje číslom, ostane mu) a zmaže
 *    sa pamäť verejnej odpovede vzhľadu, lebo sa zmenili rozmery a zmenšeniny.
 * Úprava údajov o súbore (`POST /api/upload?id=<id>` BEZ súboru: meno, popis) sa nemení.
 *
 * Ostatné akcie pluginu sa nemenia. Panel Strapi (`/admin`) používa iné API a túto ochranu
 * obíde — fotky sa majú mazať a vymieňať v administrácii webu (docs/VZHLAD-WEBU-API.md).
 */

import { pamatVzhladu } from '../../api/vzhlad-webu/pamat';

const SLUZBA = 'api::vzhlad-webu.vzhlad-webu';

export default (plugin: any) => {
  const povodnaTovaren = plugin.controllers['content-api'];

  plugin.controllers['content-api'] = (deps: { strapi: any }) => {
    const ovladac = povodnaTovaren(deps);
    const povodnyDestroy = ovladac.destroy;
    const povodnyReplace = ovladac.replaceFile;
    const pouzitie = (id: number) => deps.strapi.service(SLUZBA).pouzitieSuboru(id);
    const platneId = (x: unknown) => {
      const n = Number(x);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };

    ovladac.destroy = async function destroy(ctx: any) {
      const id = platneId(ctx.params?.id);
      if (id) {
        const p = await pouzitie(id);
        if (p && !p.mozeSaZmazat) {
          const dovody: string[] = [];
          if (p.miesta.length) {
            const kde = [...new Set(p.miesta.map((m: any) => (m.zdroj === 'historia' ? `história v${m.verzia}` : m.zdroj === 'koncept' ? 'koncept' : 'zverejnený vzhľad')))];
            dovody.push(`je použitá vo vzhľade webu (${kde.join(', ')})`);
          }
          if (p.chraneny) dovody.push('používajú ju staršie verzie webu a mobilnej aplikácie (chránený súbor)');
          const rada = p.miesta.length ? ' Najprv ju vo vzhľade vymeňte za inú.' : '';
          return ctx.conflict(`Fotku nemožno zmazať: ${dovody.join('; ')}.${rada}`, {
            kod: 'subor-pouzity',
            ...p,
          });
        }
      }
      return povodnyDestroy.call(this, ctx);
    };

    /* `upload` volá `replaceFile` len vtedy, keď prišlo `?id=` aj súbor (bez súboru ide na
       `updateFileInfo`, to ostáva). Volá ho bez `this`, preto sa tu `this` nepoužíva. */
    ovladac.replaceFile = async function replaceFile(ctx: any) {
      const id = platneId(ctx.query?.id);
      const p = id ? await pouzitie(id) : null;
      if (p?.chraneny) {
        return ctx.conflict(
          'Súbor nemožno nahradiť iným: používajú ho staršie verzie webu a mobilnej aplikácie (chránený súbor), ' +
            'ukázali by iný obrázok alebo prázdne miesto. Nahrajte nový súbor a vo vzhľade webu vyberte ten.',
          { kod: 'subor-chraneny', ...p },
        );
      }
      const vysledok = await povodnyReplace(ctx);
      // Zmenil sa obsah, rozmery a zmenšeniny — verejná odpoveď vzhľadu ich nesie.
      pamatVzhladu.zmaz();
      return vysledok;
    };

    return ovladac;
  };

  return plugin;
};
