import { agentConfig } from "./config.js";

export class LocalApi {
  private token = agentConfig.localApiToken;
  private authInFlight: Promise<void> | null = null;
  private headers(extra: HeadersInit = {}): HeadersInit { return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra }; }
  private async authenticate(force = false): Promise<void> {
    if (this.token && !force) return;
    if (this.authInFlight) return this.authInFlight;
    if (!agentConfig.localApiPassword) throw new Error("DASHBOARD_PASSWORD is missing from the local backend environment");
    this.authInFlight = (async () => {
      const response = await fetch(`${agentConfig.localApiUrl}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: agentConfig.localApiUsername, password: agentConfig.localApiPassword }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new LocalApiError(response.status, "Local authentication failed");
      const body = await response.json() as { token?: string };
      if (!body.token) throw new Error("Local authentication returned no token");
      this.token = body.token;
    })().finally(() => { this.authInFlight = null; });
    return this.authInFlight;
  }
  async json(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<any> {
    if (path !== "/health") await this.authenticate();
    // Reads can be retried. Mutations use one attempt because the legacy API has no universal idempotency key.
    const maxAttempts = (init.method ?? "GET") === "GET" ? 3 : 1;
    let authRetried = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(`${agentConfig.localApiUrl}${path}`, { ...init, headers: this.headers({ ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) }), signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 401 && path !== "/health" && !authRetried) {
          this.token = ""; authRetried = true; await this.authenticate(true); attempt--; continue;
        }
        if (!response.ok) {
          const error = new LocalApiError(response.status, (await response.text()).slice(0, 2000));
          if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) { await delay(300 * 2 ** attempt); continue; }
          throw error;
        }
        if (response.status === 204) return null; const text = await response.text(); return text ? JSON.parse(text) : null;
      } catch (error) {
        if (attempt >= maxAttempts || error instanceof LocalApiError) throw error;
        await delay(300 * 2 ** attempt);
      }
    }
    throw new Error("Local API retry policy exhausted");
  }
  get(path: string, timeoutMs?: number) { return this.json(path, { method: "GET" }, timeoutMs); }
  post(path: string, payload: unknown = {}, timeoutMs?: number) { return this.json(path, { method: "POST", body: JSON.stringify(payload) }, timeoutMs); }
  patch(path: string, payload: unknown, timeoutMs?: number) { return this.json(path, { method: "PATCH", body: JSON.stringify(payload) }, timeoutMs); }
  delete(path: string, timeoutMs?: number) { return this.json(path, { method: "DELETE" }, timeoutMs); }
  async form(path: string, form: FormData, timeoutMs = 10 * 60_000) { return this.json(path, { method: "POST", body: form }, timeoutMs); }
  async download(path: string): Promise<Response> {
    await this.authenticate();
    let response = await fetch(`${agentConfig.localApiUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10 * 60_000) });
    if (response.status === 401) { this.token = ""; await this.authenticate(true); response = await fetch(`${agentConfig.localApiUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10 * 60_000) }); }
    if (!response.ok || !response.body) throw new LocalApiError(response.status, (await response.text()).slice(0, 1000)); return response;
  }
}
export class LocalApiError extends Error { constructor(readonly status: number, message: string) { super(`Local API ${status}: ${message}`); } }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
