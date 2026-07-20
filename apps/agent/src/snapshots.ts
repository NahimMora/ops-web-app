import { createHash } from "node:crypto";
import type { SnapshotInput } from "../../../packages/contracts/src/index.js";
import type { LocalApi } from "./local-api.js";
import type { OpsClient } from "./ops-client.js";

const TEN_MINUTES = 10 * 60_000;
const sources: Array<{ key: string; path: string; timeout: number; refreshMs: number }> = [
  { key: "system.health", path: "/health", timeout: 5_000, refreshMs: 20_000 },
  { key: "automation.status", path: "/api/automation/status", timeout: 10_000, refreshMs: 20_000 },
  { key: "automation.jobs", path: "/api/automation/jobs?limit=200", timeout: 10_000, refreshMs: 20_000 },
  { key: "instagram.pending", path: "/api/automation/ig-pending", timeout: 10_000, refreshMs: 30_000 },
  { key: "news.current", path: "/api/news/", timeout: 30_000, refreshMs: 30_000 },
  { key: "xvideo.jobs", path: "/api/x-video/jobs?limit=100", timeout: 15_000, refreshMs: 30_000 },
  { key: "whatsapp.groups", path: "/api/whatsapp/groups", timeout: 15_000, refreshMs: 2 * 60_000 },
  { key: "whatsapp.group_sets", path: "/api/whatsapp/group-sets", timeout: 15_000, refreshMs: 2 * 60_000 },
  { key: "wordpress.posts", path: "/api/wordpress/posts?per_page=20", timeout: 30_000, refreshMs: TEN_MINUTES },
];
const hashes = new Map<string, string>(); let revision = 0;
const startedAt = Date.now();
const lastAttempts = new Map(sources.filter((source) => source.refreshMs >= TEN_MINUTES).map((source) => [source.key, startedAt]));

export type SnapshotProgress = (key: string, current: number, total: number) => Promise<void> | void;

export async function syncSnapshots(local: LocalApi, ops: OpsClient, only?: string[], onProgress?: SnapshotProgress, force = false): Promise<void> {
  const now = Date.now();
  const selected = sources.filter((item) => {
    if (only?.length) return only.includes(item.key);
    if (force) return true;
    return now - (lastAttempts.get(item.key) ?? 0) >= item.refreshMs;
  });
  for (const [index, source] of selected.entries()) {
    await onProgress?.(source.key, index + 1, selected.length);
    lastAttempts.set(source.key, Date.now());
    let payload: unknown;
    try { payload = await local.get(source.path, source.timeout); }
    catch (error) { payload = { unavailable: true, error: snapshotErrorCode(error) }; }
    const contentHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (hashes.get(source.key) === contentHash) continue;
    const capturedAt = new Date().toISOString(); const snapshot: SnapshotInput = { key: source.key, revision: ++revision, schemaVersion: 1, payload, contentHash, capturedAt };
    await ops.snapshot(snapshot);
    // Only suppress an unchanged snapshot after Hostinger acknowledged it.
    // A timeout or validation failure must remain retryable on the next cycle.
    hashes.set(source.key, contentHash);
  }
}

function snapshotErrorCode(error: unknown): string {
  if (typeof error === "object" && error && "status" in error) {
    const status = Number(error.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return `local_http_${status}`;
  }
  if (error instanceof Error && error.name === "TimeoutError") return "local_timeout";
  return error instanceof Error ? `local_${error.name.toLowerCase()}` : "local_unknown_error";
}
