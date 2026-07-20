import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.OPS_AGENT_CONFIG_PATH || resolve(process.cwd(), ".secrets/agent.env"), override: false, quiet: true });
const backendEnv = process.env.OPS_LOCAL_BACKEND_ENV_PATH || "D:\\WebApp_HolaSalta\\backend\\.env";
dotenv.config({ path: backendEnv, override: false, quiet: true });

const optionalUrl = z.preprocess((value) => typeof value === "string" && value.trim() === "" ? undefined : value, z.string().url().optional());

const schema = z.object({
  OPS_AGENT_SERVER_URL: z.string().url(), OPS_AGENT_ID: z.string().min(1).max(100), OPS_AGENT_TOKEN: z.string().min(32),
  OPS_AGENT_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  OPS_AGENT_HEARTBEAT_MS: z.coerce.number().int().min(3000).max(60000).default(10000),
  OPS_LOCAL_API_URL: z.string().url().default("http://127.0.0.1:8000"), OPS_LOCAL_API_TOKEN: z.string().default(""),
  OPS_LOCAL_API_USERNAME: z.string().min(1).max(100).default("admin"), DASHBOARD_PASSWORD: z.string().default(""),
  OPS_R2_VIDEO_PREFIX: z.string().regex(/^[a-zA-Z0-9/_-]+$/).default("ops/videos"),
  R2_ACCESS_KEY_ID: z.string().default(""), R2_SECRET_ACCESS_KEY: z.string().default(""), R2_ACCOUNT_ID: z.string().default(""), R2_S3_ENDPOINT: optionalUrl,
  R2_BUCKET: z.string().default(""), R2_PUBLIC_BASE_URL: optionalUrl, R2_REGION: z.string().default("auto"),
});
const raw = schema.parse(process.env);
export const agentConfig = {
  serverUrl: raw.OPS_AGENT_SERVER_URL.replace(/\/$/, ""), id: raw.OPS_AGENT_ID, token: raw.OPS_AGENT_TOKEN,
  pollMs: raw.OPS_AGENT_POLL_MS, heartbeatMs: raw.OPS_AGENT_HEARTBEAT_MS,
  localApiUrl: raw.OPS_LOCAL_API_URL.replace(/\/$/, ""), localApiToken: raw.OPS_LOCAL_API_TOKEN,
  localApiUsername: raw.OPS_LOCAL_API_USERNAME, localApiPassword: raw.DASHBOARD_PASSWORD,
  r2: { accessKeyId: raw.R2_ACCESS_KEY_ID, secretAccessKey: raw.R2_SECRET_ACCESS_KEY, endpoint: raw.R2_S3_ENDPOINT || (raw.R2_ACCOUNT_ID ? `https://${raw.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined), bucket: raw.R2_BUCKET, publicBaseUrl: raw.R2_PUBLIC_BASE_URL?.replace(/\/$/, ""), region: raw.R2_REGION, prefix: raw.OPS_R2_VIDEO_PREFIX.replace(/^\/+|\/+$/g, "") },
};
export const capabilities = ["core", "scraping", "publishing", "automation", "video", "r2-video", "wordpress"];
