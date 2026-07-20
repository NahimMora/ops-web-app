import { describe, expect, it } from "vitest";
import { MemoryRepository, type CreateCommandInput } from "../apps/server/src/repository.js";

const bootstrap = { adminEmail: "holasalta@acceso.com", passwordHash: "unused", agentId: "pc-holasalta-01", agentName: "PC", agentTokenHash: "hash" };
function input(id: string, key: string, resourceKey: string | null = null): CreateCommandInput {
  return { id, type: "scraper.titles", payload: { source: "tn", maxArticles: 10 }, payloadHash: "payload", idempotencyKey: key, priority: 0, requiredCapability: "scraping", resourceKey, createdBy: "bootstrap-admin", maxAttempts: 3 };
}

describe("repository concurrency and retry safety", () => {
  it("rotates the bootstrap password, clears lockout and revokes sessions", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.recordLoginResult("bootstrap-admin", false, new Date(Date.now() + 60_000).toISOString());
    await repository.initialize(bootstrap);
    expect(await repository.getUser("bootstrap-admin")).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    await repository.createSession({ id: "session", userId: "bootstrap-admin", tokenHash: "token", csrfTokenHash: "csrf", expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null });

    await repository.initialize({ ...bootstrap, passwordHash: "rotated" });

    const user = await repository.getUser("bootstrap-admin");
    expect(user).toMatchObject({ passwordHash: "rotated", failedLoginCount: 0, lockedUntil: null });
    expect(await repository.getSession("token")).toBeNull();
  });

  it("deduplicates the same command idempotency key", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    const first = await repository.createCommand(input("one", "stable-key"));
    const duplicate = await repository.createCommand(input("two", "stable-key"));
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.command.id).toBe("one");
  });

  it("allows only one concurrent worker to claim a command", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.createCommand(input("one", "key-one"));
    const claims = await Promise.all([
      repository.claimCommand("pc-holasalta-01", ["scraping"], "lease-a", new Date(Date.now() + 60_000).toISOString()),
      repository.claimCommand("pc-holasalta-01", ["scraping"], "lease-b", new Date(Date.now() + 60_000).toISOString()),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("keeps two commands for the same exclusive resource from running together", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.createCommand(input("one", "key-one", "scraper:exclusive"));
    await repository.createCommand(input("two", "key-two", "scraper:exclusive"));
    const first = await repository.claimCommand("pc-holasalta-01", ["scraping"], "lease-a", new Date(Date.now() + 60_000).toISOString());
    const second = await repository.claimCommand("pc-holasalta-01", ["scraping"], "lease-b", new Date(Date.now() + 60_000).toISOString());
    expect(first?.id).toBe("one");
    expect(second).toBeNull();
  });

  it("returns a safe scraper job to the queue after lease expiry", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.createCommand(input("one", "key-one"));
    await repository.claimCommand("pc-holasalta-01", ["scraping"], "lease", new Date(Date.now() - 1_000).toISOString());
    expect(await repository.reapExpired(new Date().toISOString())).toBe(1);
    expect((await repository.getCommand("one"))?.status).toBe("queued");
  });

  it("clears a previous lease error after the retried command completes", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.createCommand(input("one", "key-one"));
    await repository.claimCommand("pc-holasalta-01", ["scraping"], "expired-lease", new Date(Date.now() - 1_000).toISOString());
    await repository.reapExpired(new Date().toISOString());
    expect(await repository.getCommand("one")).toMatchObject({ status: "queued", errorCode: "agent_lease_expired", retryable: true });

    await repository.claimCommand("pc-holasalta-01", ["scraping"], "fresh-lease", new Date(Date.now() + 60_000).toISOString());
    await repository.startCommand("one", "fresh-lease");
    const completed = await repository.finishCommand("one", "fresh-lease", "completed", { result: { ok: true } });

    expect(completed).toMatchObject({ status: "completed", errorCode: null, errorMessage: null, retryable: false });
  });

  it("preserves partial completion as a terminal outcome", async () => {
    const repository = new MemoryRepository(); await repository.initialize(bootstrap);
    await repository.createCommand(input("one", "key-one"));
    await repository.claimCommand("pc-holasalta-01", ["scraping"], "lease", new Date(Date.now() + 60_000).toISOString());
    await repository.startCommand("one", "lease");
    const finished = await repository.finishCommand("one", "lease", "partial_success", { progressPercent: 75, result: { ok: 3, failed: 1 } });
    expect(finished?.status).toBe("partial_success");
    expect(finished?.result).toEqual({ ok: 3, failed: 1 });
    expect(await repository.retryCommand("one")).toBeNull();
  });
});
