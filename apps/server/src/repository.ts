import { randomUUID } from "node:crypto";
import type { CommandRecord, CommandStatus, CommandType, SnapshotRecord } from "../../../packages/contracts/src/index.js";
import { expiredLeaseOutcome, isTerminal } from "./command-state.js";

export interface UserRecord {
  id: string; email: string; displayName: string; passwordHash: string; role: "admin" | "operator" | "viewer";
  status: "active" | "disabled"; failedLoginCount: number; lockedUntil: string | null; lastLoginAt: string | null;
  totpSecretEncrypted: string | null; totpEnabled: boolean;
}
export interface SessionRecord { id: string; userId: string; tokenHash: string; csrfTokenHash: string; expiresAt: string; revokedAt: string | null; }
export interface AgentRecord { id: string; name: string; tokenHash: string; status: string; version: string | null; capabilities: string[]; lastSeenAt: string | null; revokedAt: string | null; }
export interface CommandInternal extends CommandRecord {
  createdBy: string; idempotencyKey: string; payloadHash: string; assignedAgentId: string | null;
  leaseTokenHash: string | null; leaseExpiresAt: string | null; sideEffectStarted: boolean;
}
export interface CommandEvent { id: string; commandId: string; eventType: string; level: string; message: string; metadata: unknown; createdAt: string; }
export interface AuditRecord { id: string; actorType: string; actorId: string | null; action: string; targetType: string | null; targetId: string | null; result: string; metadata: unknown; createdAt: string; }
export interface BootstrapInput { adminEmail: string; passwordHash: string; agentId: string; agentName: string; agentTokenHash: string; }
export interface CreateCommandInput {
  id: string; type: CommandType; payload: Record<string, unknown>; payloadHash: string; idempotencyKey: string; priority: number;
  requiredCapability: string; resourceKey: string | null; createdBy: string; maxAttempts: number;
}
export interface UpdateInput { currentStage?: string; progressPercent?: number; localJobId?: string; result?: unknown; errorCode?: string; errorMessage?: string; retryable?: boolean; }

export interface Repository {
  initialize(bootstrap: BootstrapInput): Promise<void>;
  close(): Promise<void>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  recordLoginResult(userId: string, success: boolean, lockedUntil?: string | null): Promise<void>;
  setUserTotp(userId: string, encryptedSecret: string | null, enabled: boolean): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  rotateSessionCsrf(sessionId: string, csrfTokenHash: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  findAgent(id: string): Promise<AgentRecord | null>;
  heartbeatAgent(id: string, version: string, capabilities: string[], status: string): Promise<AgentRecord | null>;
  createCommand(input: CreateCommandInput): Promise<{ command: CommandInternal; created: boolean }>;
  getCommand(id: string): Promise<CommandInternal | null>;
  listCommands(limit: number, status?: CommandStatus): Promise<CommandInternal[]>;
  claimCommand(agentId: string, capabilities: string[], leaseTokenHash: string, leaseExpiresAt: string): Promise<CommandInternal | null>;
  startCommand(id: string, leaseTokenHash: string, localJobId?: string): Promise<CommandInternal | null>;
  markSideEffect(id: string, leaseTokenHash: string): Promise<boolean>;
  heartbeatCommand(id: string, leaseTokenHash: string, leaseExpiresAt: string, patch: UpdateInput): Promise<CommandInternal | null>;
  finishCommand(id: string, leaseTokenHash: string, status: CommandStatus, patch: UpdateInput): Promise<CommandInternal | null>;
  cancelCommand(id: string): Promise<CommandInternal | null>;
  retryCommand(id: string): Promise<CommandInternal | null>;
  appendEvent(commandId: string, eventType: string, level: string, message: string, metadata?: unknown): Promise<void>;
  listEvents(commandId: string, limit: number): Promise<CommandEvent[]>;
  upsertSnapshot(agentId: string, snapshot: SnapshotRecord): Promise<SnapshotRecord>;
  getSnapshot(key: string): Promise<SnapshotRecord | null>;
  listSnapshots(): Promise<SnapshotRecord[]>;
  addAudit(input: Omit<AuditRecord, "id" | "createdAt">): Promise<void>;
  listAudit(limit: number): Promise<AuditRecord[]>;
  reapExpired(now: string): Promise<number>;
}

function nowIso(): string { return new Date().toISOString(); }
function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryRepository implements Repository {
  private users = new Map<string, UserRecord>(); private sessions = new Map<string, SessionRecord>(); private agents = new Map<string, AgentRecord>();
  private commands = new Map<string, CommandInternal>(); private events: CommandEvent[] = []; private snapshots = new Map<string, SnapshotRecord>(); private audits: AuditRecord[] = [];
  async initialize(bootstrap: BootstrapInput): Promise<void> {
    const existing = [...this.users.values()].find((u) => u.email === bootstrap.adminEmail);
    if (!existing) this.users.set("bootstrap-admin", { id: "bootstrap-admin", email: bootstrap.adminEmail, displayName: "Administrador", passwordHash: bootstrap.passwordHash, role: "admin", status: "active", failedLoginCount: 0, lockedUntil: null, lastLoginAt: null, totpSecretEncrypted: null, totpEnabled: false });
    else {
      const passwordChanged = existing.passwordHash !== bootstrap.passwordHash;
      existing.passwordHash = bootstrap.passwordHash; existing.failedLoginCount = 0; existing.lockedUntil = null;
      if (passwordChanged) await this.revokeUserSessions(existing.id);
    }
    if (!this.agents.has(bootstrap.agentId)) this.agents.set(bootstrap.agentId, { id: bootstrap.agentId, name: bootstrap.agentName, tokenHash: bootstrap.agentTokenHash, status: "offline", version: null, capabilities: [], lastSeenAt: null, revokedAt: null });
  }
  async close(): Promise<void> {}
  async findUserByEmail(email: string) { return clone([...this.users.values()].find((u) => u.email === email) ?? null); }
  async getUser(id: string) { return clone(this.users.get(id) ?? null); }
  async recordLoginResult(userId: string, success: boolean, lockedUntil: string | null = null) { const user = this.users.get(userId); if (!user) return; user.failedLoginCount = success ? 0 : user.failedLoginCount + 1; user.lockedUntil = success ? null : lockedUntil; if (success) user.lastLoginAt = nowIso(); }
  async setUserTotp(userId: string, encryptedSecret: string | null, enabled: boolean) { const user = this.users.get(userId); if (!user) return; user.totpSecretEncrypted = encryptedSecret; user.totpEnabled = enabled; }
  async createSession(session: SessionRecord) { this.sessions.set(session.tokenHash, clone(session)); }
  async getSession(hash: string) { const value = this.sessions.get(hash); return value && !value.revokedAt && Date.parse(value.expiresAt) > Date.now() ? clone(value) : null; }
  async rotateSessionCsrf(id: string, hash: string) { for (const session of this.sessions.values()) if (session.id === id) session.csrfTokenHash = hash; }
  async revokeSession(id: string) { for (const session of this.sessions.values()) if (session.id === id) session.revokedAt = nowIso(); }
  async revokeUserSessions(userId: string) { for (const session of this.sessions.values()) if (session.userId === userId) session.revokedAt = nowIso(); }
  async findAgent(id: string) { return clone(this.agents.get(id) ?? null); }
  async heartbeatAgent(id: string, version: string, capabilities: string[], status: string) { const agent = this.agents.get(id); if (!agent || agent.revokedAt) return null; Object.assign(agent, { version, capabilities: [...capabilities], status, lastSeenAt: nowIso() }); return clone(agent); }
  async createCommand(input: CreateCommandInput) {
    const existing = [...this.commands.values()].find((c) => c.type === input.type && c.idempotencyKey === input.idempotencyKey);
    if (existing) return { command: clone(existing), created: false };
    const now = nowIso();
    const command: CommandInternal = { id: input.id, type: input.type, status: "queued", payload: clone(input.payload), priority: input.priority, requiredCapability: input.requiredCapability, resourceKey: input.resourceKey, currentStage: "queued", progressPercent: 0, localJobId: null, result: null, errorCode: null, errorMessage: null, retryable: false, attemptCount: 0, maxAttempts: input.maxAttempts, createdAt: now, updatedAt: now, completedAt: null, createdBy: input.createdBy, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash, assignedAgentId: null, leaseTokenHash: null, leaseExpiresAt: null, sideEffectStarted: false };
    this.commands.set(command.id, command); return { command: clone(command), created: true };
  }
  async getCommand(id: string) { return clone(this.commands.get(id) ?? null); }
  async listCommands(limit: number, status?: CommandStatus) { return [...this.commands.values()].filter((c) => !status || c.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone); }
  async claimCommand(agentId: string, capabilities: string[], leaseHash: string, leaseExpiresAt: string) {
    const activeResources = new Set([...this.commands.values()].filter((c) => ["claimed", "running"].includes(c.status) && c.leaseExpiresAt && Date.parse(c.leaseExpiresAt) > Date.now()).map((c) => c.resourceKey).filter(Boolean));
    const command = [...this.commands.values()].filter((c) => c.status === "queued" && capabilities.includes(c.requiredCapability) && (!c.resourceKey || !activeResources.has(c.resourceKey))).sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!command) return null; Object.assign(command, { status: "claimed", assignedAgentId: agentId, leaseTokenHash: leaseHash, leaseExpiresAt, attemptCount: command.attemptCount + 1, currentStage: "claimed", updatedAt: nowIso() }); return clone(command);
  }
  private owned(id: string, leaseHash: string): CommandInternal | null { const command = this.commands.get(id); return command && command.leaseTokenHash === leaseHash && command.leaseExpiresAt && Date.parse(command.leaseExpiresAt) > Date.now() ? command : null; }
  async startCommand(id: string, leaseHash: string, localJobId?: string) { const c = this.owned(id, leaseHash); if (!c || c.status !== "claimed") return null; Object.assign(c, { status: "running", currentStage: "running", localJobId: localJobId ?? c.localJobId, updatedAt: nowIso() }); return clone(c); }
  async markSideEffect(id: string, leaseHash: string) { const c = this.owned(id, leaseHash); if (!c || c.status !== "running") return false; c.sideEffectStarted = true; c.updatedAt = nowIso(); return true; }
  async heartbeatCommand(id: string, leaseHash: string, leaseExpiresAt: string, patch: UpdateInput) { const c = this.owned(id, leaseHash); if (!c || !["claimed", "running"].includes(c.status)) return null; Object.assign(c, normalizePatch(patch), { leaseExpiresAt, updatedAt: nowIso() }); return clone(c); }
  async finishCommand(id: string, leaseHash: string, status: CommandStatus, patch: UpdateInput) { const c = this.owned(id, leaseHash); if (!c || !["claimed", "running"].includes(c.status) || !isTerminal(status)) return null; const recovered = ["completed", "partial_success", "completed_unverified"].includes(status) ? { errorCode: null, errorMessage: null, retryable: false } : {}; Object.assign(c, normalizePatch(patch), recovered, { status, progressPercent: status === "completed" ? 100 : patch.progressPercent ?? c.progressPercent, completedAt: nowIso(), updatedAt: nowIso(), leaseExpiresAt: null, leaseTokenHash: null }); return clone(c); }
  async cancelCommand(id: string) { const c = this.commands.get(id); if (!c || isTerminal(c.status) || c.sideEffectStarted) return null; c.status = "cancelled"; c.completedAt = nowIso(); c.updatedAt = c.completedAt; return clone(c); }
  async retryCommand(id: string) { const c = this.commands.get(id); if (!c || !["failed", "waiting_manual_retry", "requires_attention"].includes(c.status)) return null; Object.assign(c, { status: "queued", currentStage: "queued", progressPercent: 0, errorCode: null, errorMessage: null, retryable: false, completedAt: null, assignedAgentId: null, leaseTokenHash: null, leaseExpiresAt: null, sideEffectStarted: false, updatedAt: nowIso() }); return clone(c); }
  async appendEvent(commandId: string, eventType: string, level: string, message: string, metadata: unknown = {}) { this.events.push({ id: randomUUID(), commandId, eventType, level, message, metadata: clone(metadata), createdAt: nowIso() }); }
  async listEvents(commandId: string, limit: number) { return this.events.filter((e) => e.commandId === commandId).slice(-limit).reverse().map(clone); }
  async upsertSnapshot(_agentId: string, snapshot: SnapshotRecord) { const current = this.snapshots.get(snapshot.key); const saved = { ...clone(snapshot), revision: Math.max(snapshot.revision, (current?.revision ?? 0) + 1), updatedAt: nowIso() }; this.snapshots.set(saved.key, saved); return clone(saved); }
  async getSnapshot(key: string) { return clone(this.snapshots.get(key) ?? null); }
  async listSnapshots() { return [...this.snapshots.values()].map(clone); }
  async addAudit(input: Omit<AuditRecord, "id" | "createdAt">) { this.audits.push({ ...clone(input), id: randomUUID(), createdAt: nowIso() }); }
  async listAudit(limit: number) { return this.audits.slice(-limit).reverse().map(clone); }
  async reapExpired(now: string) { let count = 0; for (const c of this.commands.values()) { if (!["claimed", "running"].includes(c.status) || !c.leaseExpiresAt || c.leaseExpiresAt > now) continue; const outcome = expiredLeaseOutcome({ type: c.type, status: c.status, sideEffectStarted: c.sideEffectStarted, attemptCount: c.attemptCount, maxAttempts: c.maxAttempts }); Object.assign(c, { status: outcome, currentStage: "lease_expired", errorCode: "agent_lease_expired", errorMessage: outcome === "requires_attention" ? "La conexion se perdio despues de iniciar una operacion externa; requiere revision." : "La lease del agente vencio.", retryable: outcome === "queued", assignedAgentId: null, leaseTokenHash: null, leaseExpiresAt: null, completedAt: isTerminal(outcome) ? nowIso() : null, updatedAt: nowIso() }); count++; } return count; }
}

function normalizePatch(patch: UpdateInput): Partial<CommandInternal> {
  const out: Partial<CommandInternal> = {};
  if (patch.currentStage !== undefined) out.currentStage = patch.currentStage;
  if (patch.progressPercent !== undefined) out.progressPercent = Math.max(0, Math.min(100, patch.progressPercent));
  if (patch.localJobId !== undefined) out.localJobId = patch.localJobId;
  if (patch.result !== undefined) out.result = clone(patch.result);
  if (patch.errorCode !== undefined) out.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) out.errorMessage = patch.errorMessage.slice(0, 2000);
  if (patch.retryable !== undefined) out.retryable = patch.retryable;
  return out;
}
