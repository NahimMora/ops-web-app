import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// Same config file as the agent (.secrets/agent.env, gitignored) - the
// OPS_ALERT_* values (Gmail sender + app password) live there next to the
// agent token and are never committed.
dotenv.config({ path: process.env.OPS_AGENT_CONFIG_PATH || resolve(process.cwd(), ".secrets/agent.env"), override: false, quiet: true });

const schema = z.object({
  OPS_AGENT_SERVER_URL: z.string().url(),
  OPS_LOCAL_API_URL: z.string().url().default("http://127.0.0.1:8000"),
  OPS_LOCAL_BACKEND_ENV_PATH: z.string().min(1),
  OPS_AGENT_STATE_DIR: z.string().default(""),
  OPS_ALERT_SMTP_HOST: z.string().default("smtp.gmail.com"),
  OPS_ALERT_SMTP_PORT: z.coerce.number().int().default(465),
  OPS_ALERT_SMTP_USER: z.string().default(""),
  // Gmail shows app passwords in groups of four ("abcd efgh ..."); both forms work.
  OPS_ALERT_SMTP_PASSWORD: z.string().default("").transform((v) => v.replace(/\s+/g, "")),
  OPS_ALERT_EMAIL_TO: z.string().default(""),
  OPS_HEALTH_REPORT_INTERVAL_HOURS: z.coerce.number().positive().default(72),
});
const raw = schema.parse(process.env);
const opsRoot = process.cwd();

export const monitorConfig = {
  serverUrl: raw.OPS_AGENT_SERVER_URL.replace(/\/$/, ""),
  localApiUrl: raw.OPS_LOCAL_API_URL.replace(/\/$/, ""),
  backendDataDir: resolve(dirname(raw.OPS_LOCAL_BACKEND_ENV_PATH), "data"),
  stateDir: raw.OPS_AGENT_STATE_DIR || resolve(opsRoot, "agent-state"),
  agentEntry: resolve(opsRoot, "dist", "agent", "main.js"),
  opsRoot,
  reportIntervalHours: raw.OPS_HEALTH_REPORT_INTERVAL_HOURS,
  smtp: {
    host: raw.OPS_ALERT_SMTP_HOST, port: raw.OPS_ALERT_SMTP_PORT,
    user: raw.OPS_ALERT_SMTP_USER, password: raw.OPS_ALERT_SMTP_PASSWORD,
    to: raw.OPS_ALERT_EMAIL_TO || raw.OPS_ALERT_SMTP_USER,
  },
};
export const mailConfigured = () => Boolean(monitorConfig.smtp.user && monitorConfig.smtp.password && monitorConfig.smtp.to);
