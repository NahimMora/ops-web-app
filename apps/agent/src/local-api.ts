import { randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { Readable } from "node:stream";
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
  async form(path: string, form: FormData, timeoutMs = 10 * 60_000) {
    await this.authenticate();
    let response = await postMultipart(`${agentConfig.localApiUrl}${path}`, form, this.headers(), timeoutMs);
    if (response.status === 401) {
      this.token = "";
      await this.authenticate(true);
      response = await postMultipart(`${agentConfig.localApiUrl}${path}`, form, this.headers(), timeoutMs);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LocalApiError(response.status, response.body.slice(0, 2000));
    }
    return response.status === 204 || !response.body ? null : JSON.parse(response.body);
  }
  async download(path: string): Promise<Response> {
    await this.authenticate();
    let response = await fetch(`${agentConfig.localApiUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10 * 60_000) });
    if (response.status === 401) { this.token = ""; await this.authenticate(true); response = await fetch(`${agentConfig.localApiUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10 * 60_000) }); }
    if (!response.ok || !response.body) throw new LocalApiError(response.status, (await response.text()).slice(0, 1000)); return response;
  }
}
export class LocalApiError extends Error { constructor(readonly status: number, message: string) { super(`Local API ${status}: ${message}`); } }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MultipartPart = {
  header: Buffer;
  value: string | Blob;
  trailer: Buffer;
};

async function postMultipart(urlValue: string, form: FormData, headers: HeadersInit, timeoutMs: number) {
  const url = new URL(urlValue);
  const boundary = `----holasalta-${randomBytes(16).toString("hex")}`;
  const { parts, closing, contentLength } = buildMultipart(form, boundary);
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(headers).entries()),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(contentLength),
      },
    }, resolve);
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Local multipart upload timed out after ${timeoutMs}ms`);
      (error as NodeJS.ErrnoException).code = "LOCAL_MULTIPART_TIMEOUT";
      request.destroy(error);
    });
    void writeMultipart(request, parts, closing).catch((error) => request.destroy(error as Error));
  });
  const response = await responsePromise;
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") };
}

function buildMultipart(form: FormData, boundary: string) {
  const parts: MultipartPart[] = [];
  let contentLength = 0;
  for (const [rawName, value] of form.entries()) {
    const name = quoteMultipartValue(rawName);
    const isBlob = value instanceof Blob;
    const filename = isBlob && "name" in value ? quoteMultipartValue(String(value.name)) : "upload.bin";
    const disposition = isBlob
      ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${value.type || "application/octet-stream"}`
      : `Content-Disposition: form-data; name="${name}"`;
    const header = Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n`, "utf8");
    const trailer = Buffer.from("\r\n", "utf8");
    const size = isBlob ? value.size : Buffer.byteLength(value, "utf8");
    parts.push({ header, value, trailer });
    contentLength += header.length + size + trailer.length;
  }
  const closing = Buffer.from(`--${boundary}--\r\n`, "utf8");
  contentLength += closing.length;
  return { parts, closing, contentLength };
}

async function writeMultipart(request: ClientRequest, parts: MultipartPart[], closing: Buffer) {
  for (const part of parts) {
    await writeRequestChunk(request, part.header);
    if (typeof part.value === "string") {
      await writeRequestChunk(request, Buffer.from(part.value, "utf8"));
    } else {
      for await (const chunk of Readable.fromWeb(part.value.stream() as any)) {
        await writeRequestChunk(request, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    await writeRequestChunk(request, part.trailer);
  }
  request.end(closing);
}

async function writeRequestChunk(request: ClientRequest, chunk: Buffer) {
  if (!request.write(chunk)) await once(request, "drain");
}

function quoteMultipartValue(value: string) {
  return value.replace(/[\r\n]/g, " ").replace(/"/g, "%22");
}
