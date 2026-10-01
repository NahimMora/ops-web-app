import { useCallback, useMemo, useState } from "react";
import { articleBody, articleExcerpt, articleTitle, type ContentItem } from "./ui";

// Operator edits on scraped notes ("Preparadas" and the Scrapers step) are
// kept as a per-note overlay on top of the agent's snapshot instead of a
// copy of the whole list. The snapshot refreshes every 20-30s; with a copy,
// every refresh either clobbered what was being typed or went stale and
// "Guardar cambios" then overwrote notes a scraper had added meanwhile.
// Keyed by the note's identity, not its position, so a refresh that adds,
// drops or reorders notes never moves an edit or a selection to the wrong
// note.
export type ArticleEdit = {
  // Raw text exactly as typed. Only normalized (trim, split into
  // paragraphs) when the note is built for saving/publishing, so typing a
  // trailing space or a blank line between paragraphs isn't undone on the
  // next keystroke.
  title?: string;
  excerpt?: string;
  body?: string;
  // Escape hatch: publish this note verbatim, skipping the AI pass.
  skipAi?: boolean;
};

export type ArticleEdits = Record<string, ArticleEdit>;

export function articleKey(item: ContentItem): string {
  return String(item.source_id ?? item.id_fuente ?? item.url ?? item.source_url ?? item.titulo ?? item.title ?? "").trim();
}

export function splitParagraphs(value: string): string[] {
  return value.split(/\n\s*\n|\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

// What the editor fields show: the operator's raw text when there is one,
// otherwise the note's current value.
export function editorValues(item: ContentItem, edit: ArticleEdit | undefined) {
  return {
    title: edit?.title ?? articleTitle(item),
    excerpt: edit?.excerpt ?? articleExcerpt(item),
    body: edit?.body ?? articleBody(item),
    skipAi: Boolean(edit?.skipAi ?? item.manual_override),
  };
}

// The note as it gets saved/published. A hand-corrected title is locked
// (titulo_bloqueado: the backend publishes it verbatim while the AI still
// rewrites the body); the rest of an edit is the new source the AI works
// from. Only skipAi bypasses the AI pass entirely (manual_override).
export function applyEdit(item: ContentItem, edit: ArticleEdit | undefined): ContentItem {
  if (!edit) return item;
  const next: ContentItem = { ...item };
  const title = edit.title?.trim();
  if (title && title !== articleTitle(item)) {
    next.titulo = title;
    next.titulo_bloqueado = true;
  }
  if (edit.excerpt !== undefined && edit.excerpt.trim() !== articleExcerpt(item)) next.extracto = edit.excerpt.trim();
  if (edit.body !== undefined && edit.body.trim() !== articleBody(item)) next.parrafos = splitParagraphs(edit.body);
  if (edit.skipAi !== undefined) next.manual_override = edit.skipAi;
  return next;
}

export function isEditDirty(item: ContentItem, edit: ArticleEdit | undefined): boolean {
  if (!edit) return false;
  const applied = applyEdit(item, edit);
  return applied.titulo !== item.titulo
    || applied.extracto !== item.extracto
    || applied.parrafos !== item.parrafos
    || Boolean(applied.manual_override) !== Boolean(item.manual_override);
}

// Drops the edits that were just saved, unless the operator kept typing
// on that note after hitting save (then the newer edit must survive).
export function withoutSavedEdits(current: ArticleEdits, saved: ArticleEdits): ArticleEdits {
  const next: ArticleEdits = {};
  for (const [key, edit] of Object.entries(current)) {
    if (saved[key] !== edit) next[key] = edit;
  }
  return next;
}

export function usePreparedDrafts(baseItems: ContentItem[]) {
  const [edits, setEdits] = useState<ArticleEdits>({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const items = useMemo(() => baseItems.map((item) => applyEdit(item, edits[articleKey(item)])), [baseItems, edits]);
  const presentKeys = useMemo(() => new Set(baseItems.map(articleKey)), [baseItems]);
  const dirtyCount = useMemo(
    () => baseItems.filter((item) => isEditDirty(item, edits[articleKey(item)])).length,
    [baseItems, edits],
  );
  // Selection survives refreshes; a note that disappeared from the
  // snapshot simply stops counting as selected.
  const selected = useMemo(
    () => baseItems.map((item, index) => ({ key: articleKey(item), index })).filter(({ key }) => presentKeys.has(key) && selectedKeys.includes(key)).map(({ index }) => index),
    [baseItems, presentKeys, selectedKeys],
  );

  const edit = useCallback((index: number, patch: ArticleEdit) => {
    const item = baseItems[index];
    if (!item) return;
    const key = articleKey(item);
    setEdits((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }, [baseItems]);

  const setSelected = useCallback((indices: number[]) => {
    setSelectedKeys(indices.map((index) => baseItems[index]).filter(Boolean).map(articleKey));
  }, [baseItems]);

  const editAt = useCallback((index: number) => {
    const item = baseItems[index];
    return item ? edits[articleKey(item)] : undefined;
  }, [baseItems, edits]);

  const clearSaved = useCallback((saved: ArticleEdits) => setEdits((current) => withoutSavedEdits(current, saved)), []);
  const clearAll = useCallback(() => setEdits({}), []);

  return { items, edits, editAt, edit, dirtyCount, selected, setSelected, clearSaved, clearAll };
}
