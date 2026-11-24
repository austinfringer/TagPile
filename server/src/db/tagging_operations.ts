import type { Db } from './index.ts';
import { fileHasLocationInLibrary } from './file_operations.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';

export type TagRecord = {
  tag_id: number;
  library_id: number;
  is_category: number;
  file_count: number;
  color: string | null;
  wiki_text: string;
  created_at: string;
  updated_at: string;
};

export type AliasRecord = {
  alias_id: number;
  tag_id: number;
  library_id: number;
  text: string;
  is_primary: number;
  is_shorthand: number;
};

/** An anchor has a time part (`tStart`, optional `tEnd`), a region part (all of `rx`, `ry`,
 *  `rw`, `rh`, as fractions from 0 to 1), or both (see docs/tags.md). */
export type AnchorInput = {
  tStart?: number | null;
  tEnd?: number | null;
  rx?: number | null;
  ry?: number | null;
  rw?: number | null;
  rh?: number | null;
};

export type FileValue =
  | { valueId: number; kind: 'text'; text: string }
  | { valueId: number; kind: 'number'; number: number }
  | { valueId: number; kind: 'tag'; refTagId: number }
  | {
      valueId: number;
      kind: 'anchor';
      tStart: number | null;
      tEnd: number | null;
      rx: number | null;
      ry: number | null;
      rw: number | null;
      rh: number | null;
    };

export type FileValueUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number }
  | { kind: 'anchor'; anchor: AnchorInput };

export type TagValue =
  | { valueId: number; kind: 'text'; text: string }
  | { valueId: number; kind: 'number'; number: number }
  | { valueId: number; kind: 'tag'; refTagId: number }
  | { valueId: number; kind: 'parent'; primary: boolean }
  | { valueId: number; kind: 'component'; recursive: boolean; attributed: boolean };

export type TagValueUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number }
  | { kind: 'parent'; primary: boolean }
  | { kind: 'component'; recursive: boolean; attributed: boolean };

export type FileInstance = { tagId: number; name: string | null; values: FileValue[] };

export type TagListItem = {
  tagId: number;
  name: string;
  color: string | null;
  isCategory: boolean;
  fileCount: number;
  parentName: string | null;
};

export type TagHierarchyItem = {
  tagId: number;
  name: string | null;
  color: string | null;
};

export type TagDetail = {
  tag: TagRecord;
  aliases: AliasRecord[];
  instances: { tagId: number; name: string | null; values: TagValue[] }[];
  parents: TagHierarchyItem[];
  ancestors: TagHierarchyItem[];
  children: TagHierarchyItem[];
  descendants: TagHierarchyItem[];
  tags: Record<number, TagListItem>;
};

const now = () => new Date().toISOString();

export function getTag(db: Db, tagId: number): TagRecord | undefined {
  return db.prepare(`SELECT * FROM tags WHERE tag_id = ?`).get(tagId) as TagRecord | undefined;
}

/** Returns the tag, or throws NotFoundError when it does not exist or is in another library. */
export function requireTagInLibrary(db: Db, tagId: number, libraryId: number): TagRecord {
  const tag = getTag(db, tagId);
  if (!tag || tag.library_id !== libraryId) {
    throw new NotFoundError(`Tag ${tagId} not found in library ${libraryId}`);
  }
  return tag;
}

function requireTag(db: Db, tagId: number): TagRecord {
  const tag = getTag(db, tagId);
  if (!tag) throw new NotFoundError(`Tag ${tagId} not found`);
  return tag;
}

function touchTag(db: Db, tagId: number) {
  db.prepare(`UPDATE tags SET updated_at = ? WHERE tag_id = ?`).run(now(), tagId);
}

/** Trims the alias text. Rejects a non-string, an empty text, and the reserved text `*`. */
export function validateAliasText(text: unknown): string {
  if (typeof text !== 'string') throw new ValidationError('Alias text must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new ValidationError('Alias text must not be empty');
  if (trimmed === '*') throw new ValidationError('Alias text "*" is reserved');
  return trimmed;
}

function validateColor(color: unknown): string | null {
  if (color === null || color === undefined) return null;
  if (typeof color !== 'string') throw new ValidationError('Color must be a string or null');
  const trimmed = color.trim();
  return trimmed === '' ? null : trimmed;
}

function directParentsOf(db: Db, tagId: number): number[] {
  return db
    .prepare(`SELECT tag_id FROM tag_tag_values WHERE subject_tag_id = ? AND kind = 'parent'`)
    .all(tagId)
    .map((row) => (row as { tag_id: number }).tag_id);
}

function aliasTextsOf(db: Db, tagId: number): string[] {
  return db
    .prepare(`SELECT text FROM aliases WHERE tag_id = ?`)
    .all(tagId)
    .map((row) => (row as { text: string }).text);
}

/** Alias text is unique among siblings (docs/tags.md "Parents and names"). Throws ConflictError
 *  when another tag in the library has one of `texts` and shares a direct parent in
 *  `parentIds`, or when `parentIds` is empty and the other tag is a root too. `parentIds`
 *  defaults to the current direct parents of `tagId`. */
export function assertSiblingUnique(
  db: Db,
  tagId: number,
  texts: string[],
  parentIds: number[] = directParentsOf(db, tagId),
) {
  const tag = requireTag(db, tagId);
  const underParent = db.prepare(
    `SELECT a.tag_id FROM aliases a
     JOIN tag_tag_values v ON v.subject_tag_id = a.tag_id AND v.kind = 'parent'
     WHERE a.library_id = ? AND a.text = ? AND a.tag_id != ?
       AND v.tag_id IN (SELECT value FROM json_each(?))
     LIMIT 1`,
  );
  const amongRoots = db.prepare(
    `SELECT a.tag_id FROM aliases a
     WHERE a.library_id = ? AND a.text = ? AND a.tag_id != ?
       AND NOT EXISTS (
         SELECT 1 FROM tag_tag_values v WHERE v.subject_tag_id = a.tag_id AND v.kind = 'parent'
       )
     LIMIT 1`,
  );
  for (const text of texts) {
    const clash = (
      parentIds.length > 0
        ? underParent.get(tag.library_id, text, tagId, JSON.stringify(parentIds))
        : amongRoots.get(tag.library_id, text, tagId)
    ) as { tag_id: number } | undefined;
    if (clash) {
      throw new ConflictError(
        parentIds.length > 0
          ? `Alias "${text}" is already used by sibling tag ${clash.tag_id}`
          : `Alias "${text}" is already used by root tag ${clash.tag_id}`,
      );
    }
  }
}

/** Creates a tag with `alias` as its primary alias, in one transaction. When `parentId` is
 *  set, the tag gets that parent (see createParentTagValue). Returns the new tag id. */
export function createTag(
  db: Db,
  {
    alias,
    libraryId,
    color,
    isCategory = false,
    parentId,
    wikiText = '',
  }: {
    alias: string;
    libraryId: number;
    color?: string | null;
    isCategory?: boolean;
    parentId?: number;
    wikiText?: string;
  },
): number {
  const text = validateAliasText(alias);
  const tagColor = validateColor(color);
  if (typeof wikiText !== 'string') throw new ValidationError('Wiki text must be a string');
  return db.transaction(() => {
    const createdAt = now();
    const tagId = Number(
      db
        .prepare(
          `INSERT INTO tags (library_id, is_category, color, wiki_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(libraryId, isCategory ? 1 : 0, tagColor, wikiText, createdAt, createdAt)
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO aliases (tag_id, library_id, text, is_primary) VALUES (?, ?, ?, 1)`,
    ).run(tagId, libraryId, text);
    db.prepare(`INSERT INTO tag_ancestors (ancestor_id, descendant_id) VALUES (?, ?)`).run(
      tagId,
      tagId,
    );
    if (parentId !== undefined) {
      requireTagInLibrary(db, parentId, libraryId);
      //Checks the alias against the parent's other children.
      createParentTagValue(db, tagId, parentId);
    } else {
      assertSiblingUnique(db, tagId, [text], []);
    }
    return tagId;
  })();
}

/** Changes the given fields of the tag and sets `updated_at`. */
export function updateTag(
  db: Db,
  tagId: number,
  libraryId: number,
  {
    color,
    isCategory,
    wikiText,
  }: { color?: string | null; isCategory?: boolean; wikiText?: string },
) {
  requireTagInLibrary(db, tagId, libraryId);
  const sets = ['updated_at = ?'];
  const params: (string | number | null)[] = [now()];
  if (color !== undefined) {
    sets.push('color = ?');
    params.push(validateColor(color));
  }
  if (isCategory !== undefined) {
    sets.push('is_category = ?');
    params.push(isCategory ? 1 : 0);
  }
  if (wikiText !== undefined) {
    if (typeof wikiText !== 'string') throw new ValidationError('Wiki text must be a string');
    sets.push('wiki_text = ?');
    params.push(wikiText);
  }
  db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE tag_id = ?`).run(...params, tagId);
}

//Closure maintenance. `tag_ancestors` is derived from the `parent` values, so any change
//to the parent edges — removing one (untagTag, deleteTagValue) or deleting a tag — repairs
//the rows of the affected tag and its descendants in the same transaction (see docs/tags.md).

function properDescendantsOf(db: Db, tagId: number) {
  return db
    .prepare(`SELECT descendant_id FROM tag_ancestors WHERE ancestor_id = ? AND descendant_id != ?`)
    .all(tagId, tagId)
    .map((row) => (row as { descendant_id: number }).descendant_id);
}

/** Clears the non-self ancestor rows of each tag in `tagIds` and rebuilds them from the
 *  `parent` values that remain. The rebuild climbs the parent edges themselves, so the
 *  result does not depend on the (possibly stale) closure rows of other tags. */
function rebuildAncestorsOf(db: Db, tagIds: number[]) {
  const clearAncestors = db.prepare(
    `DELETE FROM tag_ancestors WHERE descendant_id = ? AND ancestor_id != ?`,
  );
  const rebuildAncestors = db.prepare(
    `INSERT OR IGNORE INTO tag_ancestors (ancestor_id, descendant_id)
     WITH RECURSIVE parents (tag_id) AS (
       SELECT v.tag_id FROM tag_tag_values v
       WHERE v.subject_tag_id = ? AND v.kind = 'parent'
       UNION
       SELECT v.tag_id FROM tag_tag_values v
       JOIN parents p ON v.subject_tag_id = p.tag_id
       WHERE v.kind = 'parent'
     )
     SELECT tag_id, ? FROM parents`,
  );
  for (const tagId of tagIds) {
    clearAncestors.run(tagId, tagId);
    rebuildAncestors.run(tagId, tagId);
  }
}

function hasParentValue(db: Db, subjectTagId: number, tagId: number) {
  return (
    db
      .prepare(
        `SELECT 1 FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ? AND kind = 'parent' LIMIT 1`,
      )
      .get(subjectTagId, tagId) !== undefined
  );
}

/** Repairs the closure after a `parent` edge from `subjectTagId` was removed: the rows of
 *  the subject and its descendants are rebuilt from the edges that remain. Removing an edge
 *  that points up cannot change which tags sit below the subject, so reading the descendants
 *  from the closure after the delete still gives the right set. */
function repairClosureAfterEdgeRemoval(db: Db, subjectTagId: number) {
  const descendants = properDescendantsOf(db, subjectTagId);
  rebuildAncestorsOf(db, [subjectTagId, ...descendants]);
}

/** After a `parent` value of the subject was removed: repairs the closure, and checks the
 *  subject's aliases against its remaining siblings (it can have become a root). */
function afterParentRemoval(db: Db, subjectTagId: number) {
  repairClosureAfterEdgeRemoval(db, subjectTagId);
  assertSiblingUnique(db, subjectTagId, aliasTextsOf(db, subjectTagId));
}

/** Deletes the tag and repairs the closure: descendants of the tag lose the rows that
 *  only existed through it, so their ancestor rows are rebuilt from the parent edges
 *  that remain (see docs/tags.md). Throws ConflictError when a child that becomes a root
 *  has an alias that another root already uses. */
export function deleteTag(db: Db, tagId: number, libraryId: number) {
  requireTagInLibrary(db, tagId, libraryId);
  db.transaction(() => {
    const descendants = properDescendantsOf(db, tagId);
    const children = db
      .prepare(`SELECT subject_tag_id FROM tag_tag_values WHERE tag_id = ? AND kind = 'parent'`)
      .all(tagId)
      .map((row) => (row as { subject_tag_id: number }).subject_tag_id);
    //Values that point at instances of this tag: the foreign key only cascades their
    //payload rows.
    db.prepare(
      `DELETE FROM file_tag_values WHERE value_id IN
         (SELECT value_id FROM file_tag_value_tag WHERE ref_tag_id = ?)`,
    ).run(tagId);
    db.prepare(
      `DELETE FROM tag_tag_values WHERE value_id IN
         (SELECT value_id FROM tag_tag_value_tag WHERE ref_tag_id = ?)`,
    ).run(tagId);
    db.prepare(`DELETE FROM tags WHERE tag_id = ?`).run(tagId);
    for (const child of children) {
      if (directParentsOf(db, child).length === 0) {
        assertSiblingUnique(db, child, aliasTextsOf(db, child), []);
      }
    }
    rebuildAncestorsOf(db, descendants);
  })();
}

//Alias Management

/** Adds a non-primary alias. Its `library_id` comes from the tag. Returns the alias id. */
export function addAlias(db: Db, tagId: number, text: string, libraryId: number): number {
  const aliasText = validateAliasText(text);
  return db.transaction(() => {
    const tag = requireTagInLibrary(db, tagId, libraryId);
    if (aliasTextsOf(db, tagId).includes(aliasText)) {
      throw new ConflictError(`Tag ${tagId} already has the alias "${aliasText}"`);
    }
    assertSiblingUnique(db, tagId, [aliasText]);
    const aliasId = Number(
      db
        .prepare(`INSERT INTO aliases (tag_id, library_id, text, is_primary) VALUES (?, ?, ?, 0)`)
        .run(tagId, tag.library_id, aliasText).lastInsertRowid,
    );
    touchTag(db, tagId);
    return aliasId;
  })();
}

function findAliasByText(db: Db, tagId: number, text: string): AliasRecord {
  const alias = db
    .prepare(`SELECT * FROM aliases WHERE tag_id = ? AND text = ?`)
    .get(tagId, text) as AliasRecord | undefined;
  if (!alias) throw new NotFoundError(`Alias "${text}" not found on tag ${tagId}`);
  return alias;
}

/** Deletes the alias. When it was the primary, the oldest remaining alias becomes primary.
 *  The last alias of a tag cannot be deleted. */
function removeAlias(db: Db, tagId: number, target: AliasRecord) {
  const remaining = db
    .prepare(
      `SELECT alias_id FROM aliases WHERE tag_id = ? AND alias_id != ? ORDER BY alias_id LIMIT 1`,
    )
    .get(tagId, target.alias_id) as { alias_id: number } | undefined;
  if (!remaining) {
    throw new ConflictError(`Cannot delete the last alias of tag ${tagId}`);
  }
  db.prepare(`DELETE FROM aliases WHERE alias_id = ?`).run(target.alias_id);
  if (target.is_primary === 1) {
    db.prepare(`UPDATE aliases SET is_primary = 1 WHERE alias_id = ?`).run(remaining.alias_id);
  }
  touchTag(db, tagId);
}

export function deleteAlias(db: Db, tagId: number, text: string, libraryId: number) {
  db.transaction(() => {
    requireTagInLibrary(db, tagId, libraryId);
    removeAlias(db, tagId, findAliasByText(db, tagId, text));
  })();
}

export function deleteAliasById(db: Db, tagId: number, aliasId: number, libraryId: number) {
  db.transaction(() => {
    removeAlias(db, tagId, getAliasById(db, tagId, aliasId, libraryId));
  })();
}

export function getAliasById(
  db: Db,
  tagId: number,
  aliasId: number,
  libraryId: number,
): AliasRecord {
  requireTagInLibrary(db, tagId, libraryId);
  const alias = db
    .prepare(`SELECT * FROM aliases WHERE alias_id = ? AND tag_id = ?`)
    .get(aliasId, tagId) as AliasRecord | undefined;
  if (!alias) throw new NotFoundError(`Alias ${aliasId} not found on tag ${tagId}`);
  return alias;
}

/** Sets one flag column on exactly one alias of the tag. An unknown alias throws
 *  NotFoundError and changes nothing. */
function setAliasFlag(
  db: Db,
  tagId: number,
  text: string,
  libraryId: number,
  column: 'is_primary' | 'is_shorthand',
) {
  db.transaction(() => {
    requireTagInLibrary(db, tagId, libraryId);
    const alias = findAliasByText(db, tagId, text);
    //Only one alias can hold the flag per tag. Flip all to 0, then set the new one to 1.
    db.prepare(`UPDATE aliases SET ${column} = 0 WHERE tag_id = ?`).run(tagId);
    db.prepare(`UPDATE aliases SET ${column} = 1 WHERE alias_id = ?`).run(alias.alias_id);
    touchTag(db, tagId);
  })();
}

export function setAliasPrimary(db: Db, tagId: number, text: string, libraryId: number) {
  setAliasFlag(db, tagId, text, libraryId, 'is_primary');
}

export function setAliasShorthand(db: Db, tagId: number, text: string, libraryId: number) {
  setAliasFlag(db, tagId, text, libraryId, 'is_shorthand');
}

/** Updates the text of an existing alias on the tag, checking for duplicate and sibling clashes. */
export function updateAliasText(
  db: Db,
  tagId: number,
  aliasId: number,
  text: string,
  libraryId: number,
) {
  const aliasText = validateAliasText(text);
  db.transaction(() => {
    const alias = getAliasById(db, tagId, aliasId, libraryId);
    if (alias.text === aliasText) return;
    if (aliasTextsOf(db, tagId).includes(aliasText)) {
      throw new ConflictError(`Tag ${tagId} already has the alias "${aliasText}"`);
    }
    assertSiblingUnique(db, tagId, [aliasText]);
    db.prepare(`UPDATE aliases SET text = ? WHERE alias_id = ?`).run(aliasText, aliasId);
    touchTag(db, tagId);
  })();
}

/** Clears `is_shorthand` on one alias of the tag. */
export function clearAliasShorthand(db: Db, tagId: number, aliasId: number, libraryId: number) {
  db.transaction(() => {
    getAliasById(db, tagId, aliasId, libraryId);
    db.prepare(`UPDATE aliases SET is_shorthand = 0 WHERE alias_id = ?`).run(aliasId);
    touchTag(db, tagId);
  })();
}

/** Clears `is_primary` on one alias of the tag, promoting the oldest other alias when one exists. */
export function clearAliasPrimary(db: Db, tagId: number, aliasId: number, libraryId: number) {
  db.transaction(() => {
    getAliasById(db, tagId, aliasId, libraryId);
    db.prepare(`UPDATE aliases SET is_primary = 0 WHERE alias_id = ?`).run(aliasId);
    const hasPrimary = db
      .prepare(`SELECT 1 FROM aliases WHERE tag_id = ? AND is_primary = 1 LIMIT 1`)
      .get(tagId);
    if (!hasPrimary) {
      const fallback = db
        .prepare(
          `SELECT alias_id FROM aliases WHERE tag_id = ? AND alias_id != ? ORDER BY alias_id LIMIT 1`,
        )
        .get(tagId, aliasId) as { alias_id: number } | undefined;
      if (fallback) {
        db.prepare(`UPDATE aliases SET is_primary = 1 WHERE alias_id = ?`).run(fallback.alias_id);
      }
    }
    touchTag(db, tagId);
  })();
}

//Alias Tag Interactions

export function getTagPrimaryAlias(
  db: Db,
  tagId: number,
  libraryId: number,
): AliasRecord | undefined {
  return db
    .prepare(`SELECT * FROM aliases WHERE tag_id = ? AND library_id = ? AND is_primary = 1`)
    .get(tagId, libraryId) as AliasRecord | undefined;
}

export function getTagShorthand(db: Db, tagId: number, libraryId: number): AliasRecord | undefined {
  return db
    .prepare(`SELECT * FROM aliases WHERE tag_id = ? AND library_id = ? AND is_shorthand = 1`)
    .get(tagId, libraryId) as AliasRecord | undefined;
}

export function searchTagByAlias(
  db: Db,
  alias: string,
  libraryId: number,
): { tag_id: number } | undefined {
  return db
    .prepare(`SELECT tag_id FROM aliases WHERE text = ? AND library_id = ?`)
    .get(alias, libraryId) as { tag_id: number } | undefined;
}

/** The aliases of the tag, primary first. */
export function getTagAliases(db: Db, tagId: number, libraryId: number): AliasRecord[] {
  return db
    .prepare(
      `SELECT * FROM aliases WHERE tag_id = ? AND library_id = ? ORDER BY is_primary DESC, alias_id`,
    )
    .all(tagId, libraryId) as AliasRecord[];
}

//Add and remove relationships

type componentEdgeRecord = {
  component_tag_id: number;
  recursive: number;
  attributed: number;
};

function requireFileInLibrary(db: Db, fileId: number, libraryId: number) {
  if (!fileHasLocationInLibrary(db, fileId, libraryId)) {
    throw new NotFoundError(`File ${fileId} has no location in library ${libraryId}`);
  }
}

function fileHasInstance(db: Db, fileId: number, tagId: number) {
  return (
    db
      .prepare(`SELECT 1 FROM file_tag_relationships WHERE file_id = ? AND tag_id = ?`)
      .get(fileId, tagId) !== undefined
  );
}

/** Applies `tagId` to the file, flattened: the tag's component tags come along (see docs/tags.md).
 *  The file must have a location in `libraryId` — a library may only tag content in it. */
export function tagFile(db: Db, fileId: number, tagId: number, libraryId: number) {
  requireTagInLibrary(db, tagId, libraryId);
  requireFileInLibrary(db, fileId, libraryId);

  db.transaction(() => {
    const insertInstance = db.prepare(
      `INSERT OR IGNORE INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)`,
    );
    const incrementCount = db.prepare(
      `UPDATE tags SET file_count = file_count + 1 WHERE tag_id = ?`,
    );
    //A re-tag adds no instance, so the count only moves when the insert does.
    const addInstance = (addedTagId: number) => {
      if (insertInstance.run(fileId, addedTagId).changes > 0) incrementCount.run(addedTagId);
    };
    addInstance(tagId);

    const findLink = db.prepare(
      `SELECT 1 FROM file_tag_values v
       JOIN file_tag_value_tag t ON t.value_id = v.value_id
       WHERE v.file_id = ? AND v.tag_id = ? AND v.kind = 'tag' AND t.ref_tag_id = ? LIMIT 1`,
    );
    const insertValue = db.prepare(
      `INSERT INTO file_tag_values (file_id, tag_id, kind) VALUES (?, ?, 'tag')`,
    );
    const insertValueTag = db.prepare(
      `INSERT INTO file_tag_value_tag (value_id, file_id, ref_tag_id) VALUES (?, ?, ?)`,
    );
    //Links instance (file, fromTagId) at instance (file, toTagId), at most one per pair.
    const ensureLink = (fromTagId: number, toTagId: number) => {
      if (findLink.get(fileId, fromTagId, toTagId)) return;
      const valueId = insertValue.run(fileId, fromTagId).lastInsertRowid;
      insertValueTag.run(valueId, fileId, toTagId);
    };

    const componentEdges = db.prepare(
      `SELECT v.tag_id AS component_tag_id, c.recursive, c.attributed
       FROM tag_tag_values v
       JOIN tag_tag_value_component c ON c.value_id = v.value_id
       WHERE v.subject_tag_id = ? AND v.kind = 'component'`,
    );

    //One instance per (file, tag); the visited set keeps cycles from recursing forever.
    const visited = new Set<number>([tagId]);
    const applyComponents = (subjectTagId: number) => {
      for (const edge of componentEdges.all(subjectTagId) as componentEdgeRecord[]) {
        addInstance(edge.component_tag_id);
        if (edge.attributed) ensureLink(edge.component_tag_id, subjectTagId);
        if (edge.recursive && !visited.has(edge.component_tag_id)) {
          visited.add(edge.component_tag_id);
          applyComponents(edge.component_tag_id);
        }
      }
    };
    applyComponents(tagId);
  })();
}

export function untagFile(db: Db, fileId: number, tagId: number, libraryId: number) {
  requireTagInLibrary(db, tagId, libraryId);
  db.transaction(() => {
    //The foreign key only cascades the payload rows of values that point at this
    //instance; their base rows go here.
    db.prepare(
      `DELETE FROM file_tag_values WHERE value_id IN
         (SELECT value_id FROM file_tag_value_tag WHERE file_id = ? AND ref_tag_id = ?)`,
    ).run(fileId, tagId);
    const removed = db
      .prepare(`DELETE FROM file_tag_relationships WHERE file_id = ? AND tag_id = ?`)
      .run(fileId, tagId);
    if (removed.changes > 0) {
      db.prepare(`UPDATE tags SET file_count = file_count - 1 WHERE tag_id = ?`).run(tagId);
    }
  })();
}

/** Deletes every value of the instance of `tagId` on the file; the payload rows cascade
 *  on `value_id`. The instance itself stays. */
export function deleteFileValue(db: Db, fileId: number, tagId: number) {
  db.prepare(`DELETE FROM file_tag_values WHERE file_id = ? AND tag_id = ?`).run(fileId, tagId);
}

/** Deletes one value of the file. Throws NotFoundError when the value is not on the file or
 *  its tag is not in the library. */
export function deleteFileValueById(db: Db, fileId: number, valueId: number, libraryId: number) {
  const value = db
    .prepare(
      `SELECT v.value_id FROM file_tag_values v
       JOIN tags t ON t.tag_id = v.tag_id
       WHERE v.value_id = ? AND v.file_id = ? AND t.library_id = ?`,
    )
    .get(valueId, fileId, libraryId);
  if (!value) throw new NotFoundError(`Value ${valueId} not found on file ${fileId}`);
  db.prepare(`DELETE FROM file_tag_values WHERE value_id = ?`).run(valueId);
}

/** The checks every file value writer runs: the tag is in the library, the file has a
 *  location in it, and the tag is applied to the file. */
function requireFileInstance(db: Db, fileId: number, tagId: number, libraryId: number) {
  requireTagInLibrary(db, tagId, libraryId);
  requireFileInLibrary(db, fileId, libraryId);
  if (!fileHasInstance(db, fileId, tagId)) {
    throw new NotFoundError(`Tag ${tagId} is not applied to file ${fileId}`);
  }
}

function insertFileValue(db: Db, fileId: number, tagId: number, kind: string): number {
  return Number(
    db
      .prepare(`INSERT INTO file_tag_values (file_id, tag_id, kind) VALUES (?, ?, ?)`)
      .run(fileId, tagId, kind).lastInsertRowid,
  );
}

function validateText(text: unknown): string {
  if (typeof text !== 'string' || text === '') {
    throw new ValidationError('Text value must be a non-empty string');
  }
  return text;
}

function validateNumber(number: unknown): number {
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new ValidationError('Number value must be a finite number');
  }
  return number;
}

export function createTextFileValue(
  db: Db,
  fileId: number,
  tagId: number,
  text: string,
  libraryId: number,
): number {
  const textValue = validateText(text);
  return db.transaction(() => {
    requireFileInstance(db, fileId, tagId, libraryId);
    const valueId = insertFileValue(db, fileId, tagId, 'text');
    db.prepare(`INSERT INTO file_tag_value_text (value_id, text_value) VALUES (?, ?)`).run(
      valueId,
      textValue,
    );
    return valueId;
  })();
}

export function createNumberFileValue(
  db: Db,
  fileId: number,
  tagId: number,
  number: number,
  libraryId: number,
): number {
  const numValue = validateNumber(number);
  return db.transaction(() => {
    requireFileInstance(db, fileId, tagId, libraryId);
    const valueId = insertFileValue(db, fileId, tagId, 'number');
    db.prepare(`INSERT INTO file_tag_value_number (value_id, num_value) VALUES (?, ?)`).run(
      valueId,
      numValue,
    );
    return valueId;
  })();
}

/** Normalizes an anchor to all six fields (missing parts are null). It must have a time part
 *  (`tStart` >= 0, `tEnd` null or >= `tStart`), a full region part (each field in [0, 1],
 *  `rx + rw <= 1`, `ry + rh <= 1`), or both. */
function validateAnchor(anchor: AnchorInput) {
  const field = (name: keyof AnchorInput) => {
    const value = anchor[name] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ValidationError(`Anchor ${name} must be a finite number or null`);
    }
    return value;
  };
  const tStart = field('tStart');
  const tEnd = field('tEnd');
  const rx = field('rx');
  const ry = field('ry');
  const rw = field('rw');
  const rh = field('rh');

  if (tStart === null && tEnd !== null) {
    throw new ValidationError('Anchor tEnd needs a tStart');
  }
  if (tStart !== null) {
    if (tStart < 0) throw new ValidationError('Anchor tStart must be >= 0');
    if (tEnd !== null && tEnd < tStart) throw new ValidationError('Anchor tEnd must be >= tStart');
  }

  const region = [rx, ry, rw, rh];
  const regionCount = region.filter((value) => value !== null).length;
  if (regionCount !== 0 && regionCount !== 4) {
    throw new ValidationError('Anchor region needs all of rx, ry, rw, rh');
  }
  if (regionCount === 4) {
    if (region.some((value) => (value as number) < 0 || (value as number) > 1)) {
      throw new ValidationError('Anchor region values must be between 0 and 1');
    }
    if ((rx as number) + (rw as number) > 1 || (ry as number) + (rh as number) > 1) {
      throw new ValidationError('Anchor region must fit inside the file');
    }
  }

  if (tStart === null && regionCount === 0) {
    throw new ValidationError('Anchor needs a time part, a region part, or both');
  }
  return { tStart, tEnd, rx, ry, rw, rh };
}

export function createAnchorFileValue(
  db: Db,
  fileId: number,
  tagId: number,
  anchor: AnchorInput,
  libraryId: number,
): number {
  const { tStart, tEnd, rx, ry, rw, rh } = validateAnchor(anchor);
  return db.transaction(() => {
    requireFileInstance(db, fileId, tagId, libraryId);
    const valueId = insertFileValue(db, fileId, tagId, 'anchor');
    db.prepare(
      `INSERT INTO file_tag_value_anchor (value_id, t_start, t_end, rx, ry, rw, rh) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(valueId, tStart, tEnd, rx, ry, rw, rh);
    return valueId;
  })();
}

/** Adds a `tag` value on instance (file, tagId) that points at instance (file, refTagId).
 *  When `refTagId` is not yet on the file, it is applied first (see docs/tags.md). Rejects
 *  `refTagId = tagId` and a second value with the same ref on the instance. */
export function createRefFileValue(
  db: Db,
  fileId: number,
  tagId: number,
  refTagId: number,
  libraryId: number,
): number {
  return db.transaction(() => {
    requireFileInstance(db, fileId, tagId, libraryId);
    requireTagInLibrary(db, refTagId, libraryId);
    if (refTagId === tagId) {
      throw new ValidationError(`Tag ${tagId} cannot reference its own instance`);
    }
    if (!fileHasInstance(db, fileId, refTagId)) tagFile(db, fileId, refTagId, libraryId);
    const duplicate = db
      .prepare(
        `SELECT 1 FROM file_tag_values v
         JOIN file_tag_value_tag t ON t.value_id = v.value_id
         WHERE v.file_id = ? AND v.tag_id = ? AND t.ref_tag_id = ? LIMIT 1`,
      )
      .get(fileId, tagId, refTagId);
    if (duplicate) {
      throw new ConflictError(`Tag ${tagId} on file ${fileId} already references tag ${refTagId}`);
    }
    const valueId = insertFileValue(db, fileId, tagId, 'tag');
    db.prepare(
      `INSERT INTO file_tag_value_tag (value_id, file_id, ref_tag_id) VALUES (?, ?, ?)`,
    ).run(valueId, fileId, refTagId);
    return valueId;
  })();
}

/** Updates one value of the file in place, keeping its `value_id` and its kind. When a `tag`
 *  value points at a tag that is not yet on the file, that tag is applied first. */
export function updateFileValueById(
  db: Db,
  fileId: number,
  valueId: number,
  update: FileValueUpdate,
  libraryId: number,
) {
  db.transaction(() => {
    const row = db
      .prepare(
        `SELECT v.value_id, v.tag_id, v.kind FROM file_tag_values v
         JOIN tags t ON t.tag_id = v.tag_id
         WHERE v.value_id = ? AND v.file_id = ? AND t.library_id = ?`,
      )
      .get(valueId, fileId, libraryId) as
      { value_id: number; tag_id: number; kind: string } | undefined;
    if (!row) throw new NotFoundError(`Value ${valueId} not found on file ${fileId}`);
    if (row.kind !== update.kind) {
      throw new ValidationError(`Value ${valueId} has kind "${row.kind}", not "${update.kind}"`);
    }
    switch (update.kind) {
      case 'text': {
        const textValue = validateText(update.text);
        db.prepare(`UPDATE file_tag_value_text SET text_value = ? WHERE value_id = ?`).run(
          textValue,
          valueId,
        );
        break;
      }
      case 'number': {
        const numValue = validateNumber(update.number);
        db.prepare(`UPDATE file_tag_value_number SET num_value = ? WHERE value_id = ?`).run(
          numValue,
          valueId,
        );
        break;
      }
      case 'tag': {
        requireTagInLibrary(db, update.refTagId, libraryId);
        if (update.refTagId === row.tag_id) {
          throw new ValidationError(`Tag ${row.tag_id} cannot reference its own instance`);
        }
        if (!fileHasInstance(db, fileId, update.refTagId)) {
          tagFile(db, fileId, update.refTagId, libraryId);
        }
        const duplicate = db
          .prepare(
            `SELECT 1 FROM file_tag_values v
             JOIN file_tag_value_tag t ON t.value_id = v.value_id
             WHERE v.file_id = ? AND v.tag_id = ? AND t.ref_tag_id = ? AND v.value_id != ? LIMIT 1`,
          )
          .get(fileId, row.tag_id, update.refTagId, valueId);
        if (duplicate) {
          throw new ConflictError(
            `Tag ${row.tag_id} on file ${fileId} already references tag ${update.refTagId}`,
          );
        }
        db.prepare(`UPDATE file_tag_value_tag SET ref_tag_id = ? WHERE value_id = ?`).run(
          update.refTagId,
          valueId,
        );
        break;
      }
      case 'anchor': {
        const { tStart, tEnd, rx, ry, rw, rh } = validateAnchor(update.anchor);
        db.prepare(
          `UPDATE file_tag_value_anchor SET t_start = ?, t_end = ?, rx = ?, ry = ?, rw = ?, rh = ? WHERE value_id = ?`,
        ).run(tStart, tEnd, rx, ry, rw, rh, valueId);
        break;
      }
    }
  })();
}

/** Checks a tag-tag pair: both tags exist (NotFoundError), are in the same library and are
 *  not the same tag (ValidationError). */
function requireTagPair(db: Db, subjectTagId: number, tagId: number, selfMessage: string) {
  const subject = requireTag(db, subjectTagId);
  const tag = requireTag(db, tagId);
  if (subject.library_id !== tag.library_id) {
    throw new ValidationError(`Tags ${subjectTagId} and ${tagId} are not in the same library`);
  }
  if (subjectTagId === tagId) throw new ValidationError(selfMessage);
}

/** Applies `tagId` to `subjectTagId`. Does nothing when the instance already exists. */
export function tagTag(db: Db, subjectTagId: number, tagId: number) {
  requireTagPair(db, subjectTagId, tagId, `Tag ${tagId} cannot tag itself`);
  db.prepare(
    `INSERT OR IGNORE INTO tag_tag_relationships (subject_tag_id, tag_id) VALUES (?, ?)`,
  ).run(subjectTagId, tagId);
}

/** Removes the instance of `tagId` on `subjectTagId`; its values cascade. When the
 *  instance carried a `parent` value, the closure is repaired for the subject and its
 *  descendants (see docs/tags.md), and the subject's aliases are checked against its new
 *  siblings. */
export function untagTag(db: Db, subjectTagId: number, tagId: number) {
  db.transaction(() => {
    const hadParentEdge = hasParentValue(db, subjectTagId, tagId);
    //Values that point at this instance: the foreign key only cascades their payload rows.
    db.prepare(
      `DELETE FROM tag_tag_values WHERE value_id IN
         (SELECT value_id FROM tag_tag_value_tag WHERE subject_tag_id = ? AND ref_tag_id = ?)`,
    ).run(subjectTagId, tagId);
    db.prepare(`DELETE FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`).run(
      subjectTagId,
      tagId,
    );
    if (hadParentEdge) afterParentRemoval(db, subjectTagId);
  })();
}

/** Deletes every value of the instance of `tagId` on `subjectTagId`; the payload rows
 *  cascade on `value_id`. The instance itself stays. When a `parent` value was removed,
 *  the closure is repaired for the subject and its descendants (see docs/tags.md). */
export function deleteTagValue(db: Db, subjectTagId: number, tagId: number) {
  db.transaction(() => {
    const hadParentEdge = hasParentValue(db, subjectTagId, tagId);
    db.prepare(`DELETE FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ?`).run(
      subjectTagId,
      tagId,
    );
    if (hadParentEdge) afterParentRemoval(db, subjectTagId);
  })();
}

/** Deletes one value on the subject tag. Throws NotFoundError when the value is not on it. */
export function deleteTagValueById(db: Db, subjectTagId: number, valueId: number) {
  db.transaction(() => {
    const value = db
      .prepare(`SELECT kind FROM tag_tag_values WHERE value_id = ? AND subject_tag_id = ?`)
      .get(valueId, subjectTagId) as { kind: string } | undefined;
    if (!value) throw new NotFoundError(`Value ${valueId} not found on tag ${subjectTagId}`);
    db.prepare(`DELETE FROM tag_tag_values WHERE value_id = ?`).run(valueId);
    if (value.kind === 'parent') afterParentRemoval(db, subjectTagId);
  })();
}

/** Deletes the values of one kind on the instance of `tagId` on `subjectTagId`. */
export function deleteTagValuesOfKind(db: Db, subjectTagId: number, tagId: number, kind: string) {
  db.transaction(() => {
    const removed = db
      .prepare(`DELETE FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ? AND kind = ?`)
      .run(subjectTagId, tagId, kind);
    if (kind === 'parent' && removed.changes > 0) afterParentRemoval(db, subjectTagId);
  })();
}

//Values

function insertTagValue(db: Db, subjectTagId: number, tagId: number, kind: string): number {
  return Number(
    db
      .prepare(`INSERT INTO tag_tag_values (subject_tag_id, tag_id, kind) VALUES (?, ?, ?)`)
      .run(subjectTagId, tagId, kind).lastInsertRowid,
  );
}

/** Adds a text value on the instance of `tagId` on `subjectTagId`; the instance is created
 *  when missing. Returns the value id. */
export function createTextTagValue(
  db: Db,
  subjectTagId: number,
  tagId: number,
  text: string,
): number {
  const textValue = validateText(text);
  return db.transaction(() => {
    tagTag(db, subjectTagId, tagId);
    const valueId = insertTagValue(db, subjectTagId, tagId, 'text');
    db.prepare(`INSERT INTO tag_tag_value_text (value_id, text_value) VALUES (?, ?)`).run(
      valueId,
      textValue,
    );
    return valueId;
  })();
}

/** Adds a number value on the instance of `tagId` on `subjectTagId`; the instance is created
 *  when missing. Returns the value id. */
export function createNumberTagValue(
  db: Db,
  subjectTagId: number,
  tagId: number,
  number: number,
): number {
  const numValue = validateNumber(number);
  return db.transaction(() => {
    tagTag(db, subjectTagId, tagId);
    const valueId = insertTagValue(db, subjectTagId, tagId, 'number');
    db.prepare(`INSERT INTO tag_tag_value_number (value_id, num_value) VALUES (?, ?)`).run(
      valueId,
      numValue,
    );
    return valueId;
  })();
}

/** Adds a `tag` value on instance (subject, tagId) that points at instance (subject, refTagId).
 *  Both instances are created when missing. Rejects `refTagId = tagId` and a second value
 *  with the same ref on the instance. Returns the value id. */
export function createRefTagValue(
  db: Db,
  subjectTagId: number,
  tagId: number,
  refTagId: number,
): number {
  return db.transaction(() => {
    tagTag(db, subjectTagId, tagId);
    if (refTagId === tagId) {
      throw new ValidationError(`Tag ${tagId} cannot reference its own instance`);
    }
    tagTag(db, subjectTagId, refTagId);
    const duplicate = db
      .prepare(
        `SELECT 1 FROM tag_tag_values v
         JOIN tag_tag_value_tag t ON t.value_id = v.value_id
         WHERE v.subject_tag_id = ? AND v.tag_id = ? AND t.ref_tag_id = ? LIMIT 1`,
      )
      .get(subjectTagId, tagId, refTagId);
    if (duplicate) {
      throw new ConflictError(
        `Tag ${tagId} on tag ${subjectTagId} already references tag ${refTagId}`,
      );
    }
    const valueId = insertTagValue(db, subjectTagId, tagId, 'tag');
    db.prepare(
      `INSERT INTO tag_tag_value_tag (value_id, subject_tag_id, ref_tag_id) VALUES (?, ?, ?)`,
    ).run(valueId, subjectTagId, refTagId);
    return valueId;
  })();
}

/** Makes `parentTagId` a parent of `tagId`: the relationship, its `parent` value, and the
 *  new `tag_ancestors` rows, in one transaction. Both tags must be in the same library.
 *  The edge is rejected when it would close a cycle — `parentTagId = tagId`, or `tagId`
 *  already an ancestor of `parentTagId`, one lookup in the closure table (see docs/tags.md) —
 *  when it already exists, or when an alias of `tagId` clashes with a child of the parent.
 *  `primary` makes it the only primary parent of `tagId`. Returns the value id. */
export function createParentTagValue(
  db: Db,
  tagId: number,
  parentTagId: number,
  { primary = false } = {},
): number {
  return db.transaction(() => {
    const tag = requireTag(db, tagId);
    const parent = requireTag(db, parentTagId);
    if (tag.library_id !== parent.library_id) {
      throw new ValidationError(`Tags ${tagId} and ${parentTagId} are not in the same library`);
    }
    if (tagId === parentTagId) {
      throw new ValidationError(`Tag ${tagId} cannot be its own parent`);
    }
    if (hasParentValue(db, tagId, parentTagId)) {
      throw new ConflictError(`Tag ${parentTagId} is already a parent of tag ${tagId}`);
    }
    const cycle = db
      .prepare(`SELECT 1 FROM tag_ancestors WHERE ancestor_id = ? AND descendant_id = ? LIMIT 1`)
      .get(tagId, parentTagId);
    if (cycle) {
      throw new ConflictError(
        `Tag ${tagId} is already an ancestor of tag ${parentTagId}; the parent edge would create a cycle`,
      );
    }
    assertSiblingUnique(db, tagId, aliasTextsOf(db, tagId), [parentTagId]);
    db.prepare(
      `INSERT OR IGNORE INTO tag_tag_relationships (subject_tag_id, tag_id) VALUES (?, ?)`,
    ).run(tagId, parentTagId);
    const valueId = insertTagValue(db, tagId, parentTagId, 'parent');
    if (primary) {
      db.prepare(`UPDATE tag_tag_value_parent SET is_primary = 0 WHERE subject_tag_id = ?`).run(
        tagId,
      );
    }
    db.prepare(
      `INSERT INTO tag_tag_value_parent (value_id, subject_tag_id, is_primary) VALUES (?, ?, ?)`,
    ).run(valueId, tagId, primary ? 1 : 0);
    //Every descendant of the subject gains every ancestor of the new parent; the
    //self rows in the closure make the parent and the subject take part themselves.
    db.prepare(
      `INSERT OR IGNORE INTO tag_ancestors (ancestor_id, descendant_id)
       SELECT a.ancestor_id, d.descendant_id
       FROM tag_ancestors a
       JOIN tag_ancestors d ON d.ancestor_id = ?
       WHERE a.descendant_id = ?`,
    ).run(tagId, parentTagId);
    return valueId;
  })();
}

/** Makes `parentTagId` the only primary parent of `tagId`. Throws NotFoundError when it is
 *  not a parent of `tagId`. */
export function setPrimaryParent(db: Db, tagId: number, parentTagId: number) {
  setParentPrimary(db, tagId, parentTagId, true);
}

/** Sets or clears `is_primary` on the parent edge `(tagId, parentTagId)`. */
export function setParentPrimary(db: Db, tagId: number, parentTagId: number, primary: boolean) {
  db.transaction(() => {
    const value = db
      .prepare(
        `SELECT value_id FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ? AND kind = 'parent'`,
      )
      .get(tagId, parentTagId) as { value_id: number } | undefined;
    if (!value) throw new NotFoundError(`Tag ${parentTagId} is not a parent of tag ${tagId}`);
    if (primary) {
      db.prepare(`UPDATE tag_tag_value_parent SET is_primary = 0 WHERE subject_tag_id = ?`).run(
        tagId,
      );
      db.prepare(`UPDATE tag_tag_value_parent SET is_primary = 1 WHERE value_id = ?`).run(
        value.value_id,
      );
    } else {
      db.prepare(`UPDATE tag_tag_value_parent SET is_primary = 0 WHERE value_id = ?`).run(
        value.value_id,
      );
    }
  })();
}

/** Updates one value of the subject tag in place, keeping its `value_id` and its kind. */
export function updateTagValueById(
  db: Db,
  subjectTagId: number,
  valueId: number,
  update: TagValueUpdate,
  libraryId: number,
) {
  db.transaction(() => {
    requireTagInLibrary(db, subjectTagId, libraryId);
    const row = db
      .prepare(
        `SELECT value_id, tag_id, kind FROM tag_tag_values
         WHERE value_id = ? AND subject_tag_id = ?`,
      )
      .get(valueId, subjectTagId) as { value_id: number; tag_id: number; kind: string } | undefined;
    if (!row) throw new NotFoundError(`Value ${valueId} not found on tag ${subjectTagId}`);
    if (row.kind !== update.kind) {
      throw new ValidationError(`Value ${valueId} has kind "${row.kind}", not "${update.kind}"`);
    }
    switch (update.kind) {
      case 'text': {
        const textValue = validateText(update.text);
        db.prepare(`UPDATE tag_tag_value_text SET text_value = ? WHERE value_id = ?`).run(
          textValue,
          valueId,
        );
        break;
      }
      case 'number': {
        const numValue = validateNumber(update.number);
        db.prepare(`UPDATE tag_tag_value_number SET num_value = ? WHERE value_id = ?`).run(
          numValue,
          valueId,
        );
        break;
      }
      case 'tag': {
        requireTagInLibrary(db, update.refTagId, libraryId);
        if (update.refTagId === row.tag_id) {
          throw new ValidationError(`Tag ${row.tag_id} cannot reference its own instance`);
        }
        tagTag(db, subjectTagId, update.refTagId);
        const duplicate = db
          .prepare(
            `SELECT 1 FROM tag_tag_values v
             JOIN tag_tag_value_tag t ON t.value_id = v.value_id
             WHERE v.subject_tag_id = ? AND v.tag_id = ? AND t.ref_tag_id = ? AND v.value_id != ? LIMIT 1`,
          )
          .get(subjectTagId, row.tag_id, update.refTagId, valueId);
        if (duplicate) {
          throw new ConflictError(
            `Tag ${row.tag_id} on tag ${subjectTagId} already references tag ${update.refTagId}`,
          );
        }
        db.prepare(`UPDATE tag_tag_value_tag SET ref_tag_id = ? WHERE value_id = ?`).run(
          update.refTagId,
          valueId,
        );
        break;
      }
      case 'parent': {
        setParentPrimary(db, subjectTagId, row.tag_id, update.primary);
        break;
      }
      case 'component': {
        db.prepare(
          `UPDATE tag_tag_value_component SET recursive = ?, attributed = ? WHERE value_id = ?`,
        ).run(update.recursive ? 1 : 0, update.attributed ? 1 : 0, valueId);
        break;
      }
    }
    touchTag(db, subjectTagId);
  })();
}

/** Adds a `component` value to the `(tagId, componentTagId)` relationship, marking
 *  `componentTagId` as a component of `tagId`. `recursive`: the component's own components
 *  come along when the subject is applied. `attributed`: the subject instance also gets a
 *  `tag` value pointing at the component instance. Defaults match docs/tags.md's common case:
 *  applied once, linked both ways. When the component value already exists, its flags are
 *  updated. Returns the value id. */
export function createComponentTagValue(
  db: Db,
  tagId: number,
  componentTagId: number,
  { recursive = false, attributed = true } = {},
): number {
  return db.transaction(() => {
    tagTag(db, tagId, componentTagId);
    const existing = db
      .prepare(
        `SELECT value_id FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ? AND kind = 'component'`,
      )
      .get(tagId, componentTagId) as { value_id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE tag_tag_value_component SET recursive = ?, attributed = ? WHERE value_id = ?`,
      ).run(recursive ? 1 : 0, attributed ? 1 : 0, existing.value_id);
      return existing.value_id;
    }
    const valueId = insertTagValue(db, tagId, componentTagId, 'component');
    db.prepare(
      `INSERT INTO tag_tag_value_component (value_id, recursive, attributed) VALUES (?, ?, ?)`,
    ).run(valueId, recursive ? 1 : 0, attributed ? 1 : 0);
    return valueId;
  })();
}

//Reads

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

type tagListRow = {
  tagId: number;
  name: string;
  color: string | null;
  isCategory: number;
  fileCount: number;
  parentName: string | null;
};

/** Lists the tags of the library, most used first. `q` keeps tags that have an alias
 *  starting with `q` (case-insensitive). `parentName` is the name of the primary parent,
 *  else of any parent, for telling tags with the same name apart. */
export function listTags(
  db: Db,
  libraryId: number,
  { q, limit, offset }: { q?: string; limit: number; offset: number },
): { total: number; tags: TagListItem[] } {
  const prefix = q?.trim() ? `${escapeLike(q.trim())}%` : null;
  const where = `t.library_id = ?${
    prefix === null
      ? ''
      : ` AND EXISTS (SELECT 1 FROM aliases m WHERE m.tag_id = t.tag_id AND m.text LIKE ? ESCAPE '\\')`
  }`;
  const params = prefix === null ? [libraryId] : [libraryId, prefix];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM tags t WHERE ${where}`)
    .get(...params) as { total: number };
  const rows = db
    .prepare(
      `SELECT t.tag_id AS tagId, pa.text AS name, t.color, t.is_category AS isCategory,
         t.file_count AS fileCount,
         (SELECT a.text FROM tag_tag_values v
          JOIN tag_tag_value_parent p ON p.value_id = v.value_id
          JOIN aliases a ON a.tag_id = v.tag_id AND a.is_primary = 1
          WHERE v.subject_tag_id = t.tag_id AND v.kind = 'parent'
          ORDER BY p.is_primary DESC, v.value_id LIMIT 1) AS parentName
       FROM tags t
       LEFT JOIN aliases pa ON pa.tag_id = t.tag_id AND pa.is_primary = 1
       WHERE ${where}
       ORDER BY t.file_count DESC, pa.text COLLATE NOCASE, t.tag_id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as tagListRow[];
  return { total, tags: rows.map((row) => ({ ...row, isCategory: row.isCategory === 1 })) };
}

export type TagGraphNode = TagListItem & { aliases: string[] };

export type TagGraphEdge = {
  subjectTagId: number;
  tagId: number;
  parent: boolean;
  primary: boolean;
  component: boolean;
  valueCount: number;
};

export type TagGraph = { tags: TagGraphNode[]; edges: TagGraphEdge[] };

/** Every tag of the library, ordered by name, and every tag-tag relationship between
 *  them. An edge is the instance of `tagId` on `subjectTagId`: `parent` and `component`
 *  tell its structural values, `valueCount` counts its other values. `aliases` holds the
 *  alias texts other than the name. */
export function getTagGraph(db: Db, libraryId: number): TagGraph {
  const rows = db
    .prepare(
      `SELECT t.tag_id AS tagId, pa.text AS name, t.color, t.is_category AS isCategory,
         t.file_count AS fileCount,
         (SELECT a.text FROM tag_tag_values v
          JOIN tag_tag_value_parent p ON p.value_id = v.value_id
          JOIN aliases a ON a.tag_id = v.tag_id AND a.is_primary = 1
          WHERE v.subject_tag_id = t.tag_id AND v.kind = 'parent'
          ORDER BY p.is_primary DESC, v.value_id LIMIT 1) AS parentName
       FROM tags t
       LEFT JOIN aliases pa ON pa.tag_id = t.tag_id AND pa.is_primary = 1
       WHERE t.library_id = ?
       ORDER BY pa.text COLLATE NOCASE, t.tag_id`,
    )
    .all(libraryId) as tagListRow[];
  const aliasRows = db
    .prepare(
      `SELECT tag_id AS tagId, text FROM aliases
       WHERE library_id = ? AND is_primary = 0 ORDER BY alias_id`,
    )
    .all(libraryId) as { tagId: number; text: string }[];
  const aliasesByTag = new Map<number, string[]>();
  for (const row of aliasRows) {
    const list = aliasesByTag.get(row.tagId) ?? [];
    list.push(row.text);
    aliasesByTag.set(row.tagId, list);
  }
  const edgeRows = db
    .prepare(
      `SELECT r.subject_tag_id AS subjectTagId, r.tag_id AS tagId,
         COALESCE(SUM(v.kind = 'parent'), 0) AS parent,
         COALESCE(MAX(p.is_primary), 0) AS isPrimary,
         COALESCE(SUM(v.kind = 'component'), 0) AS component,
         COALESCE(SUM(v.kind NOT IN ('parent', 'component')), 0) AS valueCount
       FROM tag_tag_relationships r
       JOIN tags t ON t.tag_id = r.subject_tag_id
       LEFT JOIN tag_tag_values v ON v.subject_tag_id = r.subject_tag_id AND v.tag_id = r.tag_id
       LEFT JOIN tag_tag_value_parent p ON p.value_id = v.value_id
       WHERE t.library_id = ?
       GROUP BY r.subject_tag_id, r.tag_id
       ORDER BY r.subject_tag_id, r.tag_id`,
    )
    .all(libraryId) as {
    subjectTagId: number;
    tagId: number;
    parent: number;
    isPrimary: number;
    component: number;
    valueCount: number;
  }[];
  return {
    tags: rows.map((row) => ({
      ...row,
      name: row.name ?? `#${row.tagId}`,
      isCategory: row.isCategory === 1,
      aliases: aliasesByTag.get(row.tagId) ?? [],
    })),
    edges: edgeRows.map((row) => ({
      subjectTagId: row.subjectTagId,
      tagId: row.tagId,
      parent: row.parent > 0,
      primary: row.isPrimary === 1,
      component: row.component > 0,
      valueCount: row.valueCount,
    })),
  };
}

/** Tag summaries keyed by `tagId`, for tags of `libraryId` only. When `includeParents` is set,
 *  the direct parents of the requested tags are included too so callers can resolve category
 *  parents without a second query. */
export function getTagSummaries(
  db: Db,
  libraryId: number,
  tagIds: readonly number[],
  { includeParents = false }: { includeParents?: boolean } = {},
): Record<number, TagListItem> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return {};
  const ids = JSON.stringify(unique);
  const inRequested = `IN (SELECT value FROM json_each(?))`;
  const whereIds = includeParents
    ? `(t.tag_id ${inRequested} OR t.tag_id IN (
         SELECT v.tag_id FROM tag_tag_values v
         WHERE v.subject_tag_id ${inRequested} AND v.kind = 'parent'
       ))`
    : `t.tag_id ${inRequested}`;
  const params = includeParents ? [libraryId, ids, ids] : [libraryId, ids];
  const rows = db
    .prepare(
      `SELECT t.tag_id AS tagId, pa.text AS name, t.color, t.is_category AS isCategory,
         t.file_count AS fileCount,
         (SELECT a.text FROM tag_tag_values v
          JOIN tag_tag_value_parent p ON p.value_id = v.value_id
          JOIN aliases a ON a.tag_id = v.tag_id AND a.is_primary = 1
          WHERE v.subject_tag_id = t.tag_id AND v.kind = 'parent'
          ORDER BY p.is_primary DESC, v.value_id LIMIT 1) AS parentName
       FROM tags t
       LEFT JOIN aliases pa ON pa.tag_id = t.tag_id AND pa.is_primary = 1
       WHERE t.library_id = ? AND ${whereIds}`,
    )
    .all(...params) as tagListRow[];
  const out: Record<number, TagListItem> = {};
  for (const row of rows) {
    out[row.tagId] = { ...row, isCategory: row.isCategory === 1 };
  }
  return out;
}

/** Collects every tag referenced in `instancesByFile` (instance tags, `tag` value refs, and
 *  their direct parents) and returns their summaries keyed by `tagId`. */
export function getFileInstanceTags(
  db: Db,
  instancesByFile: Iterable<readonly FileInstance[]>,
  libraryId: number,
): Record<number, TagListItem> {
  const tagIds: number[] = [];
  for (const list of instancesByFile) {
    for (const inst of list) {
      tagIds.push(inst.tagId);
      for (const v of inst.values) {
        if (v.kind === 'tag') tagIds.push(v.refTagId);
      }
    }
  }
  return getTagSummaries(db, libraryId, tagIds, { includeParents: true });
}

type tagValueRow = {
  value_id: number;
  tag_id: number;
  kind: string;
  text_value: string | null;
  num_value: number | null;
  ref_tag_id: number | null;
  is_primary: number | null;
  recursive: number | null;
  attributed: number | null;
};

function toTagValue(row: tagValueRow): TagValue | undefined {
  const valueId = row.value_id;
  switch (row.kind) {
    case 'text':
      return { valueId, kind: 'text', text: row.text_value ?? '' };
    case 'number':
      return { valueId, kind: 'number', number: row.num_value ?? 0 };
    case 'tag':
      if (row.ref_tag_id === null) return undefined;
      return { valueId, kind: 'tag', refTagId: row.ref_tag_id };
    case 'parent':
      return { valueId, kind: 'parent', primary: row.is_primary === 1 };
    case 'component':
      return {
        valueId,
        kind: 'component',
        recursive: row.recursive === 1,
        attributed: row.attributed === 1,
      };
    default:
      return undefined;
  }
}

/** The tag, its aliases, its hierarchy, and its instances (the tags applied to it) with their values. */
export function getTagDetail(db: Db, tagId: number, libraryId: number): TagDetail {
  const tag = requireTagInLibrary(db, tagId, libraryId);
  const aliases = getTagAliases(db, tagId, libraryId);
  const relationships = db
    .prepare(
      `SELECT r.tag_id AS tagId, a.text AS name FROM tag_tag_relationships r
       LEFT JOIN aliases a ON a.tag_id = r.tag_id AND a.is_primary = 1
       WHERE r.subject_tag_id = ?
       ORDER BY a.text COLLATE NOCASE, r.tag_id`,
    )
    .all(tagId) as { tagId: number; name: string | null }[];
  const valueRows = db
    .prepare(
      `SELECT v.value_id, v.tag_id, v.kind, tx.text_value, n.num_value, r.ref_tag_id,
         p.is_primary, c.recursive, c.attributed
       FROM tag_tag_values v
       LEFT JOIN tag_tag_value_text tx ON tx.value_id = v.value_id
       LEFT JOIN tag_tag_value_number n ON n.value_id = v.value_id
       LEFT JOIN tag_tag_value_tag r ON r.value_id = v.value_id
       LEFT JOIN tag_tag_value_parent p ON p.value_id = v.value_id
       LEFT JOIN tag_tag_value_component c ON c.value_id = v.value_id
       WHERE v.subject_tag_id = ?
       ORDER BY v.value_id`,
    )
    .all(tagId) as tagValueRow[];
  const valuesByTag = new Map<number, TagValue[]>();
  for (const row of valueRows) {
    const value = toTagValue(row);
    if (!value) continue;
    const list = valuesByTag.get(row.tag_id) ?? [];
    list.push(value);
    valuesByTag.set(row.tag_id, list);
  }
  const parents = db
    .prepare(
      `SELECT t.tag_id AS tagId, a.text AS name, t.color
       FROM tag_tag_values v
       JOIN tags t ON t.tag_id = v.tag_id
       LEFT JOIN tag_tag_value_parent p ON p.value_id = v.value_id
       LEFT JOIN aliases a ON a.tag_id = t.tag_id AND a.is_primary = 1
       WHERE v.subject_tag_id = ? AND v.kind = 'parent'
       ORDER BY p.is_primary DESC, a.text COLLATE NOCASE, t.tag_id`,
    )
    .all(tagId) as TagHierarchyItem[];
  const ancestors = db
    .prepare(
      `SELECT t.tag_id AS tagId, a.text AS name, t.color
       FROM tag_ancestors ta
       JOIN tags t ON t.tag_id = ta.ancestor_id
       LEFT JOIN aliases a ON a.tag_id = t.tag_id AND a.is_primary = 1
       WHERE ta.descendant_id = ? AND ta.ancestor_id != ?
       ORDER BY a.text COLLATE NOCASE, t.tag_id`,
    )
    .all(tagId, tagId) as TagHierarchyItem[];
  const children = db
    .prepare(
      `SELECT t.tag_id AS tagId, a.text AS name, t.color
       FROM tag_tag_values v
       JOIN tags t ON t.tag_id = v.subject_tag_id
       LEFT JOIN aliases a ON a.tag_id = t.tag_id AND a.is_primary = 1
       WHERE v.tag_id = ? AND v.kind = 'parent'
       ORDER BY a.text COLLATE NOCASE, t.tag_id`,
    )
    .all(tagId) as TagHierarchyItem[];
  const descendants = db
    .prepare(
      `SELECT t.tag_id AS tagId, a.text AS name, t.color
       FROM tag_ancestors ta
       JOIN tags t ON t.tag_id = ta.descendant_id
       LEFT JOIN aliases a ON a.tag_id = t.tag_id AND a.is_primary = 1
       WHERE ta.ancestor_id = ? AND ta.descendant_id != ?
       ORDER BY a.text COLLATE NOCASE, t.tag_id`,
    )
    .all(tagId, tagId) as TagHierarchyItem[];
  const referencedTagIds = [
    tagId,
    ...relationships.map((r) => r.tagId),
    ...valueRows.flatMap((row) =>
      row.kind === 'tag' && row.ref_tag_id !== null ? [row.ref_tag_id] : [],
    ),
    ...parents.map((p) => p.tagId),
    ...ancestors.map((a) => a.tagId),
    ...children.map((c) => c.tagId),
    ...descendants.map((d) => d.tagId),
  ];
  return {
    tag,
    aliases,
    instances: relationships.map((r) => ({ ...r, values: valuesByTag.get(r.tagId) ?? [] })),
    parents,
    ancestors,
    children,
    descendants,
    tags: getTagSummaries(db, libraryId, referencedTagIds, { includeParents: true }),
  };
}

/** The instances of each file with their values, for tags of the library only. One query per
 *  table. Every id in `fileIds` gets an entry; instances are ordered by name. */
export function getFileInstances(
  db: Db,
  fileIds: number[],
  libraryId: number,
): Map<number, FileInstance[]> {
  const result = new Map(fileIds.map((id): [number, FileInstance[]] => [id, []]));
  if (fileIds.length === 0) return result;
  const ids = JSON.stringify(fileIds);
  const inFiles = `IN (SELECT value FROM json_each(?))`;

  const instances = db
    .prepare(
      `SELECT r.file_id, r.tag_id, a.text FROM file_tag_relationships r
       JOIN tags t ON t.tag_id = r.tag_id AND t.library_id = ?
       LEFT JOIN aliases a ON a.tag_id = r.tag_id AND a.is_primary = 1
       WHERE r.file_id ${inFiles}
       ORDER BY r.file_id, a.text COLLATE NOCASE, r.tag_id`,
    )
    .all(libraryId, ids) as { file_id: number; tag_id: number; text: string | null }[];
  const byInstance = new Map<string, FileInstance>();
  for (const row of instances) {
    const instance: FileInstance = { tagId: row.tag_id, name: row.text, values: [] };
    byInstance.set(`${row.file_id}:${row.tag_id}`, instance);
    result.get(row.file_id)?.push(instance);
  }

  const baseValues = db
    .prepare(
      `SELECT v.value_id, v.file_id, v.tag_id, v.kind FROM file_tag_values v
       JOIN tags t ON t.tag_id = v.tag_id AND t.library_id = ?
       WHERE v.file_id ${inFiles}
       ORDER BY v.value_id`,
    )
    .all(libraryId, ids) as { value_id: number; file_id: number; tag_id: number; kind: string }[];
  const payload = <T>(table: string) => {
    const rows = db
      .prepare(
        `SELECT x.* FROM ${table} x
         JOIN file_tag_values v ON v.value_id = x.value_id
         JOIN tags t ON t.tag_id = v.tag_id AND t.library_id = ?
         WHERE v.file_id ${inFiles}`,
      )
      .all(libraryId, ids) as (T & { value_id: number })[];
    return new Map(rows.map((row): [number, T] => [row.value_id, row]));
  };
  const texts = payload<{ text_value: string }>('file_tag_value_text');
  const numbers = payload<{ num_value: number }>('file_tag_value_number');
  const refs = payload<{ ref_tag_id: number }>('file_tag_value_tag');
  const anchors = payload<{
    t_start: number | null;
    t_end: number | null;
    rx: number | null;
    ry: number | null;
    rw: number | null;
    rh: number | null;
  }>('file_tag_value_anchor');

  for (const row of baseValues) {
    const instance = byInstance.get(`${row.file_id}:${row.tag_id}`);
    if (!instance) continue;
    const valueId = row.value_id;
    let value: FileValue | undefined;
    if (row.kind === 'text') {
      const text = texts.get(valueId);
      if (text) value = { valueId, kind: 'text', text: text.text_value };
    } else if (row.kind === 'number') {
      const number = numbers.get(valueId);
      if (number) value = { valueId, kind: 'number', number: number.num_value };
    } else if (row.kind === 'tag') {
      const ref = refs.get(valueId);
      if (ref) value = { valueId, kind: 'tag', refTagId: ref.ref_tag_id };
    } else if (row.kind === 'anchor') {
      const a = anchors.get(valueId);
      if (a) {
        value = {
          valueId,
          kind: 'anchor',
          tStart: a.t_start,
          tEnd: a.t_end,
          rx: a.rx,
          ry: a.ry,
          rw: a.rw,
          rh: a.rh,
        };
      }
    }
    if (value) instance.values.push(value);
  }
  return result;
}
