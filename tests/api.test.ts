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

  it("rate-limits malformed login floods before password work", async () => {
    await fixture();
    const responses = [];
    for (let i = 0; i < 11; i++) responses.push(await app!.inject({ method: "POST", url: "/api/auth/login", payload: {} }));
    expect(responses.at(-1)?.statusCode).toBe(429);
  });
});
