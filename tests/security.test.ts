import { describe, expect, it } from "vitest";
import { r2BrowserOrigins } from "../apps/server/src/config.js";
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

  it("allows the bucket-specific R2 origin used by presigned browser uploads", () => {
    expect(r2BrowserOrigins("https://account.r2.cloudflarestorage.com", "media-bucket")).toEqual([
      "https://account.r2.cloudflarestorage.com",
      "https://media-bucket.account.r2.cloudflarestorage.com",
    ]);
    expect(r2BrowserOrigins("https://media-bucket.account.r2.cloudflarestorage.com", "media-bucket")).toEqual([
      "https://media-bucket.account.r2.cloudflarestorage.com",
    ]);
  });
});
