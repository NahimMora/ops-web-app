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

  it("wakes a long-poll claim as soon as a command is created, instead of waiting out waitMs", async () => {
    const { rawAgentToken, password } = await fixture();
    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "holasalta@acceso.com", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;

    const startedAt = Date.now();
    const pendingClaim = app!.inject({
      method: "POST", url: "/api/agent/commands/claim",
      headers: { authorization: `Bearer ${rawAgentToken}`, "x-ops-agent-id": "pc-holasalta-01" },
      payload: { capabilities: ["scraping"], waitMs: 5000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const created = await app!.inject({
      method: "POST", url: "/api/commands",
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "long-poll-key" },
      payload: { type: "scraper.titles", payload: { source: "tn", maxArticles: 1 }, priority: 0 },
    });
    expect(created.statusCode).toBe(201);

    const claimed = await pendingClaim;
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().command.id).toBe(created.json().command.id);
    expect(Date.now() - startedAt).toBeLessThan(4000);
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

  it("stamps the WordPress author id onto manual news items for mapped operator emails", async () => {
    const { repository, password } = await fixture();
    const operatorPassword = "Operator-Test-Password-99!";
    await repository.initialize({
      adminEmail: "holasalta@acceso.com",
      passwordHash: await hashPassword(password),
      agentId: "pc-holasalta-01",
      agentName: "PC",
      agentTokenHash: tokenHash("test-agent-token-with-at-least-thirty-two-bytes", "development-token-pepper-change-me"),
      extraUsers: [{ email: "lourdes@acceso.com", passwordHash: await hashPassword(operatorPassword), displayName: "Lourdes", role: "operator" }],
    });

    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lourdes@acceso.com", password: operatorPassword } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;
    const manualItem = { titulo: "Nota manual", es_manual: true, origen: "manual" };

    const created = await app!.inject({
      method: "POST", url: "/api/commands",
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "manual-author-key" },
      payload: { type: "news.publish", payload: { selectedIndices: [], directNewsItems: [manualItem], platforms: ["web"] } },
    });
    expect(created.statusCode).toBe(201);
    const stored = await repository.getCommand(created.json().command.id);
    expect((stored?.payload as any).directNewsItems[0]).toMatchObject({ titulo: "Nota manual", wp_author_id: 4 });
  });

  it("leaves the WordPress author untouched for operators without an author mapping", async () => {
    const { repository, password } = await fixture();
    const operatorPassword = "Operator-Test-Password-99!";
    await repository.initialize({
      adminEmail: "holasalta@acceso.com",
      passwordHash: await hashPassword(password),
      agentId: "pc-holasalta-01",
      agentName: "PC",
      agentTokenHash: tokenHash("test-agent-token-with-at-least-thirty-two-bytes", "development-token-pepper-change-me"),
      extraUsers: [{ email: "otro@acceso.com", passwordHash: await hashPassword(operatorPassword), displayName: "Otro", role: "operator" }],
    });

    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "otro@acceso.com", password: operatorPassword } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;
    const manualItem = { titulo: "Nota manual", es_manual: true, origen: "manual" };

    const created = await app!.inject({
      method: "POST", url: "/api/commands",
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "manual-author-key-2" },
      payload: { type: "news.publish", payload: { selectedIndices: [], directNewsItems: [manualItem], platforms: ["web"] } },
    });
    expect(created.statusCode).toBe(201);
    const stored = await repository.getCommand(created.json().command.id);
    expect((stored?.payload as any).directNewsItems[0]).not.toHaveProperty("wp_author_id");
  });

  it("scopes /api/commands/mine to the caller's own submissions, not the admin-only global queue", async () => {
    const { repository, password } = await fixture();
    const operatorPassword = "Operator-Test-Password-99!";
    await repository.initialize({
      adminEmail: "holasalta@acceso.com",
      passwordHash: await hashPassword(password),
      agentId: "pc-holasalta-01",
      agentName: "PC",
      agentTokenHash: tokenHash("test-agent-token-with-at-least-thirty-two-bytes", "development-token-pepper-change-me"),
      extraUsers: [{ email: "lourdes@acceso.com", passwordHash: await hashPassword(operatorPassword), displayName: "Lourdes", role: "operator" }],
    });

    // A command created by someone else (the admin, and of a type the
    // operator couldn't even submit) must never show up in the operator's
    // own history.
    await repository.createCommand({ id: "admin-scraper-command", type: "scraper.titles", payload: { source: "tn", maxArticles: 1 }, payloadHash: "hash-1", idempotencyKey: "admin-key-1", priority: 0, requiredCapability: "scraping", resourceKey: null, createdBy: "bootstrap-admin", maxAttempts: 3 });

    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lourdes@acceso.com", password: operatorPassword } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;

    const unauthorized = await app!.inject({ method: "GET", url: "/api/commands/mine" });
    expect(unauthorized.statusCode).toBe(401);

    const beforePublish = await app!.inject({ method: "GET", url: "/api/commands/mine", headers: { cookie } });
    expect(beforePublish.statusCode).toBe(200);
    expect(beforePublish.json().items).toEqual([]);

    const published = await app!.inject({
      method: "POST", url: "/api/commands",
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "mine-history-key" },
      payload: { type: "news.publish", payload: { selectedIndices: [], directNewsItems: [{ titulo: "Nota de Lourdes", es_manual: true }], platforms: ["web"] } },
    });
    expect(published.statusCode).toBe(201);

    const afterPublish = await app!.inject({ method: "GET", url: "/api/commands/mine?type=news.publish", headers: { cookie } });
    expect(afterPublish.statusCode).toBe(200);
    expect(afterPublish.json().items).toHaveLength(1);
    expect(afterPublish.json().items[0].id).toBe(published.json().command.id);
    expect(afterPublish.json().items.some((item: any) => item.id === "admin-scraper-command")).toBe(false);

    // An admin-only command type filter should reject cleanly instead of
    // silently ignoring the param.
    const invalidType = await app!.inject({ method: "GET", url: "/api/commands/mine?type=not-a-real-type", headers: { cookie } });
    expect(invalidType.statusCode).toBe(400);
  });

  it("lets a restricted operator manage their own command but not someone else's", async () => {
    const { repository, password } = await fixture();
    const operatorPassword = "Operator-Test-Password-99!";
    await repository.initialize({
      adminEmail: "holasalta@acceso.com",
      passwordHash: await hashPassword(password),
      agentId: "pc-holasalta-01",
      agentName: "PC",
      agentTokenHash: tokenHash("test-agent-token-with-at-least-thirty-two-bytes", "development-token-pepper-change-me"),
      extraUsers: [{ email: "lourdes@acceso.com", passwordHash: await hashPassword(operatorPassword), displayName: "Lourdes", role: "operator" }],
    });
    const ownCommand = (await repository.createCommand({ id: "operator-own-command", type: "news.publish", payload: { selectedIndices: [], directNewsItems: [{ titulo: "Nota" }], platforms: ["web"] }, payloadHash: "hash-own", idempotencyKey: "own-key", priority: 0, requiredCapability: "publishing:global", resourceKey: null, createdBy: "bootstrap-lourdes@acceso.com", maxAttempts: 3 })).command;
    const othersCommand = (await repository.createCommand({ id: "admin-owned-command", type: "scraper.titles", payload: { source: "tn", maxArticles: 1 }, payloadHash: "hash-other", idempotencyKey: "other-key", priority: 0, requiredCapability: "scraping", resourceKey: null, createdBy: "bootstrap-admin", maxAttempts: 3 })).command;

    const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lourdes@acceso.com", password: operatorPassword } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrf = login.json().csrfToken as string;

    const getOwn = await app!.inject({ method: "GET", url: `/api/commands/${ownCommand.id}`, headers: { cookie } });
    expect(getOwn.statusCode).toBe(200);
    const getOthers = await app!.inject({ method: "GET", url: `/api/commands/${othersCommand.id}`, headers: { cookie } });
    expect(getOthers.statusCode).toBe(403);

    const eventsOwn = await app!.inject({ method: "GET", url: `/api/commands/${ownCommand.id}/events`, headers: { cookie } });
    expect(eventsOwn.statusCode).toBe(200);
    const eventsOthers = await app!.inject({ method: "GET", url: `/api/commands/${othersCommand.id}/events`, headers: { cookie } });
    expect(eventsOthers.statusCode).toBe(403);

    const cancelOthers = await app!.inject({ method: "POST", url: `/api/commands/${othersCommand.id}/cancel`, headers: { cookie, "x-csrf-token": csrf } });
    expect(cancelOthers.statusCode).toBe(403);
    const cancelOwn = await app!.inject({ method: "POST", url: `/api/commands/${ownCommand.id}/cancel`, headers: { cookie, "x-csrf-token": csrf } });
    expect(cancelOwn.statusCode).toBe(200);
    expect(cancelOwn.json().command.status).toBe("cancelled");
  });

  it("rate-limits malformed login floods before password work", async () => {
    await fixture();
    const responses = [];
    for (let i = 0; i < 11; i++) responses.push(await app!.inject({ method: "POST", url: "/api/auth/login", payload: {} }));
    expect(responses.at(-1)?.statusCode).toBe(429);
  });
});
