/**
 * Rozšírenie pluginu upload: ochrana fotiek pred zmazaním (plán, časť 5.3).
 *
 * `DELETE /api/upload/files/:id` (content API — tým maže administrácia webu) vráti 409
 * s vysvetlením, ak je súbor
 *  - použitý vo vzhľade webu (koncept, zverejnené, posledných 10 verzií histórie), alebo
 *  - na zozname chránených súborov starých verzií webu a appky (src/api/vzhlad-webu/chranene-subory.json).
 * Inak sa správa presne ako pôvodná akcia. Ostatné akcie pluginu sa nemenia.
 *
 * Panel Strapi (`/admin`) maže cez iné API a túto ochranu obíde — fotky sa majú mazať
 * v administrácii webu (zapísané v docs/VZHLAD-WEBU-API.md).
 */

export default (plugin: any) => {
  const povodnaTovaren = plugin.controllers['content-api'];

  plugin.controllers['content-api'] = (deps: { strapi: any }) => {
    const ovladac = povodnaTovaren(deps);
    const povodnyDestroy = ovladac.destroy;

    ovladac.destroy = async function destroy(ctx: any) {
      const id = Number(ctx.params?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        const p = await deps.strapi.service('api::vzhlad-webu.vzhlad-webu').pouzitieSuboru(id);
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

    return ovladac;
  };

  return plugin;
};
