import { describe, expect, it } from "vitest";
import { articleAge, extractArticles, relativeAge, stageLabel } from "../apps/web/src/ui.js";
import { pickDefaultGroupSet } from "../apps/web/src/content.js";

describe("content presentation helpers", () => {
  it("extracts scraper results without exposing raw JSON as the primary UI", () => {
    expect(extractArticles({ articles: [{ titulo: "Uno" }, { titulo: "Dos" }], count: 2 })).toHaveLength(2);
    expect(extractArticles({ unavailable: true })).toEqual([]);
  });

  it("shows a deterministic relative publication age", () => {
    const now = Date.UTC(2026, 6, 19, 15, 0, 0);
    expect(relativeAge(now - 45 * 60_000, now)).toBe("Hace 45 min");
    expect(relativeAge(now - 3 * 60 * 60_000, now)).toBe("Hace 3 h");
    expect(relativeAge(now - 2 * 24 * 60 * 60_000, now)).toBe("Hace 2 días");
  });

  it("recognizes scraper dates in Spanish and URL dates", () => {
    const now = new Date(2026, 6, 19, 15, 0, 0).getTime();
    expect(articleAge({ fecha_texto: "19 de julio de 2026" }, now)).toBe("Hace 15 h");
    expect(articleAge({ fecha_texto: "hace 2 horas" }, now)).toBe("Hace 2 horas");
    expect(articleAge({ url: "https://example.com/2026/07/18/noticia" }, now)).toBe("Hace 1 día");
    expect(articleAge({ titulo: "Sin fecha" }, now)).toBe("Fecha no disponible");
  });

  it("prefers the saved default WhatsApp set and otherwise uses the first one", () => {
    const sets = [{ id: "first", nombre: "Primero" }, { id: "default", nombre: "Predeterminado" }];
    expect(pickDefaultGroupSet(sets)?.id).toBe("default");
    expect(pickDefaultGroupSet(sets.slice(0, 1))?.id).toBe("first");
    expect(pickDefaultGroupSet([])).toBeNull();
  });

  it("passes an already-human-readable prefixed stage through verbatim instead of title-casing it", () => {
    expect(stageLabel("video_publish:Instagram: procesando video (intento 12/60)")).toBe(
      "Instagram: procesando video (intento 12/60)",
    );
    expect(stageLabel("video_publish:X: enviando video al worker")).toBe("X: enviando video al worker");
  });

  it("falls back to humanizing a plain machine-style stage key", () => {
    expect(stageLabel("video_render")).toBe("Video Render");
    expect(stageLabel("news_publish")).toBe("News Publish");
    expect(stageLabel("")).toBe("");
  });
});
