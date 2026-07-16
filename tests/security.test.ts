import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, safeEqual, sanitizeForLog, tokenHash, verifyPassword } from "../apps/server/src/security.js";

describe("security primitives", () => {
  it("hashes passwords with a unique salt and verifies without exposing the password", async () => {
    const first = await hashPassword("Correct-Horse-99!");
    const second = await hashPassword("Correct-Horse-99!");
    expect(first).not.toBe(second);
    expect(await verifyPassword("Correct-Horse-99!", first)).toBe(true);
    expect(await verifyPassword("incorrect", first)).toBe(false);
    expect(first).not.toContain("Correct-Horse");
  });

  it("encrypts TOTP material and uses constant-length token digests", () => {
    const encrypted = encryptSecret("TOPSECRET", "a-production-key-with-more-than-32-characters");
    expect(encrypted).not.toContain("TOPSECRET");
    expect(decryptSecret(encrypted, "a-production-key-with-more-than-32-characters")).toBe("TOPSECRET");
    expect(tokenHash("agent-token", "pepper")).toHaveLength(64);
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "other")).toBe(false);
  });

  it("redacts nested credentials before audit or log persistence", () => {
    expect(sanitizeForLog({ password: "never", nested: { apiKey: "never", ok: "visible" } })).toEqual({
      password: "[REDACTED]", nested: { apiKey: "[REDACTED]", ok: "visible" },
    });
  });
});
