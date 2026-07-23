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
export class OpsClient {
  private headers() { return { Authorization: `Bearer ${agentConfig.token}`, "X-Ops-Agent-Id": agentConfig.id, "Content-Type": "application/json" }; }
  async heartbeat(localHealth: "healthy" | "degraded" | "offline", capabilities: string[], metadata: Record<string, unknown>) { return this.request("/api/agent/heartbeat", { method: "POST", body: JSON.stringify({ agentId: agentConfig.id, version: "1.0.0", capabilities, localHealth, metadata }) }); }
  async claim(capabilities: string[]): Promise<Claim | null> {
    // Claim is intentionally never retried: a lost response may already contain a valid lease.
    const response = await this.fetch("/api/agent/commands/claim", { method: "POST", body: JSON.stringify({ capabilities }) }, 1);
    if (response.status === 204) return null; if (!response.ok) throw await responseError(response); return response.json() as Promise<Claim>;
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
  private async fetch(path: string, init: RequestInit, maxAttempts = 4, attempt = 1): Promise<Response> {
    try { const response = await fetch(`${agentConfig.serverUrl}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) }); if (response.status >= 500 && attempt < maxAttempts) { await delay(500 * 2 ** attempt + Math.random() * 300); return this.fetch(path, init, maxAttempts, attempt + 1); } return response; }
    catch (error) { if (attempt < maxAttempts) { await delay(500 * 2 ** attempt + Math.random() * 300); return this.fetch(path, init, maxAttempts, attempt + 1); } throw error; }
  }
}
async function responseError(response: Response) { const text = await response.text(); return new Error(`Ops HTTP ${response.status}: ${text.slice(0, 500)}`); }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
