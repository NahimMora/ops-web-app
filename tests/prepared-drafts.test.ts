import { describe, expect, it } from "vitest";
import { applyEdit, articleKey, editorValues, isEditDirty, withoutSavedEdits } from "../apps/web/src/prepared-drafts.js";

const scraped = {
  source_id: "infobae-123",
  titulo: "WANDA NARA DESTROZÓ A LA CHINA SUÁREZ",
  extracto: "Fuerte cruce en redes.",
  parrafos: ["Primer párrafo.", "Segundo párrafo."],
  source: "infobae",
};

describe("prepared drafts edit overlay", () => {
  it("identifies notes by source id, not by position", () => {
    expect(articleKey(scraped)).toBe("infobae-123");
    expect(articleKey({ url: "https://x.test/nota" })).toBe("https://x.test/nota");
  });

  it("keeps the operator's raw text while typing (no trim/split per keystroke)", () => {
    const values = editorValues(scraped, { title: "Wanda Nara destrozó ", body: "Primer párrafo.\n\n" });
    expect(values.title).toBe("Wanda Nara destrozó ");
    expect(values.body).toBe("Primer párrafo.\n\n");
  });

  it("locks a hand-corrected title but keeps the note on the AI path", () => {
    const item = applyEdit(scraped, { title: "  Wanda Nara destrozó a la China Suárez  " });
    expect(item.titulo).toBe("Wanda Nara destrozó a la China Suárez");
    expect(item.titulo_bloqueado).toBe(true);
    expect(item.manual_override).toBeUndefined();
  });

  it("uses an edited body as the new source, split into paragraphs only when built", () => {
    const item = applyEdit(scraped, { body: "Uno.\n\nDos.\nTres." });
    expect(item.parrafos).toEqual(["Uno.", "Dos.", "Tres."]);
    expect(item.titulo_bloqueado).toBeUndefined();
    expect(item.manual_override).toBeUndefined();
  });

  it("only skips the AI pass when the operator asks for it explicitly", () => {
    expect(applyEdit(scraped, { skipAi: true }).manual_override).toBe(true);
    expect(editorValues(scraped, undefined).skipAi).toBe(false);
  });

  it("does not count an edit that leaves the note unchanged as dirty", () => {
    expect(isEditDirty(scraped, { title: scraped.titulo, body: "Primer párrafo.\n\nSegundo párrafo." })).toBe(false);
    expect(isEditDirty(scraped, { excerpt: "Otro copete" })).toBe(true);
  });

  it("drops saved edits but keeps the ones typed after saving", () => {
    const savedA = { title: "A" };
    const savedB = { title: "B" };
    const typedAfter = { title: "B2" };
    const saved = { a: savedA, b: savedB };
    expect(withoutSavedEdits({ a: savedA, b: typedAfter, c: { title: "C" } }, saved)).toEqual({ b: typedAfter, c: { title: "C" } });
  });
});
