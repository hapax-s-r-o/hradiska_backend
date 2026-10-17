import { invalidateSearchIndex } from '../../../blog-post/controllers/blog-post';
import { pamatVzhladu } from '../../../vzhlad-webu/pamat';

/**
 * Zmena kategórie (premenovanie, slug, poradie, nová, zmazaná) mení aj vyhľadávací index
 * (názov kategórie pri každom článku), počty podľa slugu a rozriešené kategórie vo vzhľade
 * webu. Bez tohto ostali v pamäti staré až do zmeny nejakého článku alebo reštartu.
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
