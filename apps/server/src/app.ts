import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentHeartbeatSchema, agentUpdateSchema, commandCreateSchema, commandStatusSchema, hasExternalSideEffect,
  isCommandType, parseCommandPayload, requiredCapability, resourceKeyFor, type CommandStatus, type CommandType, type SnapshotRecord,
} from "../../../packages/contracts/src/index.js";
import { AuthService } from "./auth.js";
import { config } from "./config.js";
import type { AgentRecord, CommandInternal, Repository } from "./repository.js";
import { randomToken, safeEqual, sanitizeForLog, sha256, tokenHash } from "./security.js";

const idSchema = z.object({ id: z.string().min(1).max(200) });
const snapshotSchema = z.object({ key: z.string().min(1).max(190), revision: z.number().int().min(0), schemaVersion: z.number().int().min(1).max(100).default(1), payload: z.unknown(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.string().datetime() }).strict();

export async function createApp(repository: Repository) {
  const app = Fastify({ logger: { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie", "body.password", "body.leaseToken"] }, bodyLimit: 5 * 1024 * 1024, trustProxy: true, requestIdHeader: "x-request-id", genReqId: () => randomUUID() });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 100, timeWindow: "1 minute" });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "https://holasaltamedia.cc"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: "no-referrer" },
  });
  // Hostinger/LiteSpeed owns transport compression. Compressing again inside
  // Fastify makes larger dynamic responses arrive with an empty body through
  // the Node wrapper, even though the route completed with HTTP 200.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  const auth = new AuthService(repository);

  app.get("/health", async () => ({ status: "healthy", service: "holasalta-ops", version: "1.0.0", storage: config.storageDriver }));
  app.get("/api/health", async () => ({ status: "healthy", now: new Date().toISOString() }));
  app.get("/api/version", async () => ({ version: "1.0.0", commandSchemaVersion: 1 }));

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, (req, rep) => auth.login(req, rep));
  app.get("/api/auth/me", (req, rep) => auth.me(req, rep));
  app.get("/api/auth/csrf", (req, rep) => auth.csrf(req, rep));
  app.post("/api/auth/logout", (req, rep) => auth.logout(req, rep));
  app.post("/api/auth/sessions/revoke-all", (req, rep) => auth.revokeAll(req, rep));
  app.post("/api/auth/totp/setup", (req, rep) => auth.setupTotp(req, rep));
  app.post("/api/auth/totp/enable", (req, rep) => auth.enableTotp(req, rep));

  app.get("/api/dashboard", async (req, rep) => {
    const ctx = await auth.requireUser(req, rep); if (!ctx) return;
    const [agent, snapshots, commands] = await Promise.all([repository.findAgent(config.bootstrap.agentId), repository.listSnapshots(), repository.listCommands(25)]);
    const agentOnline = Boolean(agent?.lastSeenAt && Date.now() - Date.parse(agent.lastSeenAt) < 30_000);
    rep.send({ agent: agent ? { ...agent, tokenHash: undefined, online: agentOnline } : null, snapshots: snapshots.map(withFreshness), commands: commands.map(publicCommand), counts: { active: commands.filter((c) => ["queued", "claimed", "running"].includes(c.status)).length, attention: commands.filter((c) => ["requires_attention", "waiting_manual_retry", "completed_unverified"].includes(c.status)).length } });
  });
  app.get("/api/snapshots", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; rep.send({ items: (await repository.listSnapshots()).map(withFreshness) }); });
  app.get("/api/snapshots/:id", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; const parsed = idSchema.safeParse(req.params); if (!parsed.success) return rep.code(400).send({ error: "INVALID_ID" }); const snapshot = await repository.getSnapshot(parsed.data.id); return snapshot ? rep.send(withFreshness(snapshot)) : rep.code(404).send({ error: "NOT_FOUND" }); });

  app.post("/api/commands", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, rep) => {
    const ctx = await auth.requireUser(req, rep, true); if (!ctx) return;
    const parsed = commandCreateSchema.safeParse(req.body); if (!parsed.success || !isCommandType(parsed.data.type)) return rep.code(400).send({ error: "INVALID_COMMAND", details: parsed.success ? undefined : parsed.error.flatten() });
    const type = parsed.data.type as CommandType; let payload: Record<string, unknown>;
    try { payload = parseCommandPayload(type, parsed.data.payload); } catch (error) { return rep.code(400).send({ error: "INVALID_PAYLOAD", message: error instanceof Error ? error.message : "Payload invalido" }); }
    const key = String(req.headers["idempotency-key"] ?? "").trim(); if (!key || key.length > 190) return rep.code(400).send({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    const payloadHash = sha256(JSON.stringify(payload));
    const result = await repository.createCommand({ id: randomUUID(), type, payload, payloadHash, idempotencyKey: key, priority: parsed.data.priority, requiredCapability: requiredCapability(type), resourceKey: resourceKeyFor(type, payload), createdBy: ctx.user.id, maxAttempts: hasExternalSideEffect(type) ? 1 : 3 });
    if (!safeEqual(result.command.payloadHash, payloadHash)) return rep.code(409).send({ error: "IDEMPOTENCY_CONFLICT", message: "La clave ya fue usada con otro payload" });
    if (result.created) await repository.appendEvent(result.command.id, "queued", "info", "Comando encolado", { type });
    await repository.addAudit({ actorType: "user", actorId: ctx.user.id, action: "command.create", targetType: "command", targetId: result.command.id, result: result.created ? "created" : "reused", metadata: { type } });
    rep.code(result.created ? 201 : 200).send({ command: publicCommand(result.command), created: result.created });
  });
  app.get("/api/commands", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), status: commandStatusSchema.optional() }).safeParse(req.query); if (!query.success) return rep.code(400).send({ error: "INVALID_QUERY" }); rep.send({ items: (await repository.listCommands(query.data.limit, query.data.status)).map(publicCommand) }); });
  app.get("/api/commands/:id", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; const id = idSchema.safeParse(req.params); if (!id.success) return rep.code(400).send({ error: "INVALID_ID" }); const command = await repository.getCommand(id.data.id); return command ? rep.send({ command: publicCommand(command) }) : rep.code(404).send({ error: "NOT_FOUND" }); });
  app.get("/api/commands/:id/events", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; const id = idSchema.safeParse(req.params); if (!id.success) return rep.code(400).send({ error: "INVALID_ID" }); rep.send({ items: await repository.listEvents(id.data.id, 500) }); });
  app.post("/api/commands/:id/cancel", async (req, rep) => { const ctx = await auth.requireUser(req, rep, true); if (!ctx) return; const id = idSchema.safeParse(req.params); if (!id.success) return rep.code(400).send({ error: "INVALID_ID" }); const command = await repository.cancelCommand(id.data.id); if (!command) return rep.code(409).send({ error: "NOT_CANCELLABLE" }); await repository.appendEvent(command.id, "cancelled", "warning", "Comando cancelado por el usuario"); rep.send({ command: publicCommand(command) }); });
  app.post("/api/commands/:id/retry", async (req, rep) => { const ctx = await auth.requireUser(req, rep, true); if (!ctx) return; const id = idSchema.safeParse(req.params); if (!id.success) return rep.code(400).send({ error: "INVALID_ID" }); const command = await repository.retryCommand(id.data.id); if (!command) return rep.code(409).send({ error: "NOT_RETRYABLE" }); await repository.appendEvent(command.id, "requeued", "warning", "Reintento solicitado por el usuario"); rep.send({ command: publicCommand(command) }); });
  app.get("/api/audit", async (req, rep) => { const ctx = await auth.requireUser(req, rep); if (!ctx) return; if (ctx.user.role !== "admin") return rep.code(403).send({ error: "FORBIDDEN" }); rep.send({ items: await repository.listAudit(500) }); });

  app.post("/api/agent/heartbeat", async (req, rep) => { const agent = await requireAgent(req, rep, repository); if (!agent) return; const body = agentHeartbeatSchema.safeParse(req.body); if (!body.success || body.data.agentId !== agent.id) return rep.code(400).send({ error: "INVALID_HEARTBEAT" }); const updated = await repository.heartbeatAgent(agent.id, body.data.version, body.data.capabilities, body.data.localHealth); rep.send({ ok: true, agent: updated && { ...updated, tokenHash: undefined }, serverTime: new Date().toISOString() }); });
  app.post("/api/agent/commands/claim", async (req, rep) => { const agent = await requireAgent(req, rep, repository); if (!agent) return; const body = z.object({ capabilities: z.array(z.string().min(1).max(100)).max(100) }).safeParse(req.body); if (!body.success) return rep.code(400).send({ error: "INVALID_REQUEST" }); const leaseToken = randomToken(); const command = await repository.claimCommand(agent.id, body.data.capabilities, tokenHash(leaseToken, config.tokenPepper), new Date(Date.now() + 60_000).toISOString()); if (!command) return rep.code(204).send(); await repository.appendEvent(command.id, "claimed", "info", "Comando reclamado por el agente", { agentId: agent.id, attempt: command.attemptCount }); rep.send({ command: publicCommand(command), leaseToken, leaseSeconds: 60 }); });
  app.post("/api/agent/commands/:id/start", (req, rep) => agentMutation(req, rep, repository, "start"));
  app.post("/api/agent/commands/:id/heartbeat", (req, rep) => agentMutation(req, rep, repository, "heartbeat"));
  app.post("/api/agent/commands/:id/side-effect", (req, rep) => agentMutation(req, rep, repository, "side-effect"));
  app.post("/api/agent/commands/:id/complete", (req, rep) => agentMutation(req, rep, repository, "complete"));
  app.post("/api/agent/commands/:id/fail", (req, rep) => agentMutation(req, rep, repository, "fail"));
  app.put("/api/agent/snapshots/:id", async (req, rep) => { const agent = await requireAgent(req, rep, repository); if (!agent) return; const id = idSchema.safeParse(req.params); const body = snapshotSchema.safeParse({ ...(req.body as object), key: id.success ? id.data.id : "" }); if (!id.success || !body.success) return rep.code(400).send({ error: "INVALID_SNAPSHOT" }); const saved = await repository.upsertSnapshot(agent.id, body.data as SnapshotRecord); rep.send({ snapshot: saved }); });
  app.post("/api/agent/events/batch", async (req, rep) => { const agent = await requireAgent(req, rep, repository); if (!agent) return; const body = z.object({ commandId: z.string().min(1).max(200), events: z.array(z.object({ eventType: z.string().max(100), level: z.string().max(20), message: z.string().max(2000), metadata: z.unknown().optional() })).max(100) }).safeParse(req.body); if (!body.success) return rep.code(400).send({ error: "INVALID_EVENTS" }); for (const event of body.data.events) await repository.appendEvent(body.data.commandId, event.eventType, event.level, event.message, sanitizeForLog(event.metadata)); rep.send({ accepted: body.data.events.length }); });

  const webRoot = resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/", wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.type("text/html").sendFile("index.html"));
  }
  return app;
}

async function requireAgent(request: FastifyRequest, reply: FastifyReply, repository: Repository): Promise<AgentRecord | null> {
  const id = String(request.headers["x-ops-agent-id"] ?? ""); const authorization = String(request.headers.authorization ?? ""); const raw = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const agent = id ? await repository.findAgent(id) : null;
  if (!agent || agent.revokedAt || !raw || !safeEqual(tokenHash(raw, config.tokenPepper), agent.tokenHash)) { reply.code(401).send({ error: "AGENT_AUTH_REQUIRED" }); return null; }
  return agent;
}

async function agentMutation(request: FastifyRequest, reply: FastifyReply, repository: Repository, action: "start" | "heartbeat" | "side-effect" | "complete" | "fail") {
  const agent = await requireAgent(request, reply, repository); if (!agent) return;
  const id = idSchema.safeParse(request.params); const body = agentUpdateSchema.extend({ status: commandStatusSchema.optional() }).safeParse(request.body);
  if (!id.success || !body.success) return reply.code(400).send({ error: "INVALID_UPDATE" });
  const leaseHash = tokenHash(body.data.leaseToken, config.tokenPepper); let command: CommandInternal | null = null;
  if (action === "start") command = await repository.startCommand(id.data.id, leaseHash, body.data.localJobId);
  else if (action === "heartbeat") command = await repository.heartbeatCommand(id.data.id, leaseHash, new Date(Date.now() + 60_000).toISOString(), body.data);
  else if (action === "side-effect") { const ok = await repository.markSideEffect(id.data.id, leaseHash); if (!ok) return reply.code(409).send({ error: "LEASE_LOST" }); command = await repository.getCommand(id.data.id); }
  else {
    const status: CommandStatus = action === "fail" ? (body.data.status && ["failed", "waiting_manual_retry", "requires_attention", "partial_success"].includes(body.data.status) ? body.data.status : "failed") : (body.data.status && ["completed", "partial_success", "completed_unverified"].includes(body.data.status) ? body.data.status : "completed");
    command = await repository.finishCommand(id.data.id, leaseHash, status, body.data);
  }
  if (!command) return reply.code(409).send({ error: "LEASE_LOST_OR_INVALID_STATE" });
  if (action !== "heartbeat") await repository.appendEvent(command.id, action, action === "fail" ? "error" : "info", `Agente reporto ${action}`, sanitizeForLog({ stage: command.currentStage, errorCode: command.errorCode }));
  reply.send({ command: publicCommand(command) });
}

function publicCommand(c: CommandInternal) {
  const { leaseTokenHash, idempotencyKey, payloadHash, ...publicValue } = c;
  void leaseTokenHash; void idempotencyKey; void payloadHash;
  return publicValue;
}
function withFreshness(snapshot: SnapshotRecord) { const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 1000)); return { ...snapshot, ageSeconds, fresh: ageSeconds < 60 }; }
