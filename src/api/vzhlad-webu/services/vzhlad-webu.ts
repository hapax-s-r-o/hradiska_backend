/**
 * Vzhľad webu — koncept, zverejnenie, história, rozriešenie odkazov a ochrana fotiek.
 *
 * Údaje sú v jednom single type (`koncept`, `zverejnene` ako JSON, plán časť 4) a v kolekcii
 * histórie. Všetko, čo zapisuje, beží v `strapi.db.transaction`: buď prejde celé, alebo nič.
 *
 * Zistenie k transakciám (overené testom scripts/kontrola/vzhlad-api.mjs): Document Service
 * aj `strapi.db.query` si transakciu berú z AsyncLocalStorage (`transactionCtx`), takže volania
 * vnútri `strapi.db.transaction(async () => …)` do nej patria bez odovzdávania `trx`.
 * Na SQLite má knex jediné spojenie — volanie mimo transakcie by na ňu čakalo až do časového
 * limitu (60 s), takže rýchle zverejnenie je zároveň dôkaz, že nič neuteklo mimo nej.
 */

import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import { JAZYKY, LIMITY } from '../typy';
import type { ChybaVzhladu, ClanokVJazyku, Jazyk, Rozriesene, Subor, Vzhlad, ZakladDb } from '../typy';
import { skontrolujOdkazy, skontrolujTvar, skontrolujZakladDb, zbierajOdkazy } from '../kontrola';
import { naplanujZapisy } from '../zlucenie';
import type { ZapisDoDb } from '../zlucenie';
import { pamatVzhladu } from '../pamat';
import chraneneSubory from '../chranene-subory.json';
import { invalidateSearchIndex } from '../../blog-post/controllers/blog-post';

/* UID ako `any`: vygenerované typy ich poznajú až po prvom štarte s novou schémou. */
const UID: any = 'api::vzhlad-webu.vzhlad-webu';
const UID_VERZIA: any = 'api::vzhlad-webu-verzia.vzhlad-webu-verzia';
const UID_KATEGORIA: any = 'api::blog-category.blog-category';
const UID_CLANOK: any = 'api::blog-post.blog-post';
const UID_GALERIA: any = 'api::domovska-galeria.domovska-galeria';
const UID_SUBOR: any = 'plugin::upload.file';

/** Koľko najnovších verzií histórie chráni fotky pred zmazaním (plán 5.3). */
export const CHRANENYCH_VERZII = 10;

/** Poznámka, ktorou test vyvolá chybu uprostred zverejnenia — LEN mimo produkcie a len keď to zapne premenná prostredia. */
export const ZNACKA_SKUSOBNEJ_CHYBY = '__skusobna-chyba__';

const CHRANENE = new Set<string>((chraneneSubory as { subory: string[] }).subory);

/** Chyba s HTTP stavom; controller z nej urobí odpoveď v tvare Strapi `{ data: null, error }`. */
export class ChybaApiVzhladu extends Error {
  constructor(
    public status: 400 | 404 | 409 | 500,
    message: string,
    public detaily: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const neplatne = (chyby: ChybaVzhladu[], sprava = 'Údaje vzhľadu nie sú platné.') =>
  new ChybaApiVzhladu(400, sprava, { kod: 'neplatne-udaje', chyby });

interface Riadok {
  id: number;
  documentId: string;
  koncept: Vzhlad | null;
  zakladDb: ZakladDb | null;
  zverejnene: Vzhlad | null;
  verziaKonceptu: number | null;
  verziaZverejnena: number | null;
  konceptUpravil: string | null;
  konceptUpravene: string | Date | null;
  zverejnilKto: string | null;
  zverejneneKedy: string | Date | null;
}

const iso = (x: unknown): string | null => (x ? new Date(x as string).toISOString() : null);
const jeObjekt = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const kto = (user: any): string => user?.username || (user?.id ? `redaktor #${user.id}` : 'neznámy');
const meno = (url: unknown): string => (typeof url === 'string' ? url.split('?')[0].split('/').pop() || '' : '');

/** Mená súboru v knižnici médií: originál aj všetky zmenšeniny (`formats`). */
export function menaSuboru(f: { url?: string; formats?: Record<string, { url?: string }> | null } | null): string[] {
  if (!f) return [];
  const mena = [meno(f.url)];
  for (const v of Object.values(f.formats || {})) mena.push(meno(v?.url));
  return mena.filter(Boolean);
}

function suborVOdpovedi(f: any): Subor {
  const formats: Subor['formats'] = {};
  for (const k of ['thumbnail', 'small', 'medium', 'large'] as const) {
    const v = f.formats?.[k];
    if (v?.url) formats[k] = { url: v.url, width: v.width ?? null, height: v.height ?? null };
  }
  return {
    id: f.id,
    url: f.url,
    width: f.width ?? null,
    height: f.height ?? null,
    alt: f.alternativeText ?? null,
    formats,
  };
}

/** Celé číslo z tela alebo parametra (null = neplatné). */
function cislo(x: unknown, min: number): number | null {
  const n = typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min ? n : null;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  /* ───────────── čítanie ───────────── */

  const citajRiadok = async (): Promise<Riadok | null> =>
    (await strapi.db.query(UID).findOne({ orderBy: { id: 'asc' } })) as Riadok | null;

  /** Riadok single typu; ak ešte neexistuje, vznikne (volá sa len vnútri transakcie). */
  async function riadokNaZapis(): Promise<Riadok> {
    const r = await citajRiadok();
    if (r) return r;
    await strapi.documents(UID).create({ data: { verziaKonceptu: 0, verziaZverejnena: 0 } as any });
    return (await citajRiadok()) as Riadok;
  }

  async function vsetkyKategorie(): Promise<{ documentId: string; slug: string; name: string; order: number | null }[]> {
    return (await strapi.db.query(UID_KATEGORIA).findMany({
      select: ['documentId', 'slug', 'name', 'order'],
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    })) as any[];
  }

  async function fotkyGalerie(): Promise<number[]> {
    const g: any = await strapi.db.query(UID_GALERIA).findOne({ populate: { fotky: { select: ['id'] } } });
    return (g?.fotky ?? []).map((f: any) => f.id);
  }

  /** Hodnoty v DB, ktoré zverejnenie zapisuje (na trojcestné zlúčenie). `order` bez hodnoty = 100 ako v schéme. */
  async function dbHodnoty(): Promise<ZakladDb> {
    const poradie: Record<string, number> = {};
    const nazvy: Record<string, string> = {};
    for (const k of await vsetkyKategorie()) {
      poradie[k.documentId] = k.order ?? 100;
      nazvy[k.documentId] = k.name;
    }
    return { poradie, nazvy, fotogaleria: await fotkyGalerie() };
  }

  /** Množiny existujúcich odkazov pre `skontrolujOdkazy`. */
  async function znameOdkazy(v: Vzhlad) {
    const o = zbierajOdkazy(v);
    const kategorie = new Set((await vsetkyKategorie()).map((k) => k.documentId));
    const idClankov = [...new Set(o.clanky.map((x) => x.odkaz.dokument).filter((d): d is string => !!d))];
    const clanky = new Set<string>();
    if (idClankov.length) {
      const docs: any[] = await strapi.documents(UID_CLANOK).findMany({
        locale: 'sk',
        status: 'published',
        filters: { documentId: { $in: idClankov } },
        fields: ['slug'],
        start: 0,
        limit: idClankov.length,
      } as any);
      for (const d of docs) clanky.add(d.documentId);
    }
    const idSuborov = [...new Set(o.obrazky.map((x) => x.id).filter((n): n is number => typeof n === 'number'))];
    const subory = new Set<number>();
    if (idSuborov.length) {
      const rows: any[] = await strapi.db.query(UID_SUBOR).findMany({
        where: { id: { $in: idSuborov }, mime: { $startsWith: 'image/' } },
        select: ['id'],
      });
      for (const r of rows) subory.add(r.id);
    }
    return { kategorie, clanky, subory };
  }

  /** Rozriešené súbory, kategórie a články pre jeden alebo viac vzhľadov (napr. koncept + zverejnené). */
  async function rozries(vzhlady: (Vzhlad | null | undefined)[]): Promise<Rozriesene> {
    const platne = vzhlady.filter((v): v is Vzhlad => !!v);
    const vysledok: Rozriesene = { subory: {}, kategorie: {}, clanky: {} };
    if (!platne.length) return vysledok;

    for (const k of await vsetkyKategorie()) {
      vysledok.kategorie[k.documentId] = { slug: k.slug, nazov: k.name, poradie: k.order ?? 100 };
    }

    const odkazy = platne.map(zbierajOdkazy);
    const idClankov = [...new Set(odkazy.flatMap((o) => o.clanky.map((x) => x.odkaz.dokument)).filter((d): d is string => !!d))];
    const idSuborov = new Set(odkazy.flatMap((o) => o.obrazky.map((x) => x.id)).filter((n): n is number => typeof n === 'number'));

    if (idClankov.length) {
      for (const j of JAZYKY as readonly Jazyk[]) {
        const docs: any[] = await strapi.documents(UID_CLANOK).findMany({
          locale: j,
          status: 'published',
          filters: { documentId: { $in: idClankov } },
          fields: ['title', 'slug'],
          populate: { coverImage: { fields: ['url'] } },
          start: 0,
          limit: idClankov.length,
        } as any);
        for (const d of docs) {
          const obrazok = d.coverImage?.id ?? null;
          const zaznam: ClanokVJazyku = { slug: d.slug, nazov: d.title ?? '', obrazok };
          (vysledok.clanky[d.documentId] ||= {})[j] = zaznam;
          if (obrazok) idSuborov.add(obrazok);
        }
      }
    }

    if (idSuborov.size) {
      const rows: any[] = await strapi.db.query(UID_SUBOR).findMany({
        where: { id: { $in: [...idSuborov] } },
        select: ['id', 'url', 'width', 'height', 'alternativeText', 'formats'],
      });
      for (const f of rows) vysledok.subory[String(f.id)] = suborVOdpovedi(f);
    }
    return vysledok;
  }

  const konfliktKonceptu = (r: Riadok) =>
    new ChybaApiVzhladu(
      409,
      `Koncept medzitým uložil ${r.konceptUpravil || 'niekto iný'}${r.konceptUpravene ? ` (${iso(r.konceptUpravene)})` : ''}. Načítajte aktuálny koncept.`,
      {
        kod: 'koncept-zmeneny',
        verziaKonceptu: r.verziaKonceptu ?? 0,
        koncept: r.koncept ?? null,
        zakladDb: r.zakladDb ?? null,
        konceptUpravil: r.konceptUpravil ?? null,
        konceptUpravene: iso(r.konceptUpravene),
      },
    );

  /** Skúšobná chyba uprostred zverejnenia: v produkcii ju nevyvolá nič (ani premenná, ani poznámka). */
  const skusobnaChyba = (poznamka: string | null) =>
    process.env.NODE_ENV !== 'production' &&
    process.env.VZHLAD_SKUSOBNA_CHYBA === '1' &&
    poznamka === ZNACKA_SKUSOBNEJ_CHYBY;

  /** Zápis do existujúcich typov — cez Document Service, aby prebehla validácia schémy a lifecycles (cache). */
  async function vykonajZapisy(zapisy: ZapisDoDb[]): Promise<void> {
    const poKategorii = new Map<string, { order?: number; name?: string }>();
    let galeria: number[] | null = null;
    for (const z of zapisy) {
      if (z.druh === 'fotogaleria') galeria = z.na;
      else {
        const d = poKategorii.get(z.kategoria) || {};
        if (z.druh === 'poradie') d.order = z.na;
        else d.name = z.na;
        poKategorii.set(z.kategoria, d);
      }
    }
    for (const [documentId, data] of poKategorii) {
      const vysl = await strapi.documents(UID_KATEGORIA).update({ documentId, data } as any);
      if (!vysl) throw new ChybaApiVzhladu(409, 'Kategória medzitým zmizla z databázy.', { kod: 'konflikt-db', kategoria: documentId });
    }
    if (galeria) {
      const g: any = await strapi.documents(UID_GALERIA).findFirst({} as any);
      if (g) await strapi.documents(UID_GALERIA).update({ documentId: g.documentId, data: { fotky: galeria } } as any);
      else await strapi.documents(UID_GALERIA).create({ data: { fotky: galeria } } as any);
    }
  }

  /** História: najviac `LIMITY.historia` najnovších verzií. */
  async function orezHistoriu(): Promise<void> {
    const vsetky: any[] = await strapi.db.query(UID_VERZIA).findMany({
      select: ['id'],
      orderBy: [{ verzia: 'desc' }, { id: 'desc' }],
    });
    const nadbytocne = vsetky.slice(LIMITY.historia).map((r) => r.id);
    if (nadbytocne.length) await strapi.db.query(UID_VERZIA).deleteMany({ where: { id: { $in: nadbytocne } } });
  }

  /**
   * Predošlý zverejnený stav musí byť v histórii. Bežne tam už je (každé zverejnenie sa
   * zapisuje do histórie hneď), poistka je pre prípad, že by riadok chýbal (obnova DB a pod.).
   */
  async function doplnPredoslyDoHistorie(r: Riadok): Promise<boolean> {
    const v = r.verziaZverejnena ?? 0;
    if (v < 1) return false;
    const existuje = await strapi.db.query(UID_VERZIA).findOne({ where: { verzia: v }, select: ['id'] });
    if (existuje) return false;
    await strapi.documents(UID_VERZIA).create({
      data: {
        verzia: v,
        obsah: r.zverejnene ?? null,
        zakladDb: null,
        zverejnil: r.zverejnilKto ?? null,
        zverejnene: r.zverejneneKedy ? new Date(r.zverejneneKedy as string) : null,
        poznamka: 'Doplnené pri ďalšom zverejnení (v histórii chýbalo).',
      },
    } as any);
    return true;
  }

  /** Miesta vo vzhľade, kde je súbor použitý — podľa id, alebo podľa mena v ceste /uploads/… (originál či zmenšenina). */
  function miestaVoVzhlade(v: Vzhlad | null | undefined, id: number, mena: Set<string>): { cesta: string; podla: 'id' | 'cesta' }[] {
    if (!v) return [];
    const out: { cesta: string; podla: 'id' | 'cesta' }[] = [];
    for (const o of zbierajOdkazy(v).obrazky) {
      if (o.id === id) out.push({ cesta: o.cesta, podla: 'id' });
      else if (o.subor && o.subor.startsWith('/uploads/') && mena.has(meno(o.subor))) out.push({ cesta: o.cesta, podla: 'cesta' });
    }
    return out;
  }

  return {
    rozries,
    dbHodnoty,

    /** Verejná odpoveď (z pamäte, ak sa verzia v DB nezmenila). */
    async verejnaOdpoved(): Promise<{ verzia: number; telo: string; etag: string }> {
      const gen = pamatVzhladu.generacia();
      const hlava: any = await strapi.db.query(UID).findOne({ select: ['id', 'verziaZverejnena'], orderBy: { id: 'asc' } });
      const verzia = hlava?.verziaZverejnena ?? 0;
      const ulozena = pamatVzhladu.daj(verzia);
      if (ulozena) return ulozena;
      const r = hlava ? await citajRiadok() : null;
      const data = r?.zverejnene ?? null;
      const roz = data ? await rozries([data]) : { subory: {}, kategorie: {}, clanky: {} };
      const telo = JSON.stringify({ data, verzia, ...roz });
      /* ETag z čísla verzie aj z odtlačku tela: telo nesie aj aktuálne slugy a názvy článkov
         a kategórií, takže premenovanie musí dať nový ETag, inak by klient s If-None-Match
         dostal 304 a ostal pri starých. */
      const odtlacok = crypto.createHash('sha1').update(telo).digest('hex').slice(0, 12);
      const zaznam = { verzia, telo, etag: `"v${verzia}-${odtlacok}"` };
      pamatVzhladu.uloz(gen, zaznam);
      return zaznam;
    },

    /** GET /koncept — tvar `OdpovedKonceptu`. */
    async koncept() {
      const r = await citajRiadok();
      const roz = await rozries([r?.koncept, r?.zverejnene]);
      return {
        koncept: r?.koncept ?? null,
        zakladDb: r?.zakladDb ?? null,
        zverejnene: r?.zverejnene ?? null,
        verziaKonceptu: r?.verziaKonceptu ?? 0,
        verziaZverejnena: r?.verziaZverejnena ?? 0,
        konceptUpravil: r?.konceptUpravil ?? null,
        konceptUpravene: iso(r?.konceptUpravene),
        zverejnilKto: r?.zverejnilKto ?? null,
        zverejneneKedy: iso(r?.zverejneneKedy),
        db: await dbHodnoty(),
        ...roz,
      };
    },

    /** PUT /koncept — telo `{ zaklad, data, zakladDb }`. `data: null` = prázdny koncept (web pôjde na základný vzhľad). */
    async ulozKoncept(telo: unknown, user: any) {
      if (!jeObjekt(telo)) throw neplatne([{ cesta: '', sprava: 'Telo musí byť objekt { zaklad, data, zakladDb }.' }]);
      const chyby: ChybaVzhladu[] = [];
      for (const k of Object.keys(telo)) {
        if (!['zaklad', 'data', 'zakladDb'].includes(k)) chyby.push({ cesta: `telo.${k.slice(0, 40)}`, sprava: 'Nepoznaný kľúč v tele dopytu.' });
      }
      const zaklad = cislo(telo.zaklad, 0);
      if (zaklad === null) chyby.push({ cesta: 'zaklad', sprava: 'Chýba alebo je neplatné číslo verzie konceptu, z ktorej úprava vychádza.' });
      if (!('data' in telo)) chyby.push({ cesta: 'data', sprava: 'Chýba povinné pole.' });
      const data = telo.data ?? null;
      if (data !== null) {
        // Cesty chýb vo vzhľade sú relatívne k vzhľadu (rovnako ako v editore), nie k telu dopytu.
        chyby.push(...skontrolujTvar(data));
        chyby.push(...skontrolujZakladDb(telo.zakladDb));
      } else if (telo.zakladDb !== undefined && telo.zakladDb !== null) {
        chyby.push(...skontrolujZakladDb(telo.zakladDb));
      }
      if (chyby.length) throw neplatne(chyby);

      return strapi.db.transaction(async () => {
        const r = await riadokNaZapis();
        if ((r.verziaKonceptu ?? 0) !== zaklad) throw konfliktKonceptu(r);
        if (data !== null) {
          const ch = skontrolujOdkazy(data as Vzhlad, await znameOdkazy(data as Vzhlad));
          if (ch.length) throw neplatne(ch);
        }
        const nova = zaklad + 1;
        const teraz = new Date();
        // Porovnaj a zapíš naraz (WHERE verziaKonceptu = zaklad) — súbeh sa nedá prekĺznuť ani na inej DB než SQLite.
        const { count } = await strapi.db.query(UID).updateMany({
          where: { id: r.id, verziaKonceptu: zaklad },
          data: {
            koncept: data,
            zakladDb: data !== null ? telo.zakladDb : null,
            verziaKonceptu: nova,
            konceptUpravil: kto(user),
            konceptUpravene: teraz,
          },
        });
        if (count !== 1) throw konfliktKonceptu((await citajRiadok()) as Riadok);
        return { verziaKonceptu: nova, konceptUpravil: kto(user), konceptUpravene: teraz.toISOString() };
      });
    },

    /** POST /zverejnit — telo `{ zaklad, poznamka? }`. */
    async zverejni(telo: unknown, user: any) {
      if (!jeObjekt(telo)) throw neplatne([{ cesta: '', sprava: 'Telo musí byť objekt { zaklad, poznamka? }.' }]);
      const chyby: ChybaVzhladu[] = [];
      for (const k of Object.keys(telo)) {
        if (!['zaklad', 'poznamka'].includes(k)) chyby.push({ cesta: `telo.${k.slice(0, 40)}`, sprava: 'Nepoznaný kľúč v tele dopytu.' });
      }
      const zaklad = cislo(telo.zaklad, 0);
      if (zaklad === null) chyby.push({ cesta: 'zaklad', sprava: 'Chýba alebo je neplatné číslo verzie konceptu.' });
      const p = telo.poznamka ?? null;
      if (p !== null && (typeof p !== 'string' || p.length > 200 || /[<>\u0000-\u001F\u007F]/.test(p))) {
        chyby.push({ cesta: 'poznamka', sprava: 'Poznámka je obyčajný text do 200 znakov bez < > a riadiacich znakov.' });
      }
      if (chyby.length) throw neplatne(chyby);
      const poznamka = typeof p === 'string' && p.trim() ? p.trim() : null;

      const vysledok = await strapi.db.transaction(async () => {
        const r = await riadokNaZapis();
        if ((r.verziaKonceptu ?? 0) !== zaklad) throw konfliktKonceptu(r);
        const koncept = r.koncept ?? null;

        // Znova celá kontrola: od uloženia sa mohla zmazať kategória, článok alebo fotka.
        if (koncept) {
          const t = skontrolujTvar(koncept);
          if (t.length) throw neplatne(t, 'Koncept nie je platný, nedá sa zverejniť.');
          const o = skontrolujOdkazy(koncept, await znameOdkazy(koncept));
          if (o.length) throw neplatne(o, 'Koncept odkazuje na niečo, čo už neexistuje. Opravte ho a zverejnite znova.');
        }

        const db = await dbHodnoty();
        const { zapisy, konflikty } = koncept ? naplanujZapisy(koncept, r.zakladDb ?? null, db) : { zapisy: [], konflikty: [] };
        if (konflikty.length) {
          throw new ChybaApiVzhladu(
            409,
            'Niektoré hodnoty v databáze sa od načítania konceptu zmenili (napr. na obrazovke Kategórie). Nezapísalo sa nič — načítajte koncept znova a rozhodnite, ktorá hodnota platí.',
            { kod: 'konflikt-db', konflikty, db },
          );
        }

        const nova = (r.verziaZverejnena ?? 0) + 1;
        const teraz = new Date();
        const doplnene = await doplnPredoslyDoHistorie(r);
        await strapi.documents(UID_VERZIA).create({
          data: { verzia: nova, obsah: koncept, zakladDb: r.zakladDb ?? null, zverejnil: kto(user), zverejnene: teraz, poznamka },
        } as any);

        await vykonajZapisy(zapisy);

        // Koncept je teraz s DB zladený — nový základ sú hodnoty po zápisoch (ďalšie zverejnenie
        // tak neprepíše, čo medzitým zmení niekto iný, a ani to nebude hlásiť ako konflikt).
        const novyZaklad = koncept ? await dbHodnoty() : null;
        const { count } = await strapi.db.query(UID).updateMany({
          where: { id: r.id, verziaKonceptu: zaklad, verziaZverejnena: r.verziaZverejnena ?? 0 },
          data: { zverejnene: koncept, verziaZverejnena: nova, zverejnilKto: kto(user), zverejneneKedy: teraz, zakladDb: novyZaklad },
        });
        if (count !== 1) throw konfliktKonceptu((await citajRiadok()) as Riadok);

        await orezHistoriu();

        if (skusobnaChyba(poznamka)) {
          throw new ChybaApiVzhladu(500, 'Skúšobná chyba po všetkých zápisoch zverejnenia (len mimo produkcie).', {
            kod: 'skusobna-chyba',
            // koľko zápisov do existujúcich typov už prebehlo (test overí, že ich transakcia vrátila)
            zapisov: zapisy.length,
          });
        }

        return {
          verziaZverejnena: nova,
          verziaKonceptu: zaklad,
          zverejnilKto: kto(user),
          zverejneneKedy: teraz.toISOString(),
          zakladDb: novyZaklad,
          zapisy,
          doplnenaPredoslaVerzia: doplnene,
        };
      });
      // Po potvrdení transakcie (lifecycles zmazali pamäť už počas nej; toto je poistka).
      pamatVzhladu.zmaz();
      invalidateSearchIndex();
      return vysledok;
    },

    /** GET /historia — zoznam verzií bez obsahu, najnovšia prvá. */
    async historia() {
      const rows: any[] = await strapi.db.query(UID_VERZIA).findMany({
        select: ['verzia', 'zverejnil', 'zverejnene', 'poznamka'],
        orderBy: [{ verzia: 'desc' }, { id: 'desc' }],
      });
      return {
        verzie: rows.map((r) => ({ verzia: r.verzia, zverejnil: r.zverejnil ?? null, zverejnene: iso(r.zverejnene), poznamka: r.poznamka ?? null })),
      };
    },

    /** GET /historia/:verzia — jedna verzia celá, s rozriešenými odkazmi (náhľad na plátne). */
    async verziaHistorie(param: unknown) {
      const verzia = cislo(param, 1);
      if (verzia === null) throw neplatne([{ cesta: 'verzia', sprava: 'Verzia musí byť kladné celé číslo.' }]);
      const h: any = await strapi.db.query(UID_VERZIA).findOne({ where: { verzia }, orderBy: { id: 'desc' } });
      if (!h) throw new ChybaApiVzhladu(404, `Verzia ${verzia} v histórii nie je.`, { kod: 'neexistuje' });
      return {
        verzia: h.verzia,
        obsah: h.obsah ?? null,
        zakladDb: h.zakladDb ?? null,
        zverejnil: h.zverejnil ?? null,
        zverejnene: iso(h.zverejnene),
        poznamka: h.poznamka ?? null,
        ...(await rozries([h.obsah])),
      };
    },

    /** POST /obnovit/:verzia — skopíruje verziu z histórie do konceptu (nezverejní). Telo `{ zaklad? }`. */
    async obnov(param: unknown, telo: unknown, user: any) {
      const verzia = cislo(param, 1);
      if (verzia === null) throw neplatne([{ cesta: 'verzia', sprava: 'Verzia musí byť kladné celé číslo.' }]);
      const t = jeObjekt(telo) ? telo : {};
      const zaklad = t.zaklad === undefined || t.zaklad === null ? null : cislo(t.zaklad, 0);
      if (t.zaklad !== undefined && t.zaklad !== null && zaklad === null) {
        throw neplatne([{ cesta: 'zaklad', sprava: 'Neplatné číslo verzie konceptu.' }]);
      }
      return strapi.db.transaction(async () => {
        const h: any = await strapi.db.query(UID_VERZIA).findOne({ where: { verzia }, orderBy: { id: 'desc' } });
        if (!h) throw new ChybaApiVzhladu(404, `Verzia ${verzia} v histórii nie je.`, { kod: 'neexistuje' });
        const r = await riadokNaZapis();
        const teraz = r.verziaKonceptu ?? 0;
        if (zaklad !== null && zaklad !== teraz) throw konfliktKonceptu(r);
        const obsah = h.obsah ?? null;
        const nova = teraz + 1;
        const kedy = new Date();
        /* Základ = DB teraz: obnovená verzia má priniesť späť aj svoje poradie, názvy a galériu,
           takže pri zverejnení sa zapíšu ako zámerná zmena (nie ako konflikt so starým základom). */
        const { count } = await strapi.db.query(UID).updateMany({
          where: { id: r.id, verziaKonceptu: teraz },
          data: {
            koncept: obsah,
            zakladDb: obsah ? await dbHodnoty() : null,
            verziaKonceptu: nova,
            konceptUpravil: kto(user),
            konceptUpravene: kedy,
          },
        });
        if (count !== 1) throw konfliktKonceptu((await citajRiadok()) as Riadok);
        return { verziaKonceptu: nova, obnovenaVerzia: verzia, konceptUpravil: kto(user), konceptUpravene: kedy.toISOString() };
      });
    },

    /**
     * Kde je súbor použitý: koncept, zverejnené, posledných `CHRANENYCH_VERZII` verzií histórie,
     * a či je na zozname chránených súborov starých verzií webu. `mozeSaZmazat` = nič z toho.
     * null = súbor neexistuje.
     */
    async pouzitieSuboru(param: unknown) {
      const id = cislo(param, 1);
      if (id === null) throw neplatne([{ cesta: 'id', sprava: 'Id súboru musí byť kladné celé číslo.' }]);
      const subor: any = await strapi.db.query(UID_SUBOR).findOne({ where: { id }, select: ['id', 'name', 'url', 'formats', 'mime'] });
      if (!subor) return null;
      const mena = new Set(menaSuboru(subor));
      const miesta: { zdroj: 'koncept' | 'zverejnene' | 'historia'; verzia?: number; cesta: string; podla: 'id' | 'cesta' }[] = [];
      const r = await citajRiadok();
      for (const m of miestaVoVzhlade(r?.koncept, id, mena)) miesta.push({ zdroj: 'koncept', ...m });
      for (const m of miestaVoVzhlade(r?.zverejnene, id, mena)) miesta.push({ zdroj: 'zverejnene', ...m });
      const verzie: any[] = await strapi.db.query(UID_VERZIA).findMany({
        select: ['verzia', 'obsah'],
        orderBy: [{ verzia: 'desc' }, { id: 'desc' }],
        limit: CHRANENYCH_VERZII,
      });
      for (const v of verzie) for (const m of miestaVoVzhlade(v.obsah, id, mena)) miesta.push({ zdroj: 'historia', verzia: v.verzia, ...m });
      const chraneny = [...mena].some((m) => CHRANENE.has(m));
      return {
        id,
        subor: { id: subor.id, name: subor.name, url: subor.url, mime: subor.mime },
        miesta,
        chraneny,
        mozeSaZmazat: !chraneny && miesta.length === 0,
      };
    },
  };
};
