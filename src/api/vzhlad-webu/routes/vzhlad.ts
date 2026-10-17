/**
 * Cesty vzhľadu webu (plán, časť 5.1). Core router zámerne nie je — ani jeden z dvoch typov
 * nemá bežné REST cesty, všetko ide cez tieto endpointy s vlastnou kontrolou.
 *
 * Redaktorské cesty: bez prihlásenia 401, prihlásený bez práva (člen) 403. Strapi samo by
 * neprihlásenému vrátilo 403 (users-permissions ho berie ako rolu Public), preto je pred
 * stratégiou users-permissions malá stratégia, ktorá požiadavku bez hlavičky Authorization
 * odmietne ako neprihlásenú. Právo na akciu potom overí users-permissions ako všade inde.
 */

const vyzadujPrihlasenie = {
  name: 'vzhlad-webu-prihlasenie',
  authenticate(ctx: any) {
    if (!ctx.request?.header?.authorization) return { error: 'Prihláste sa ako redaktor.' };
    // Hlavička je — overenie tokenu a práv prenecháme users-permissions.
    return { authenticated: false };
  },
};

/* Nový objekt pre každú cestu: Strapi do `config.auth` dopĺňa `scope` (meno akcie) priamo
   v objekte, zdieľaný objekt by dostal scope prvej cesty pre všetky. */
const redaktor = () => ({
  auth: { strategies: [vyzadujPrihlasenie, 'users-permissions'] },
  policies: [],
  middlewares: [],
});

export default {
  type: 'content-api',
  routes: [
    {
      // Zverejnený vzhľad pre web. Verejné: obsahuje len to, čo je na webe aj tak vidieť.
      method: 'GET',
      path: '/vzhlad-webu',
      handler: 'vzhlad-webu.verejny',
      config: { auth: false, policies: [], middlewares: [] },
    },
    { method: 'GET', path: '/vzhlad-webu/koncept', handler: 'vzhlad-webu.koncept', config: redaktor() },
    { method: 'PUT', path: '/vzhlad-webu/koncept', handler: 'vzhlad-webu.ulozKoncept', config: redaktor() },
    { method: 'POST', path: '/vzhlad-webu/zverejnit', handler: 'vzhlad-webu.zverejnit', config: redaktor() },
    { method: 'GET', path: '/vzhlad-webu/historia', handler: 'vzhlad-webu.historia', config: redaktor() },
    { method: 'GET', path: '/vzhlad-webu/historia/:verzia', handler: 'vzhlad-webu.verziaHistorie', config: redaktor() },
    { method: 'POST', path: '/vzhlad-webu/obnovit/:verzia', handler: 'vzhlad-webu.obnovit', config: redaktor() },
    { method: 'GET', path: '/vzhlad-webu/pouzitie-suboru/:id', handler: 'vzhlad-webu.pouzitieSuboru', config: redaktor() },
  ],
};
