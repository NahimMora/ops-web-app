import { randomBytes } from "node:crypto";
import type { CommandRecord, CommandStatus, SnapshotInput } from "../../../packages/contracts/src/index.js";
import { agentConfig } from "./config.js";

type Claim = { command: CommandRecord; leaseToken: string; leaseSeconds: number };
export type TemporaryMediaUpload = {
  upload: {
    id: string; fileName: string; contentType: string; sizeBytes: number;
    title: string; caption: string; quality: string; textMode: string;
  };
  downloadUrl: string;
  expiresAt: string;
};
// Requests slower than this (beyond a claim's own long-poll wait) are logged
// with their duration, so Hostinger 504s/timeouts can be told apart from a
// slow-but-fine response when looking back at agent.stderr.log.
const SLOW_REQUEST_MS = 10_000;
export class OpsClient {
  // Reused across claim attempts until one actually gets an answer (200/204):
  // a server that supports it (x-ops-claim-idempotent) hands back the command
  // an earlier attempt claimed but whose response was lost. Older servers
  // ignore it and issue their own token, which the agent always uses.
  private claimToken = newLeaseToken();
  private headers() { return { Authorization: `Bearer ${agentConfig.token}`, "X-Ops-Agent-Id": agentConfig.id, "Content-Type": "application/json" }; }
  async heartbeat(localHealth: "healthy" | "degraded" | "offline", capabilities: string[], metadata: Record<string, unknown>) { return this.request("/api/agent/heartbeat", { method: "POST", body: JSON.stringify({ agentId: agentConfig.id, version: "1.0.0", capabilities, localHealth, metadata }) }); }
  async claim(capabilities: string[], waitMs: number): Promise<Claim | null> {
    // Claim is intentionally never retried: a lost response may already contain a valid lease.
    // Long-poll: the server can hold this open up to waitMs, so give the
    // request extra headroom beyond the usual fixed timeout.
    const response = await this.fetch("/api/agent/commands/claim", { method: "POST", body: JSON.stringify({ capabilities, waitMs, leaseToken: this.claimToken }) }, 1, 1, waitMs + 8_000, waitMs);
    if (response.status === 204) { this.claimToken = newLeaseToken(); return null; }
    if (!response.ok) throw await responseError(response);
    const claim = await response.json() as Claim; this.claimToken = newLeaseToken(); return claim;
  }
  async start(id: string, leaseToken: string, localJobId?: string) { return this.update(id, "start", { leaseToken, localJobId }); }
  async commandHeartbeat(id: string, leaseToken: string, currentStage: string, progressPercent: number, localJobId?: string) { return this.update(id, "heartbeat", { leaseToken, currentStage, progressPercent, localJobId }); }
  async sideEffect(id: string, leaseToken: string) { return this.update(id, "side-effect", { leaseToken }); }
  async complete(id: string, leaseToken: string, status: CommandStatus, result: unknown, localJobId?: string) { return this.update(id, "complete", { leaseToken, status, result, localJobId, progressPercent: 100, currentStage: status }); }
  async fail(id: string, leaseToken: string, status: CommandStatus, errorCode: string, errorMessage: string, retryable: boolean, localJobId?: string) { return this.update(id, "fail", { leaseToken, status, errorCode, errorMessage: errorMessage.slice(0, 2000), retryable, localJobId, currentStage: status }); }
  async snapshot(snapshot: SnapshotInput) { return this.request(`/api/agent/snapshots/${encodeURIComponent(snapshot.key)}`, { method: "PUT", body: JSON.stringify(snapshot) }); }
  async events(commandId: string, events: Array<{ eventType: string; level: string; message: string; metadata?: unknown }>) { if (!events.length) return; return this.request("/api/agent/events/batch", { method: "POST", body: JSON.stringify({ commandId, events }) }); }
  async temporaryMediaUpload(id: string): Promise<TemporaryMediaUpload> {
    return this.request(`/api/agent/media-uploads/${encodeURIComponent(id)}`, { method: "GET" }) as Promise<TemporaryMediaUpload>;
  }
  async completeTemporaryMediaUpload(id: string, received: boolean, errorMessage?: string) {
    return this.request(`/api/agent/media-uploads/${encodeURIComponent(id)}/consumed`, {
      method: "POST",
      body: JSON.stringify({ received, errorMessage }),
    });
  }
  private async update(id: string, action: string, body: unknown) { return this.request(`/api/agent/commands/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) }); }
  private async request(path: string, init: RequestInit) { const response = await this.fetch(path, init); if (!response.ok) throw await responseError(response); return response.status === 204 ? null : response.json(); }
  private async fetch(path: string, init: RequestInit, maxAttempts = 4, attempt = 1, timeoutMs = 20_000, expectedMs = 0): Promise<Response> {
    const started = Date.now(); const label = `${init.method ?? "GET"} ${path.split("?")[0]}`;
    const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    try {
      const response = await fetch(`${agentConfig.serverUrl}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 500) console.error(`[ops] ${label} -> HTTP ${response.status} in ${took()} (attempt ${attempt}/${maxAttempts})`);
      else if (Date.now() - started > expectedMs + SLOW_REQUEST_MS) console.error(`[ops] ${label} -> HTTP ${response.status} slow: ${took()}`);
      if (response.status >= 500 && attempt < maxAttempts) { await delay(500 * 2 ** attempt + Math.random() * 300); return this.fetch(path, init, maxAttempts, attempt + 1, timeoutMs, expectedMs); }
      return response;
    } catch (error) {
      console.error(`[ops] ${label} failed in ${took()} (attempt ${attempt}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < maxAttempts) { await delay(500 * 2 ** attempt + Math.random() * 300); return this.fetch(path, init, maxAttempts, attempt + 1, timeoutMs, expectedMs); }
      throw error;
    }
  }
}
async function responseError(response: Response) { const text = await response.text(); return new Error(`Ops HTTP ${response.status}: ${text.slice(0, 500)}`); }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newLeaseToken = () => randomBytes(32).toString("base64url");
