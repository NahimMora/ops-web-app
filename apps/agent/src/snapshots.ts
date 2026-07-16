import { createHash } from "node:crypto";
import type { SnapshotRecord } from "../../../packages/contracts/src/index.js";
import { LocalApi } from "./local-api.js";
import { OpsClient } from "./ops-client.js";

const sources: Array<{ key: string; path: string; timeout?: number }> = [
  { key: "system.health", path: "/health" }, { key: "automation.status", path: "/api/automation/status" },
  { key: "automation.jobs", path: "/api/automation/jobs?limit=200" }, { key: "instagram.pending", path: "/api/automation/ig-pending" },
  { key: "news.current", path: "/api/news/", timeout: 120_000 }, { key: "xvideo.jobs", path: "/api/x-video/jobs?limit=100" },
  { key: "whatsapp.groups", path: "/api/whatsapp/groups" }, { key: "whatsapp.group_sets", path: "/api/whatsapp/group-sets" },
  { key: "wix.unpinned", path: "/api/wix/unpinned-posts", timeout: 120_000 }, { key: "wordpress.posts", path: "/api/wordpress/posts?per_page=50", timeout: 120_000 },
];
const hashes = new Map<string, string>(); let revision = 0;

export async function syncSnapshots(local: LocalApi, ops: OpsClient, only?: string[]): Promise<void> {
  for (const source of sources.filter((item) => !only?.length || only.includes(item.key))) {
    let payload: unknown;
    try { payload = await local.get(source.path, source.timeout); }
    catch (error) { payload = { unavailable: true, error: error instanceof Error ? error.message.slice(0, 500) : "unknown_error" }; }
    const contentHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (hashes.get(source.key) === contentHash) continue; hashes.set(source.key, contentHash);
    const capturedAt = new Date().toISOString(); const snapshot: SnapshotRecord = { key: source.key, revision: ++revision, schemaVersion: 1, payload, contentHash, capturedAt, updatedAt: capturedAt };
    await ops.snapshot(snapshot);
  }
}
