import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OPS_APP_URL: z.string().url().default("http://localhost:3000"),
  OPS_STORAGE_DRIVER: z.enum(["memory", "mysql"]).default("memory"),
  OPS_DB_AUTO_MIGRATE: z.string().default("true"),
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default(""),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default(""),
  OPS_SESSION_SECRET: z.string().default("development-session-secret-change-me"),
  OPS_TOTP_ENCRYPTION_KEY: z.string().default("development-totp-key-change-me"),
  OPS_TOKEN_PEPPER: z.string().default("development-token-pepper-change-me"),
  OPS_BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("holasalta@acceso.com"),
  OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH: z.string().default(""),
  OPS_BOOTSTRAP_AGENT_ID: z.string().min(1).max(100).default("pc-holasalta-01"),
  OPS_BOOTSTRAP_AGENT_NAME: z.string().min(1).max(200).default("PC HolaSalta"),
  OPS_BOOTSTRAP_AGENT_TOKEN_HASH: z.string().default(""),
  OPS_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  OPS_COMMAND_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  OPS_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const raw = envSchema.parse(process.env);
if (raw.NODE_ENV === "production") {
  if (raw.OPS_STORAGE_DRIVER !== "mysql") throw new Error("Production requires OPS_STORAGE_DRIVER=mysql");
  const missing = ["DB_USER", "DB_PASSWORD", "DB_NAME", "OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH", "OPS_BOOTSTRAP_AGENT_TOKEN_HASH"]
    .filter((key) => !raw[key as keyof typeof raw]);
  if (missing.length) throw new Error(`Missing production variables: ${missing.join(", ")}`);
  for (const [name, value] of [["OPS_SESSION_SECRET", raw.OPS_SESSION_SECRET], ["OPS_TOKEN_PEPPER", raw.OPS_TOKEN_PEPPER], ["OPS_TOTP_ENCRYPTION_KEY", raw.OPS_TOTP_ENCRYPTION_KEY]] as const) {
    if (value.length < 32 || value.includes("development-")) throw new Error(`${name} must be a production secret of at least 32 characters`);
  }
}

export const config = {
  nodeEnv: raw.NODE_ENV,
  port: raw.PORT,
  appUrl: raw.OPS_APP_URL.replace(/\/$/, ""),
  storageDriver: raw.OPS_STORAGE_DRIVER,
  autoMigrate: raw.OPS_DB_AUTO_MIGRATE.toLowerCase() !== "false",
  db: { host: raw.DB_HOST, port: raw.DB_PORT, user: raw.DB_USER, password: raw.DB_PASSWORD, database: raw.DB_NAME },
  sessionSecret: raw.OPS_SESSION_SECRET,
  totpEncryptionKey: raw.OPS_TOTP_ENCRYPTION_KEY,
  tokenPepper: raw.OPS_TOKEN_PEPPER,
  bootstrap: {
    adminEmail: raw.OPS_BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), passwordHash: raw.OPS_BOOTSTRAP_ADMIN_PASSWORD_HASH,
    agentId: raw.OPS_BOOTSTRAP_AGENT_ID, agentName: raw.OPS_BOOTSTRAP_AGENT_NAME, agentTokenHash: raw.OPS_BOOTSTRAP_AGENT_TOKEN_HASH,
  },
  sessionTtlMs: raw.OPS_SESSION_TTL_HOURS * 60 * 60 * 1000,
  commandRetentionDays: raw.OPS_COMMAND_RETENTION_DAYS,
  logLevel: raw.OPS_LOG_LEVEL,
};
