import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../apps/server/src/app.js";
import { MemoryRepository } from "../apps/server/src/repository.js";
import { hashPassword, tokenHash } from "../apps/server/src/security.js";

let app: FastifyInstance | null = null;
afterEach(async () => { if (app) await app.close(); app = null; });

async function fixture() {
  const repository = new MemoryRepository();
  const password = "Valid-Test-Password-99!";
  const rawAgentToken = "test-agent-token-with-at-least-thirty-two-bytes";
  await repository.initialize({
    adminEmail: "holasalta@acceso.com",
    passwordHash: await hashPassword(password),
    agentId: "pc-holasalta-01",
    agentName: "PC",
    agentTokenHash: tokenHash(rawAgentToken, "development-token-pepper-change-me"),
  });
  app = await createApp(repository);
  return { repository, password, rawAgentToken };
}

describe("HTTP API", () => {
  it("authenticates, enforces CSRF and deduplicates command submission", async () => {
    const { password } = await fixture();
    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "holasalta@acceso.com", password } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;
    const commandPayload = { type: "scraper.titles", payload: { source: "tn", maxArticles: 1 }, priority: 0 };

    const rejected = await app!.inject({ method: "POST", url: "/api/commands", headers: { cookie, "idempotency-key": "api-test-key" }, payload: commandPayload });
    expect(rejected.statusCode).toBe(403);

    const first = await app!.inject({ method: "POST", url: "/api/commands", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "api-test-key" }, payload: commandPayload });
    const duplicate = await app!.inject({ method: "POST", url: "/api/commands", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "api-test-key" }, payload: commandPayload });
    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().created).toBe(false);
    expect(duplicate.json().command.id).toBe(first.json().command.id);

    const conflict = await app!.inject({ method: "POST", url: "/api/commands", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "api-test-key" }, payload: { ...commandPayload, payload: { source: "tn", maxArticles: 2 } } });
    expect(conflict.statusCode).toBe(409);
  });

  it("lets only one concurrent claim receive the queued command", async () => {
    const { repository, rawAgentToken } = await fixture();
    await repository.createCommand({ id: "queued-command", type: "scraper.titles", payload: { source: "tn", maxArticles: 1 }, payloadHash: "hash", idempotencyKey: "claim-key", priority: 0, requiredCapability: "scraping", resourceKey: null, createdBy: "bootstrap-admin", maxAttempts: 3 });
    const request = { method: "POST" as const, url: "/api/agent/commands/claim", headers: { authorization: `Bearer ${rawAgentToken}`, "x-ops-agent-id": "pc-holasalta-01" }, payload: { capabilities: ["scraping"] } };
    const responses = await Promise.all([app!.inject(request), app!.inject(request)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 204]);
  });

  it("returns large dashboard, command and audit bodies without app-level compression", async () => {
    const { repository, password } = await fixture();
    await repository.createCommand({
      id: "large-command",
      type: "scraper.details",
      payload: {
        source: "tn",
        urls: Array.from({ length: 80 }, (_, index) => `https://example.test/article-${index}`),
      },
      payloadHash: "large-hash",
      idempotencyKey: "large-response-key",
      priority: 0,
      requiredCapability: "scraping",
      resourceKey: null,
      createdBy: "bootstrap-admin",
      maxAttempts: 3,
    });

    const login = await app!.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "holasalta@acceso.com", password },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, "accept-encoding": "gzip" };

    for (const url of ["/api/dashboard", "/api/commands?limit=10", "/api/audit"]) {
      const response = await app!.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.body.length).toBeGreaterThan(0);
      expect(() => response.json()).not.toThrow();
    }

    const commands = await app!.inject({ method: "GET", url: "/api/commands?limit=10", headers });
    expect(commands.json().items).toHaveLength(1);
    expect(commands.body.length).toBeGreaterThan(1_024);
  });

  it("accepts authenticated manual-news images and serves them to the local pipeline", async () => {
    const { password } = await fixture();
    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "holasalta@acceso.com", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;
    const payload = {
      fileName: "noticia.png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zp78AAAAASUVORK5CYII=",
    };

    const rejected = await app!.inject({ method: "POST", url: "/api/manual-news/images", headers: { cookie }, payload });
    expect(rejected.statusCode).toBe(403);

    const uploaded = await app!.inject({ method: "POST", url: "/api/manual-news/images", headers: { cookie, "x-csrf-token": csrf }, payload });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ mimeType: "image/png", sizeBytes: 68 });

    const imagePath = new URL(uploaded.json().url).pathname;
    const image = await app!.inject({ method: "GET", url: imagePath });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("rate-limits malformed login floods before password work", async () => {
    await fixture();
    const responses = [];
    for (let i = 0; i < 11; i++) responses.push(await app!.inject({ method: "POST", url: "/api/auth/login", payload: {} }));
    expect(responses.at(-1)?.statusCode).toBe(429);
  });
});
