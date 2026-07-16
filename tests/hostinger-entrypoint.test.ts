import { describe, expect, it } from "vitest";

describe("Hostinger environment normalization", () => {
  it("normalizes escaped Scrypt separators without using a real secret", () => {
    const escaped = "scrypt\\$32768\\$8\\$1\\$abcdefghijklmnopqrstuv\\$" + "a".repeat(86);
    const normalized = escaped.replaceAll("\\$", "$");

    expect(escaped).toHaveLength(131);
    expect(normalized).toHaveLength(126);
    expect(normalized).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  });
});
