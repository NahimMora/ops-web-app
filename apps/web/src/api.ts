import type { CommandRecord, CommandType } from "../../../packages/contracts/src/index";

let csrfToken = "";
const inflight = new Map<string, Promise<any>>();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(csrfToken && init.method && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...(init.headers ?? {}) } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) { const error = new Error(body?.message || body?.error || `HTTP ${response.status}`) as Error & { code?: string; status?: number }; error.code = body?.error; error.status = response.status; throw error; }
  return body as T;
}

export async function login(email: string, password: string, totpCode?: string) {
  const result = await request<{ user: any; csrfToken: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, totpCode: totpCode || undefined }) }); csrfToken = result.csrfToken; return result.user;
}
export async function bootstrapAuth() { const me = await request<{ user: any }>("/api/auth/me"); const csrf = await request<{ csrfToken: string }>("/api/auth/csrf"); csrfToken = csrf.csrfToken; return me.user; }
export async function logout() { await request("/api/auth/logout", { method: "POST", body: "{}" }); csrfToken = ""; }
export const getDashboard = () => request<any>("/api/dashboard");
export const getCommands = (limit = 200) => request<{ items: CommandRecord[] }>(`/api/commands?limit=${limit}`);
export const getCommandEvents = (id: string) => request<any>(`/api/commands/${encodeURIComponent(id)}/events`);
export const getAudit = () => request<any>("/api/audit");
export const cancelCommand = (id: string) => request<any>(`/api/commands/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
export const retryCommand = (id: string) => request<any>(`/api/commands/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" });
export const setupTotp = () => request<{ secret: string; uri: string }>("/api/auth/totp/setup", { method: "POST", body: "{}" });
export const enableTotp = (code: string) => request("/api/auth/totp/enable", { method: "POST", body: JSON.stringify({ code }) });

export function createCommand(type: CommandType, payload: Record<string, unknown>, priority = 0): Promise<any> {
  const signature = `${type}:${JSON.stringify(payload)}`; const existing = inflight.get(signature); if (existing) return existing;
  // The ten-minute bucket survives a fast response/re-click and a page reload without blocking a legitimate future rerun.
  const promise = commandKey(type, signature).then((key) => request("/api/commands", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ type, payload, priority }) })).finally(() => inflight.delete(signature));
  inflight.set(signature, promise); return promise;
}

async function commandKey(type: CommandType, signature: string): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bucket}:${signature}`));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${type}:${bucket}:${hash}`;
}
