import { describe, expect, it } from "vitest";
import { commandPayloadSchemas, hasExternalSideEffect, resourceKeyFor } from "../packages/contracts/src/index.js";
import { expiredLeaseOutcome } from "../apps/server/src/command-state.js";

describe("command contracts and crash policy", () => {
  it("rejects parser breakage inputs before reaching a scraper", () => {
    expect(commandPayloadSchemas["scraper.details"].safeParse({ source: "tn", urls: ["not-a-url"] }).success).toBe(false);
    expect(commandPayloadSchemas["scraper.details"].safeParse({ source: "unknown", urls: ["https://example.com/a"] }).success).toBe(false);
    expect(commandPayloadSchemas["xvideo.batch.create"].safeParse({ sourceUrls: [] }).success).toBe(false);
  });

  it("serializes publication resources that could duplicate output", () => {
    expect(resourceKeyFor("news.publish", {})).toBe("publishing:global");
    expect(resourceKeyFor("xvideo.publish", { jobId: "42" })).toBe("video:42");
    expect(hasExternalSideEffect("news.publish")).toBe(true);
  });

  it("only accepts current publication destinations", () => {
    expect(commandPayloadSchemas["news.publish"].safeParse({
      selectedIndices: [],
      directNewsItems: [{ titulo: "Prueba" }],
      platforms: ["legacy-platform"],
      whatsappGroups: [],
      whatsappGroupSet: null,
      instagramEmojis: true,
    }).success).toBe(false);
    expect(commandPayloadSchemas["news.load_wordpress"].safeParse({ perPage: 51 }).success).toBe(false);
  });

  it("never auto-retries after an external side effect", () => {
    expect(expiredLeaseOutcome({ type: "news.publish", status: "running", sideEffectStarted: true, attemptCount: 1, maxAttempts: 1 })).toBe("requires_attention");
    expect(expiredLeaseOutcome({ type: "scraper.titles", status: "running", sideEffectStarted: false, attemptCount: 1, maxAttempts: 3 })).toBe("queued");
    expect(expiredLeaseOutcome({ type: "scraper.titles", status: "running", sideEffectStarted: false, attemptCount: 3, maxAttempts: 3 })).toBe("failed");
  });
});
