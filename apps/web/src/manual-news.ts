import type { ContentItem } from "./ui";

export type ManualNewsDraft = {
  title: string;
  body: string;
  image: string;
  category: string;
  source: string;
};

export const EMPTY_MANUAL_NEWS_DRAFT: ManualNewsDraft = {
  title: "",
  body: "",
  image: "",
  category: "",
  source: "",
};

export function validateManualNewsDraft(draft: ManualNewsDraft): string | null {
  if (!draft.title.trim()) return "Ingresá el título de la noticia.";
  if (!draft.body.trim()) return "Ingresá el contenido de la noticia.";
  if (!draft.category.trim()) return "Ingresá una categoría.";
  if (!draft.source.trim()) return "Ingresá la fuente de la noticia.";
  if (draft.title.trim().length > 240) return "El título no puede superar los 240 caracteres.";
  if (draft.body.trim().length > 50_000) return "La noticia no puede superar los 50.000 caracteres.";
  if (draft.category.trim().length > 120) return "La categoría no puede superar los 120 caracteres.";
  if (draft.source.trim().length > 200) return "La fuente no puede superar los 200 caracteres.";
  if (draft.image.trim().length > 2048) return "La URL de la imagen no puede superar los 2.048 caracteres.";
  if (draft.image.trim() && !isHttpUrl(draft.image.trim())) return "La imagen debe ser una URL http o https válida.";
  return null;
}

export function buildManualNewsItem(draft: ManualNewsDraft): ContentItem {
  const title = draft.title.trim();
  const body = draft.body.trim();
  const image = draft.image.trim();
  const category = draft.category.trim();
  const source = draft.source.trim();
  const paragraphs = splitManualNewsBody(body);
  const excerpt = paragraphs.join(" ").replace(/\s+/g, " ").slice(0, 320).trim();

  return {
    titulo: title,
    noticia: body,
    contenido: body,
    parrafos: paragraphs,
    extracto: excerpt,
    ...(image ? { imagen: image } : {}),
    categoria: category,
    source,
    fuente: source,
    origen: "manual",
    es_manual: true,
  };
}

export function splitManualNewsBody(value: string): string[] {
  return value
    .trim()
    .split(/\n\s*\n|\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
