import type { Pool, PoolConnection } from "mysql2/promise";

const migrations: Array<{ version: number; name: string; statements: string[] }> = [{
  version: 1,
  name: "initial_ops_schema",
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      display_name VARCHAR(200) NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      totp_secret_encrypted TEXT NULL,
      totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
      role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
      status ENUM('active','disabled') NOT NULL DEFAULT 'active',
      failed_login_count INT NOT NULL DEFAULT 0,
      locked_until DATETIME(3) NULL,
      last_login_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      csrf_token_hash CHAR(64) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      revoked_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_sessions_user (user_id), INDEX idx_sessions_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'offline',
      version VARCHAR(50) NULL,
      capabilities_json TEXT NOT NULL,
      last_seen_at DATETIME(3) NULL,
      revoked_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS commands (
      id CHAR(36) PRIMARY KEY,
      type VARCHAR(100) NOT NULL,
      schema_version INT NOT NULL DEFAULT 1,
      payload_json MEDIUMTEXT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      idempotency_key VARCHAR(190) NOT NULL,
      status VARCHAR(40) NOT NULL,
      priority INT NOT NULL DEFAULT 0,
      required_capability VARCHAR(100) NOT NULL,
      resource_key VARCHAR(255) NULL,
      created_by CHAR(36) NOT NULL,
      assigned_agent_id VARCHAR(100) NULL,
      lease_token_hash CHAR(64) NULL,
      lease_expires_at DATETIME(3) NULL,
      side_effect_started TINYINT(1) NOT NULL DEFAULT 0,
      attempt_count INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      local_job_id VARCHAR(200) NULL,
      current_stage VARCHAR(100) NULL,
      progress_percent INT NOT NULL DEFAULT 0,
      result_json MEDIUMTEXT NULL,
      error_code VARCHAR(100) NULL,
      error_message TEXT NULL,
      retryable TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      UNIQUE KEY uq_command_idempotency (type, idempotency_key),
      INDEX idx_commands_queue (status, priority, created_at),
      INDEX idx_commands_agent (assigned_agent_id, status),
      INDEX idx_commands_resource (resource_key, status),
      CONSTRAINT fk_commands_user FOREIGN KEY (created_by) REFERENCES users(id),
      CONSTRAINT fk_commands_agent FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS command_events (
      id CHAR(36) PRIMARY KEY,
      command_id CHAR(36) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      level VARCHAR(20) NOT NULL,
      message VARCHAR(2000) NOT NULL,
      metadata_json TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_events_command FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE,
      INDEX idx_events_command (command_id, created_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS resource_locks (
      resource_key VARCHAR(255) PRIMARY KEY,
      command_id CHAR(36) NOT NULL,
      agent_id VARCHAR(100) NOT NULL,
      fencing_token BIGINT UNSIGNED NOT NULL,
      lease_expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_locks_command FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE,
      CONSTRAINT fk_locks_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      INDEX idx_locks_expiry (lease_expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_key VARCHAR(190) PRIMARY KEY,
      agent_id VARCHAR(100) NOT NULL,
      revision BIGINT UNSIGNED NOT NULL,
      schema_version INT NOT NULL DEFAULT 1,
      payload_json MEDIUMTEXT NOT NULL,
      content_hash CHAR(64) NOT NULL,
      captured_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_snapshots_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id CHAR(36) PRIMARY KEY,
      actor_type VARCHAR(30) NOT NULL,
      actor_id VARCHAR(100) NULL,
      action VARCHAR(150) NOT NULL,
      target_type VARCHAR(100) NULL,
      target_id VARCHAR(190) NULL,
      result VARCHAR(40) NOT NULL,
      metadata_json TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_audit_created (created_at), INDEX idx_audit_actor (actor_type, actor_id)
    ) ENGINE=InnoDB`,
  ],
}, {
  version: 2,
  name: "temporary_media_uploads",
  statements: [
    `CREATE TABLE IF NOT EXISTS temporary_media_uploads (
      id CHAR(36) PRIMARY KEY,
      created_by CHAR(36) NOT NULL,
      object_key VARCHAR(500) NOT NULL UNIQUE,
      file_name VARCHAR(200) NOT NULL,
      content_type VARCHAR(100) NOT NULL,
      expected_size_bytes BIGINT UNSIGNED NOT NULL,
      actual_size_bytes BIGINT UNSIGNED NULL,
      etag VARCHAR(190) NULL,
      status VARCHAR(40) NOT NULL,
      title VARCHAR(180) NOT NULL DEFAULT '',
      caption TEXT NOT NULL,
      quality VARCHAR(20) NOT NULL,
      text_mode VARCHAR(20) NOT NULL,
      command_id CHAR(36) NULL,
      error_message TEXT NULL,
      expires_at DATETIME(3) NOT NULL,
      consumed_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_temp_upload_status_expiry (status, expires_at),
      INDEX idx_temp_upload_user (created_by, created_at),
      CONSTRAINT fk_temp_upload_user FOREIGN KEY (created_by) REFERENCES users(id),
      CONSTRAINT fk_temp_upload_command FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
  ],
}];

export async function runMigrations(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('holasalta_ops_migrations', 5) AS acquired");
    if (!(lockRows as Array<{ acquired: number }>)[0]?.acquired) throw new Error("Could not acquire migration lock");
    await connection.query(migrations[0]!.statements[0]!);
    const [rows] = await connection.query("SELECT version FROM schema_migrations");
    const applied = new Set((rows as Array<{ version: number }>).map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await applyMigration(connection, migration);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('holasalta_ops_migrations')").catch(() => undefined);
    connection.release();
  }
}

async function applyMigration(connection: PoolConnection, migration: typeof migrations[number]): Promise<void> {
  await connection.beginTransaction();
  try {
    for (const statement of migration.statements) await connection.query(statement);
    await connection.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [migration.version, migration.name]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
