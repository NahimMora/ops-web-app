import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("local API multipart uploads", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("streams a file with a fixed content length and parses the backend response", async () => {
    let receivedBody = Buffer.alloc(0);
    let receivedLength = "";
    const server = createServer(async (request, response) => {
      if (request.url === "/api/auth/login") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ token: "local-test-token" }));
        return;
      }
      if (request.url === "/upload") {
        receivedLength = String(request.headers["content-length"] ?? "");
        receivedBody = await readBody(request);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ job_id: "job-1" }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    try {
      vi.stubEnv("OPS_AGENT_SERVER_URL", "https://ops.example.com");
      vi.stubEnv("OPS_AGENT_ID", "test-agent");
      vi.stubEnv("OPS_AGENT_TOKEN", "a".repeat(32));
      vi.stubEnv("OPS_LOCAL_API_URL", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("OPS_LOCAL_API_USERNAME", "admin");
      vi.stubEnv("DASHBOARD_PASSWORD", "test-password");
      const { LocalApi } = await import("../apps/agent/src/local-api.js");
      const api = new LocalApi();
      const form = new FormData();
      form.set("title", "Titulo de prueba");
      form.set("video_file", new Blob([Buffer.from("video-content")], { type: "video/mp4" }), "source.mp4");

      const result = await api.form("/upload", form, 5_000);

      expect(result).toEqual({ job_id: "job-1" });
      expect(Number(receivedLength)).toBe(receivedBody.length);
      expect(receivedBody.toString("utf8")).toContain('name="title"');
      expect(receivedBody.toString("utf8")).toContain("Titulo de prueba");
      expect(receivedBody.toString("utf8")).toContain('filename="source.mp4"');
      expect(receivedBody.toString("utf8")).toContain("video-content");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
