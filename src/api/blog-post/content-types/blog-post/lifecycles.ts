import { invalidateSearchIndex } from '../../controllers/blog-post';
import { pamatVzhladu } from '../../../vzhlad-webu/pamat';

/**
 * Pri akejkoľvek zmene článku zneplatní cache vyhľadávacieho indexu, aby sa
 * pri ďalšom dopyte prestaval z čerstvých dát. Lacné — index sa prestaví lenivo
 * až pri prvom hľadaní po zmene, nie hneď.
 *
 * To isté pre vzhľad webu: jeho verejná odpoveď nesie slugy, názvy a titulné fotky
 * článkov, na ktoré odkazuje (a len zverejnených).
 */
const zmaz = () => {
  invalidateSearchIndex();
  pamatVzhladu.zmaz();
};

export default {
  afterCreate: zmaz,
  afterUpdate: zmaz,
  afterDelete: zmaz,
  afterCreateMany: zmaz,
  afterUpdateMany: zmaz,
  afterDeleteMany: zmaz,
};
