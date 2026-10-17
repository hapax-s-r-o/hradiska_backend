/**
 * Vzhľad webu — endpointy (cesty v routes/vzhlad.ts, opis v docs/VZHLAD-WEBU-API.md).
 *
 * Verejný je len `GET /api/vzhlad-webu`. Ostatné sú pre redakciu: overenie robí Strapi
 * (prihlásenie + právo na akciu, práva dáva `setupStaffUserPermissions` v src/index.ts)
 * a controller si rolu `authenticated` overí ešte raz sám, ako všade v BE.
 */

import { ChybaApiVzhladu } from '../services/vzhlad-webu';

const SLUZBA = 'api::vzhlad-webu.vzhlad-webu';
const jeRedaktor = (user: any) => user?.role?.type === 'authenticated';

/** Prihlásený redaktor, inak odpoveď 401/403 a false. */
function redaktor(ctx: any): boolean {
  const user = ctx.state?.user;
  if (!user) {
    ctx.unauthorized('Prihláste sa ako redaktor.');
    return false;
  }
  if (!jeRedaktor(user)) {
    ctx.forbidden('Vzhľad webu smie upravovať len redakcia.');
    return false;
  }
  return true;
}

/** Chyby služby → odpoveď v tvare Strapi `{ data: null, error: { status, name, message, details } }`. */
async function spusti(ctx: any, f: () => Promise<unknown>) {
  try {
    const vysledok = await f();
    ctx.body = vysledok;
  } catch (e) {
    if (!(e instanceof ChybaApiVzhladu)) throw e;
    if (e.status === 400) return ctx.badRequest(e.message, e.detaily);
    if (e.status === 404) return ctx.notFound(e.message, e.detaily);
    if (e.status === 409) return ctx.conflict(e.message, e.detaily);
    return ctx.internalServerError(e.message, e.detaily);
  }
}

/** If-None-Match môže mať viac hodnôt aj slabé značky (W/"v3"). */
function zhodaEtag(hlavicka: string | undefined, etag: string): boolean {
  if (!hlavicka) return false;
  return hlavicka
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((s) => s === etag || s === '*');
}

export default ({ strapi }: { strapi: any }) => {
  const sluzba = () => strapi.service(SLUZBA);
  return {
    /** GET /api/vzhlad-webu — verejné. */
    async verejny(ctx: any) {
      const { telo, etag } = await sluzba().verejnaOdpoved();
      ctx.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
      ctx.set('ETag', etag);
      if (zhodaEtag(ctx.get('If-None-Match'), etag)) {
        ctx.status = 304;
        return;
      }
      ctx.type = 'application/json; charset=utf-8';
      ctx.body = telo;
    },

    async koncept(ctx: any) {
      if (!redaktor(ctx)) return;
      ctx.set('Cache-Control', 'no-store');
      await spusti(ctx, () => sluzba().koncept());
    },

    async ulozKoncept(ctx: any) {
      if (!redaktor(ctx)) return;
      await spusti(ctx, () => sluzba().ulozKoncept(ctx.request.body, ctx.state.user));
    },

    async zverejnit(ctx: any) {
      if (!redaktor(ctx)) return;
      await spusti(ctx, () => sluzba().zverejni(ctx.request.body, ctx.state.user));
    },

    async historia(ctx: any) {
      if (!redaktor(ctx)) return;
      ctx.set('Cache-Control', 'no-store');
      await spusti(ctx, () => sluzba().historia());
    },

    async verziaHistorie(ctx: any) {
      if (!redaktor(ctx)) return;
      ctx.set('Cache-Control', 'no-store');
      await spusti(ctx, () => sluzba().verziaHistorie(ctx.params.verzia));
    },

    async obnovit(ctx: any) {
      if (!redaktor(ctx)) return;
      await spusti(ctx, () => sluzba().obnov(ctx.params.verzia, ctx.request.body, ctx.state.user));
    },

    async pouzitieSuboru(ctx: any) {
      if (!redaktor(ctx)) return;
      ctx.set('Cache-Control', 'no-store');
      await spusti(ctx, async () => {
        const p = await sluzba().pouzitieSuboru(ctx.params.id);
        if (!p) throw new ChybaApiVzhladu(404, 'Súbor neexistuje.', { kod: 'neexistuje' });
        return p;
      });
    },
  };
};
