import { randomUUID } from "node:crypto";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { CommandStatus, CommandType, SnapshotRecord } from "../../../packages/contracts/src/index.js";
import { expiredLeaseOutcome, isTerminal } from "./command-state.js";
import { runMigrations } from "./migrations.js";
import type { AgentRecord, AuditRecord, BootstrapInput, CommandEvent, CommandInternal, CreateCommandInput, Repository, SessionRecord, TemporaryMediaUploadRecord, UpdateInput, UserRecord } from "./repository.js";

type DbConfig = { host: string; port: number; user: string; password: string; database: string };
type DbRow = RowDataPacket & Record<string, any>;
const jsonParse = <T>(value: unknown, fallback: T): T => { try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const iso = (value: unknown): string | null => value ? new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")).toISOString() : null;

export class MySqlRepository implements Repository {
  readonly pool: Pool;
  constructor(db: DbConfig, private readonly autoMigrate = true) {
    this.pool = mysql.createPool({ ...db, connectTimeout: 5_000, connectionLimit: 8, waitForConnections: true, queueLimit: 50, enableKeepAlive: true, timezone: "Z", dateStrings: true, charset: "utf8mb4" });
  }
  async initialize(bootstrap: BootstrapInput): Promise<void> {
    if (this.autoMigrate) await runMigrations(this.pool);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.query<DbRow[]>("SELECT id,password_hash FROM users WHERE email=? LIMIT 1 FOR UPDATE", [bootstrap.adminEmail]);
      const existing = users[0];
      const passwordChanged = Boolean(existing && String(existing.password_hash) !== bootstrap.passwordHash);
      const userId = existing ? String(existing.id) : randomUUID();
      await connection.query(
        `INSERT INTO users (id,email,display_name,password_hash,role,status) VALUES (?,?,?,?, 'admin','active')
         ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),
         failed_login_count=0,
         locked_until=NULL,
         password_hash=VALUES(password_hash)`,
        [userId, bootstrap.adminEmail, "Administrador", bootstrap.passwordHash],
      );
      if (passwordChanged) await connection.query("DELETE FROM sessions WHERE user_id=?", [userId]);
      await connection.query(
        `INSERT INTO agents (id,name,token_hash,status,capabilities_json) VALUES (?,?,?,'offline','[]')
         ON DUPLICATE KEY UPDATE name=VALUES(name), token_hash=IF(token_hash='',VALUES(token_hash),token_hash)`,
        [bootstrap.agentId, bootstrap.agentName, bootstrap.agentTokenHash],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  async close() { await this.pool.end(); }

  async findUserByEmail(email: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM users WHERE email=? LIMIT 1", [email]); return rows[0] ? mapUser(rows[0]) : null; }
  async getUser(id: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM users WHERE id=? LIMIT 1", [id]); return rows[0] ? mapUser(rows[0]) : null; }
  async recordLoginResult(userId: string, success: boolean, lockedUntil: string | null = null) {
    if (success) await this.pool.query("UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=UTC_TIMESTAMP(3) WHERE id=?", [userId]);
    else await this.pool.query("UPDATE users SET failed_login_count=failed_login_count+1,locked_until=? WHERE id=?", [toDbDate(lockedUntil), userId]);
  }
  async setUserTotp(userId: string, encryptedSecret: string | null, enabled: boolean) { await this.pool.query("UPDATE users SET totp_secret_encrypted=?,totp_enabled=? WHERE id=?", [encryptedSecret, enabled ? 1 : 0, userId]); }
  async createSession(s: SessionRecord) { await this.pool.query("INSERT INTO sessions (id,user_id,token_hash,csrf_token_hash,expires_at,revoked_at) VALUES (?,?,?,?,?,?)", [s.id, s.userId, s.tokenHash, s.csrfTokenHash, toDbDate(s.expiresAt), toDbDate(s.revokedAt)]); }
  async getSession(hash: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) LIMIT 1", [hash]); return rows[0] ? mapSession(rows[0]) : null; }
  async rotateSessionCsrf(id: string, hash: string) { await this.pool.query("UPDATE sessions SET csrf_token_hash=?,last_seen_at=UTC_TIMESTAMP(3) WHERE id=? AND revoked_at IS NULL", [hash, id]); }
  async revokeSession(id: string) { await this.pool.query("UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?", [id]); }
  async revokeUserSessions(userId: string) { await this.pool.query("UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=? AND revoked_at IS NULL", [userId]); }

  async findAgent(id: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM agents WHERE id=? LIMIT 1", [id]); return rows[0] ? mapAgent(rows[0]) : null; }
  async heartbeatAgent(id: string, version: string, capabilities: string[], status: string) {
    await this.pool.query("UPDATE agents SET version=?,capabilities_json=?,status=?,last_seen_at=UTC_TIMESTAMP(3) WHERE id=? AND revoked_at IS NULL", [version, JSON.stringify(capabilities), status, id]);
    return this.findAgent(id);
  }

  async createCommand(input: CreateCommandInput) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.query<DbRow[]>("SELECT * FROM commands WHERE type=? AND idempotency_key=? LIMIT 1 FOR UPDATE", [input.type, input.idempotencyKey]);
      if (existing[0]) { await connection.commit(); return { command: mapCommand(existing[0]), created: false }; }
      await connection.query(
        `INSERT INTO commands (id,type,payload_json,payload_hash,idempotency_key,status,priority,required_capability,resource_key,created_by,max_attempts,current_stage)
         VALUES (?,?,?,?,?,'queued',?,?,?,?,?,'queued')`,
        [input.id, input.type, JSON.stringify(input.payload), input.payloadHash, input.idempotencyKey, input.priority, input.requiredCapability, input.resourceKey, input.createdBy, input.maxAttempts],
      );
      const [rows] = await connection.query<DbRow[]>("SELECT * FROM commands WHERE id=?", [input.id]);
      await connection.commit(); return { command: mapCommand(rows[0]!), created: true };
    } catch (error: any) {
      await connection.rollback();
      if (error?.code === "ER_DUP_ENTRY") { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM commands WHERE type=? AND idempotency_key=? LIMIT 1", [input.type, input.idempotencyKey]); if (rows[0]) return { command: mapCommand(rows[0]), created: false }; }
      throw error;
    } finally { connection.release(); }
  }
  async getCommand(id: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM commands WHERE id=? LIMIT 1", [id]); return rows[0] ? mapCommand(rows[0]) : null; }
  async listCommands(limit: number, status?: CommandStatus) {
    const [rows] = status
      ? await this.pool.query<DbRow[]>("SELECT * FROM commands WHERE status=? ORDER BY created_at DESC LIMIT ?", [status, limit])
      : await this.pool.query<DbRow[]>("SELECT * FROM commands ORDER BY created_at DESC LIMIT ?", [limit]);
    return rows.map(mapCommand);
  }
  async claimCommand(agentId: string, capabilities: string[], leaseHash: string, leaseExpiresAt: string) {
    if (!capabilities.length) return null;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM resource_locks WHERE lease_expires_at<=UTC_TIMESTAMP(3)");
      const placeholders = capabilities.map(() => "?").join(",");
      const [rows] = await connection.query<DbRow[]>(
        `SELECT c.* FROM commands c
         WHERE c.status='queued' AND c.required_capability IN (${placeholders})
         AND (c.resource_key IS NULL OR NOT EXISTS (SELECT 1 FROM resource_locks r WHERE r.resource_key=c.resource_key AND r.lease_expires_at>UTC_TIMESTAMP(3)))
         ORDER BY c.priority DESC,c.created_at ASC LIMIT 1 FOR UPDATE`, capabilities,
      );
      const row = rows[0]; if (!row) { await connection.commit(); return null; }
      await connection.query(
        "UPDATE commands SET status='claimed',assigned_agent_id=?,lease_token_hash=?,lease_expires_at=?,attempt_count=attempt_count+1,current_stage='claimed',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='queued'",
        [agentId, leaseHash, toDbDate(leaseExpiresAt), row.id],
      );
      if (row.resource_key) await connection.query(
        "INSERT INTO resource_locks (resource_key,command_id,agent_id,fencing_token,lease_expires_at) VALUES (?,?,?,?,?)",
        [row.resource_key, row.id, agentId, Date.now(), toDbDate(leaseExpiresAt)],
      );
      const [claimed] = await connection.query<DbRow[]>("SELECT * FROM commands WHERE id=?", [row.id]);
      await connection.commit(); return mapCommand(claimed[0]!);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async startCommand(id: string, leaseHash: string, localJobId?: string) {
    await this.pool.query("UPDATE commands SET status='running',current_stage='running',local_job_id=COALESCE(?,local_job_id),updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='claimed' AND lease_token_hash=? AND lease_expires_at>UTC_TIMESTAMP(3)", [localJobId ?? null, id, leaseHash]);
    return this.getOwned(id, leaseHash);
  }
  async markSideEffect(id: string, leaseHash: string) { const [result] = await this.pool.query<any>("UPDATE commands SET side_effect_started=1,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='running' AND lease_token_hash=? AND lease_expires_at>UTC_TIMESTAMP(3)", [id, leaseHash]); return result.affectedRows === 1; }
  async heartbeatCommand(id: string, leaseHash: string, leaseExpiresAt: string, patch: UpdateInput) {
    const values = patchValues(patch); values.assignments.push("lease_expires_at=?", "updated_at=UTC_TIMESTAMP(3)"); values.params.push(toDbDate(leaseExpiresAt), id, leaseHash);
    const [result] = await this.pool.query<any>(`UPDATE commands SET ${values.assignments.join(",")} WHERE id=? AND status IN ('claimed','running') AND lease_token_hash=? AND lease_expires_at>UTC_TIMESTAMP(3)`, values.params);
    if (result.affectedRows !== 1) return null;
    await this.pool.query("UPDATE resource_locks SET lease_expires_at=?,updated_at=UTC_TIMESTAMP(3) WHERE command_id=?", [toDbDate(leaseExpiresAt), id]);
    return this.getOwned(id, leaseHash);
  }
  async finishCommand(id: string, leaseHash: string, status: CommandStatus, patch: UpdateInput) {
    if (!isTerminal(status)) return null;
    const values = patchValues(patch);
    if (["completed", "partial_success", "completed_unverified"].includes(status)) {
      values.assignments.push("error_code=NULL", "error_message=NULL", "retryable=0");
    }
    values.assignments.push("status=?", "completed_at=UTC_TIMESTAMP(3)", "lease_expires_at=NULL", "lease_token_hash=NULL", "updated_at=UTC_TIMESTAMP(3)"); values.params.push(status, id, leaseHash);
    const [result] = await this.pool.query<any>(`UPDATE commands SET ${values.assignments.join(",")} WHERE id=? AND status IN ('claimed','running') AND lease_token_hash=? AND lease_expires_at>UTC_TIMESTAMP(3)`, values.params);
    if (result.affectedRows !== 1) return null;
    await this.pool.query("DELETE FROM resource_locks WHERE command_id=?", [id]); return this.getCommand(id);
  }
  async cancelCommand(id: string) {
    const [result] = await this.pool.query<any>("UPDATE commands SET status='cancelled',completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status IN ('queued','claimed') AND side_effect_started=0", [id]);
    if (result.affectedRows !== 1) return null; await this.pool.query("DELETE FROM resource_locks WHERE command_id=?", [id]); return this.getCommand(id);
  }
  async retryCommand(id: string) {
    const [result] = await this.pool.query<any>(
      `UPDATE commands SET status='queued',current_stage='queued',progress_percent=0,error_code=NULL,error_message=NULL,retryable=0,completed_at=NULL,
       assigned_agent_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,side_effect_started=0,updated_at=UTC_TIMESTAMP(3)
       WHERE id=? AND status IN ('failed','waiting_manual_retry','requires_attention')`, [id],
    );
    if (result.affectedRows !== 1) return null; await this.pool.query("DELETE FROM resource_locks WHERE command_id=?", [id]); return this.getCommand(id);
  }
  async appendEvent(commandId: string, eventType: string, level: string, message: string, metadata: unknown = {}) { await this.pool.query("INSERT INTO command_events (id,command_id,event_type,level,message,metadata_json) VALUES (?,?,?,?,?,?)", [randomUUID(), commandId, eventType, level, message.slice(0, 2000), JSON.stringify(metadata)]); }
  async listEvents(commandId: string, limit: number) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM command_events WHERE command_id=? ORDER BY created_at DESC LIMIT ?", [commandId, limit]); return rows.map(mapEvent); }
  async upsertSnapshot(agentId: string, s: SnapshotRecord) {
    await this.pool.query(
      `INSERT INTO snapshots (snapshot_key,agent_id,revision,schema_version,payload_json,content_hash,captured_at) VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE agent_id=VALUES(agent_id),revision=GREATEST(revision+1,VALUES(revision)),schema_version=VALUES(schema_version),payload_json=VALUES(payload_json),content_hash=VALUES(content_hash),captured_at=VALUES(captured_at)`,
      [s.key, agentId, s.revision, s.schemaVersion, JSON.stringify(s.payload), s.contentHash, toDbDate(s.capturedAt)],
    );
    return (await this.getSnapshot(s.key))!;
  }
  async getSnapshot(key: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM snapshots WHERE snapshot_key=? LIMIT 1", [key]); return rows[0] ? mapSnapshot(rows[0]) : null; }
  async listSnapshots() { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM snapshots ORDER BY snapshot_key", []); return rows.map(mapSnapshot); }
  async addAudit(a: Omit<AuditRecord, "id" | "createdAt">) { await this.pool.query("INSERT INTO audit_log (id,actor_type,actor_id,action,target_type,target_id,result,metadata_json) VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), a.actorType, a.actorId, a.action, a.targetType, a.targetId, a.result, JSON.stringify(a.metadata)]); }
  async listAudit(limit: number) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?", [limit]); return rows.map(mapAudit); }
  async createTemporaryMediaUpload(input: Omit<TemporaryMediaUploadRecord, "createdAt" | "updatedAt" | "consumedAt">) {
    await this.pool.query(
      `INSERT INTO temporary_media_uploads
       (id,created_by,object_key,file_name,content_type,expected_size_bytes,actual_size_bytes,etag,status,title,caption,quality,text_mode,command_id,error_message,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.id, input.createdBy, input.objectKey, input.fileName, input.contentType,
        input.expectedSizeBytes, input.actualSizeBytes, input.etag, input.status,
        input.title, input.caption, input.quality, input.textMode, input.commandId,
        input.errorMessage, toDbDate(input.expiresAt),
      ],
    );
    return (await this.getTemporaryMediaUpload(input.id))!;
  }
  async getTemporaryMediaUpload(id: string) {
    const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM temporary_media_uploads WHERE id=? LIMIT 1", [id]);
    return rows[0] ? mapTemporaryMediaUpload(rows[0]) : null;
  }
  async updateTemporaryMediaUpload(id: string, patch: Partial<Pick<TemporaryMediaUploadRecord, "actualSizeBytes" | "etag" | "status" | "commandId" | "errorMessage" | "consumedAt">>) {
    const columns: Record<string, string> = {
      actualSizeBytes: "actual_size_bytes",
      etag: "etag",
      status: "status",
      commandId: "command_id",
      errorMessage: "error_message",
      consumedAt: "consumed_at",
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, field)) continue;
      assignments.push(`${column}=?`);
      const value = patch[field as keyof typeof patch];
      values.push(field === "consumedAt" ? toDbDate(value as string | null | undefined) : value ?? null);
    }
    if (!assignments.length) return this.getTemporaryMediaUpload(id);
    values.push(id);
    await this.pool.query(
      `UPDATE temporary_media_uploads SET ${assignments.join(",")},updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
      values,
    );
    return this.getTemporaryMediaUpload(id);
  }
  async reapExpired(now: string) {
    const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM commands WHERE status IN ('claimed','running') AND lease_expires_at<=?", [toDbDate(now)]); let count = 0;
    for (const row of rows) {
      const c = mapCommand(row); const outcome = expiredLeaseOutcome({ type: c.type, status: c.status, sideEffectStarted: c.sideEffectStarted, attemptCount: c.attemptCount, maxAttempts: c.maxAttempts });
      await this.pool.query(
        `UPDATE commands SET status=?,current_stage='lease_expired',error_code='agent_lease_expired',error_message=?,retryable=?,assigned_agent_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,completed_at=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND lease_expires_at<=?`,
        [outcome, outcome === "requires_attention" ? "La conexion se perdio despues de iniciar una operacion externa; requiere revision." : "La lease del agente vencio.", outcome === "queued" ? 1 : 0, isTerminal(outcome) ? toDbDate(new Date().toISOString()) : null, c.id, toDbDate(now)],
      );
      await this.pool.query("DELETE FROM resource_locks WHERE command_id=?", [c.id]); count++;
    }
    await this.pool.query("DELETE FROM resource_locks WHERE lease_expires_at<=?", [toDbDate(now)]);
    await this.pool.query(
      "UPDATE temporary_media_uploads SET status='expired',error_message='La carga expiró antes de finalizarse.' WHERE status='created' AND expires_at<=?",
      [toDbDate(now)],
    );
    return count;
  }
  private async getOwned(id: string, hash: string) { const [rows] = await this.pool.query<DbRow[]>("SELECT * FROM commands WHERE id=? AND lease_token_hash=? AND lease_expires_at>UTC_TIMESTAMP(3) AND status IN ('claimed','running') LIMIT 1", [id, hash]); return rows[0] ? mapCommand(rows[0]) : null; }
}

function toDbDate(value: string | null | undefined): string | null { return value ? new Date(value).toISOString().slice(0, 23).replace("T", " ") : null; }
function mapUser(r: DbRow): UserRecord { return { id: String(r.id), email: String(r.email), displayName: String(r.display_name), passwordHash: String(r.password_hash), role: r.role, status: r.status, failedLoginCount: Number(r.failed_login_count), lockedUntil: iso(r.locked_until), lastLoginAt: iso(r.last_login_at), totpSecretEncrypted: r.totp_secret_encrypted ? String(r.totp_secret_encrypted) : null, totpEnabled: Boolean(r.totp_enabled) }; }
function mapSession(r: DbRow): SessionRecord { return { id: String(r.id), userId: String(r.user_id), tokenHash: String(r.token_hash), csrfTokenHash: String(r.csrf_token_hash), expiresAt: iso(r.expires_at)!, revokedAt: iso(r.revoked_at) }; }
function mapAgent(r: DbRow): AgentRecord { return { id: String(r.id), name: String(r.name), tokenHash: String(r.token_hash), status: String(r.status), version: r.version ? String(r.version) : null, capabilities: jsonParse(r.capabilities_json, []), lastSeenAt: iso(r.last_seen_at), revokedAt: iso(r.revoked_at) }; }
function mapCommand(r: DbRow): CommandInternal { return { id: String(r.id), type: r.type as CommandType, status: r.status as CommandStatus, payload: jsonParse(r.payload_json, {}), priority: Number(r.priority), requiredCapability: String(r.required_capability), resourceKey: r.resource_key ? String(r.resource_key) : null, currentStage: r.current_stage ? String(r.current_stage) : null, progressPercent: Number(r.progress_percent), localJobId: r.local_job_id ? String(r.local_job_id) : null, result: jsonParse(r.result_json, null), errorCode: r.error_code ? String(r.error_code) : null, errorMessage: r.error_message ? String(r.error_message) : null, retryable: Boolean(r.retryable), attemptCount: Number(r.attempt_count), maxAttempts: Number(r.max_attempts), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, completedAt: iso(r.completed_at), createdBy: String(r.created_by), idempotencyKey: String(r.idempotency_key), payloadHash: String(r.payload_hash), assignedAgentId: r.assigned_agent_id ? String(r.assigned_agent_id) : null, leaseTokenHash: r.lease_token_hash ? String(r.lease_token_hash) : null, leaseExpiresAt: iso(r.lease_expires_at), sideEffectStarted: Boolean(r.side_effect_started) }; }
function mapEvent(r: DbRow): CommandEvent { return { id: String(r.id), commandId: String(r.command_id), eventType: String(r.event_type), level: String(r.level), message: String(r.message), metadata: jsonParse(r.metadata_json, {}), createdAt: iso(r.created_at)! }; }
function mapSnapshot(r: DbRow): SnapshotRecord { return { key: String(r.snapshot_key), revision: Number(r.revision), schemaVersion: Number(r.schema_version), payload: jsonParse(r.payload_json, {}), contentHash: String(r.content_hash), capturedAt: iso(r.captured_at)!, updatedAt: iso(r.updated_at)! }; }
function mapAudit(r: DbRow): AuditRecord { return { id: String(r.id), actorType: String(r.actor_type), actorId: r.actor_id ? String(r.actor_id) : null, action: String(r.action), targetType: r.target_type ? String(r.target_type) : null, targetId: r.target_id ? String(r.target_id) : null, result: String(r.result), metadata: jsonParse(r.metadata_json, {}), createdAt: iso(r.created_at)! }; }
function mapTemporaryMediaUpload(r: DbRow): TemporaryMediaUploadRecord {
  return {
    id: String(r.id),
    createdBy: String(r.created_by),
    objectKey: String(r.object_key),
    fileName: String(r.file_name),
    contentType: String(r.content_type),
    expectedSizeBytes: Number(r.expected_size_bytes),
    actualSizeBytes: r.actual_size_bytes == null ? null : Number(r.actual_size_bytes),
    etag: r.etag ? String(r.etag) : null,
    status: r.status,
    title: String(r.title ?? ""),
    caption: String(r.caption ?? ""),
    quality: String(r.quality),
    textMode: String(r.text_mode),
    commandId: r.command_id ? String(r.command_id) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    expiresAt: iso(r.expires_at)!,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    consumedAt: iso(r.consumed_at),
  };
}
function patchValues(p: UpdateInput) { const assignments: string[] = []; const params: unknown[] = []; const add = (sql: string, value: unknown) => { assignments.push(sql); params.push(value); }; if (p.currentStage !== undefined) add("current_stage=?", p.currentStage); if (p.progressPercent !== undefined) add("progress_percent=?", Math.max(0, Math.min(100, p.progressPercent))); if (p.localJobId !== undefined) add("local_job_id=?", p.localJobId); if (p.result !== undefined) add("result_json=?", JSON.stringify(p.result)); if (p.errorCode !== undefined) add("error_code=?", p.errorCode); if (p.errorMessage !== undefined) add("error_message=?", p.errorMessage.slice(0, 2000)); if (p.retryable !== undefined) add("retryable=?", p.retryable ? 1 : 0); return { assignments, params }; }
