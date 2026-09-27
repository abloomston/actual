import type { CategorizationCategory } from '@actual-app/categorization-plugins';

import { getCategories, getNote } from './methods';

/** Load visible and hidden budget categories, including any descriptive notes. */
export async function getCategorizationCategories(): Promise<
  CategorizationCategory[]
> {
  const [visibleCategories, hiddenCategories] = await Promise.all([
    getCategories(),
    getCategories({ hidden: true }),
  ]);
  const categoriesById = new Map(
    [...visibleCategories, ...hiddenCategories].map(category => [
      category.id,
      {
        id: category.id,
        name: category.name,
        group: category.group_id,
      },
    ]),
  );

  return Promise.all(
    [...categoriesById.values()].map(async category => {
      const note = await getNote(category.id);
      return note?.note ? { ...category, note: note.note } : category;
    }),
  );
}
