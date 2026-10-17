/**
 * Odpoveď verejného `GET /api/vzhlad-webu` v pamäti servera.
 *
 * Web ju sťahuje pri každom načítaní stránky, takže sa neskladá zakaždým nanovo
 * (rozriešenie fotiek, kategórií a článkov je niekoľko dopytov do DB). Zmaže sa pri
 * zverejnení a pri zmene článku, kategórie alebo súboru (lifecycles), lebo odpoveď
 * obsahuje ich aktuálne slugy, názvy a adresy.
 *
 * Dve poistky proti starému obsahu:
 *  - záznam platí len pre verziu, ktorú má DB práve teraz (`verziaZverejnena` sa číta
 *    pri každom dopyte — jeden riadok), takže ho neprežije ani zmena DB mimo servera;
 *  - `generacia`: odpoveď, ktorá sa začala skladať pred zmazaním, sa po ňom už neuloží
 *    (inak by ju súbežný dopyt mohol vrátiť do pamäte so starými údajmi).
 */

export interface ZaznamVzhladu {
  verzia: number;
  /** Hotové JSON telo odpovede (neprevádza sa pri každom dopyte znova). */
  telo: string;
}

let zaznam: ZaznamVzhladu | null = null;
let generacia = 0;

export const pamatVzhladu = {
  generacia(): number {
    return generacia;
  },
  daj(verzia: number): ZaznamVzhladu | null {
    return zaznam && zaznam.verzia === verzia ? zaznam : null;
  },
  uloz(gen: number, z: ZaznamVzhladu): void {
    if (gen === generacia) zaznam = z;
  },
  zmaz(): void {
    zaznam = null;
    generacia++;
  },
};
