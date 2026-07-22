import type { ContentItem } from "./ui";

export type ManualNewsDraft = {
  sourceId: string;
  title: string;
  body: string;
  image: string;
  category: string;
  source: string;
};

export const EMPTY_MANUAL_NEWS_DRAFT: ManualNewsDraft = {
  sourceId: "",
  title: "",
  body: "",
  image: "",
  category: "",
  source: "",
};

export const MANUAL_NEWS_CATEGORIES = [
  "Salta",
  "Policiales",
  "Nacionales",
  "Deportes",
  "Espectáculos",
  "Internacionales",
  "¿Sabías que?",
  "Columnas",
] as const;

export function createManualNewsDraft(): ManualNewsDraft {
  return { ...EMPTY_MANUAL_NEWS_DRAFT, sourceId: crypto.randomUUID() };
}

export function validateManualNewsDraft(draft: ManualNewsDraft): string | null {
  if (!draft.title.trim()) return "Ingresá el título de la noticia.";
  if (!draft.body.trim()) return "Ingresá el contenido de la noticia.";
  if (draft.title.trim().length > 240) return "El título no puede superar los 240 caracteres.";
  if (draft.body.trim().length > 50_000) return "La noticia no puede superar los 50.000 caracteres.";
  if (draft.category.trim().length > 120) return "La categoría no puede superar los 120 caracteres.";
  if (draft.category.trim() && !(MANUAL_NEWS_CATEGORIES as readonly string[]).includes(draft.category.trim())) return "Elegí una categoría válida o usá Automática.";
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
  const source = draft.source.trim() || "Redacción HolaSalta";
  const paragraphs = splitManualNewsBody(body);
  const excerpt = paragraphs.join(" ").replace(/\s+/g, " ").slice(0, 320).trim();

  return {
    titulo: title,
    noticia: body,
    contenido: body,
    parrafos: paragraphs,
    extracto: excerpt,
    ...(image ? { imagen: image, imagen_url: image, imagenes_url: [image] } : {}),
    ...(category ? { categoria: category } : {}),
    source,
    fuente: source,
    source_id: `manual-${draft.sourceId || crypto.randomUUID()}`,
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
