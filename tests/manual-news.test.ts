import { describe, expect, it } from "vitest";
import { commandPayloadSchemas } from "../packages/contracts/src/index.js";
import { buildManualNewsItem, validateManualNewsDraft } from "../apps/web/src/manual-news.js";

const validDraft = {
  title: "Una noticia creada desde el panel",
  body: "Primer párrafo de la noticia.\n\nSegundo párrafo con más información.",
  image: "https://example.com/noticia.jpg",
  category: "Salta",
  source: "Redacción HolaSalta",
};

describe("manual news publication", () => {
  it("builds the legacy-compatible editorial shape used by the publishing pipeline", () => {
    const item = buildManualNewsItem(validDraft);

    expect(item).toMatchObject({
      titulo: validDraft.title,
      contenido: validDraft.body,
      noticia: validDraft.body,
      parrafos: ["Primer párrafo de la noticia.", "Segundo párrafo con más información."],
      imagen: validDraft.image,
      categoria: "Salta",
      source: "Redacción HolaSalta",
      fuente: "Redacción HolaSalta",
      origen: "manual",
      es_manual: true,
    });
    expect(item.extracto).toBe("Primer párrafo de la noticia. Segundo párrafo con más información.");
  });

  it("validates required editorial fields and rejects non-http image values", () => {
    expect(validateManualNewsDraft(validDraft)).toBeNull();
    expect(validateManualNewsDraft({ ...validDraft, title: "" })).toMatch(/título/i);
    expect(validateManualNewsDraft({ ...validDraft, image: "data:image/png;base64,abc" })).toMatch(/URL http/i);
  });

  it("is accepted as a direct news item by the existing multichannel command", () => {
    expect(commandPayloadSchemas["news.publish"].safeParse({
      selectedIndices: [],
      directNewsItems: [buildManualNewsItem(validDraft)],
      platforms: ["web", "instagram", "facebook"],
      whatsappGroups: [],
      whatsappGroupSet: null,
      instagramEmojis: true,
    }).success).toBe(true);
  });
});
