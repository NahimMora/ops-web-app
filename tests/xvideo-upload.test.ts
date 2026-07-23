import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const r2 = vi.hoisted(() => ({
  head: { sizeBytes: 1024, contentType: "video/mp4", etag: "etag-1" },
  deleted: [] as string[],
  deleteError: false,
}));

vi.mock("../apps/server/src/r2-uploads.js", () => ({
  temporaryObjectKey: (id: string, fileName: string) => `ops/xvideo-uploads/${id}/source.${fileName.split(".").pop()}`,
  signTemporaryPut: async (key: string) => `https://r2.example.test/${key}?put=1`,
  signTemporaryGet: async (key: string) => `https://r2.example.test/${key}?get=1`,
  inspectTemporaryObject: async () => ({ ...r2.head }),
  deleteTemporaryObject: async (key: string) => {
    if (r2.deleteError) throw new Error("delete failed");
    r2.deleted.push(key);
  },
}));

import { createApp } from "../apps/server/src/app.js";
import { MemoryRepository } from "../apps/server/src/repository.js";
import { hashPassword, tokenHash } from "../apps/server/src/security.js";

let app: FastifyInstance | null = null;
afterEach(async () => { if (app) await app.close(); app = null; });
beforeEach(() => {
  r2.head = { sizeBytes: 1024, contentType: "video/mp4", etag: "etag-1" };
  r2.deleted.length = 0;
  r2.deleteError = false;
});

async function fixture() {
  const repository = new MemoryRepository();
  const password = "Valid-Test-Password-99!";
  const rawAgentToken = "test-agent-token-with-at-least-thirty-two-bytes";
  await repository.initialize({
    adminEmail: "holasalta@acceso.com",
    passwordHash: await hashPassword(password),
    agentId: "pc-holasalta-01",
    agentName: "PC",
    agentTokenHash: tokenHash(rawAgentToken, "development-token-pepper-change-me"),
  });
  app = await createApp(repository);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "holasalta@acceso.com", password },
  });
  return {
    repository,
    password,
    rawAgentToken,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    csrf: login.json().csrfToken as string,
  };
}

describe("temporary X video uploads", () => {
  it("requires a user session and CSRF, and validates extension/MIME/size", async () => {
    const { cookie, csrf } = await fixture();
    const valid = {
      fileName: "canary.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
      title: "Título",
      caption: "Caption",
      quality: "normal",
      textMode: "manual",
    };
    expect((await app!.inject({ method: "POST", url: "/api/xvideo/uploads", payload: valid })).statusCode).toBe(401);
    expect((await app!.inject({ method: "POST", url: "/api/xvideo/uploads", headers: { cookie }, payload: valid })).statusCode).toBe(403);
    expect((await app!.inject({
      method: "POST",
      url: "/api/xvideo/uploads",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...valid, fileName: "canary.webm" },
    })).statusCode).toBe(400);
    expect((await app!.inject({
      method: "POST",
      url: "/api/xvideo/uploads",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...valid, sizeBytes: 250 * 1024 * 1024 + 1 },
    })).statusCode).toBe(400);

    const accepted = await app!.inject({
      method: "POST",
      url: "/api/xvideo/uploads",
      headers: { cookie, "x-csrf-token": csrf },
      payload: valid,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      maxSizeBytes: 250 * 1024 * 1024,
    });
    expect(Date.parse(accepted.json().expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(Date.parse(accepted.json().retentionExpiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("validates the R2 object and finalizes idempotently", async () => {
    const { cookie, csrf, repository } = await fixture();
    const created = await app!.inject({
      method: "POST",
      url: "/api/xvideo/uploads",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        fileName: "canary.mp4",
        contentType: "video/mp4",
        sizeBytes: 1024,
        title: "",
        caption: "",
        quality: "normal",
        textMode: "auto",
      },
    });
    const uploadId = created.json().uploadId as string;
    r2.head.sizeBytes = 1000;
    const rejected = await app!.inject({
      method: "POST",
      url: `/api/xvideo/uploads/${uploadId}/finalize`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(rejected.statusCode).toBe(400);
    await repository.updateTemporaryMediaUpload(uploadId, { status: "created", errorMessage: null });
    r2.head.sizeBytes = 1024;
    const first = await app!.inject({
      method: "POST",
      url: `/api/xvideo/uploads/${uploadId}/finalize`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    const duplicate = await app!.inject({
      method: "POST",
      url: `/api/xvideo/uploads/${uploadId}/finalize`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().command.type).toBe("xvideo.create_upload");
    expect(duplicate.json().reused).toBe(true);
    expect(duplicate.json().command.id).toBe(first.json().command.id);
  });

  it("lets the authenticated agent claim the object and deletes it only after local receipt", async () => {
    const { repository, rawAgentToken } = await fixture();
    const upload = await repository.createTemporaryMediaUpload({
      id: "c73aac2d-89af-4dc3-bbb2-7cf2ab789de1",
      createdBy: "bootstrap-admin",
      objectKey: "ops/xvideo-uploads/c73aac2d/source.mp4",
      fileName: "source.mp4",
      contentType: "video/mp4",
      expectedSizeBytes: 1024,
      actualSizeBytes: 1024,
      etag: "etag",
      status: "uploaded",
      title: "",
      caption: "",
      quality: "normal",
      textMode: "auto",
      commandId: null,
      errorMessage: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const headers = {
      authorization: `Bearer ${rawAgentToken}`,
      "x-ops-agent-id": "pc-holasalta-01",
    };
    const claimed = await app!.inject({ method: "GET", url: `/api/agent/media-uploads/${upload.id}`, headers });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().downloadUrl).toContain("?get=1");
    expect(r2.deleted).toEqual([]);

    const retryable = await app!.inject({
      method: "POST",
      url: `/api/agent/media-uploads/${upload.id}/consumed`,
      headers,
      payload: { received: false, errorMessage: "timeout local" },
    });
    expect(retryable.json()).toMatchObject({ retryable: true, upload: { status: "uploaded" } });
    const reclaimed = await app!.inject({ method: "GET", url: `/api/agent/media-uploads/${upload.id}`, headers });
    expect(reclaimed.statusCode).toBe(200);

    const consumed = await app!.inject({
      method: "POST",
      url: `/api/agent/media-uploads/${upload.id}/consumed`,
      headers,
      payload: { received: true },
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toMatchObject({ deleted: true, upload: { status: "consumed" } });
    expect(r2.deleted).toEqual([upload.objectKey]);
  });

  it("rejects expired uploads and retains cleanup references when R2 deletion fails", async () => {
    const { repository, password, rawAgentToken } = await fixture();
    const login = await app!.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "holasalta@acceso.com", password },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const csrf = login.json().csrfToken as string;
    const expired = await repository.createTemporaryMediaUpload({
      id: "4ec4c618-c588-4e6a-bc86-88d65ddd549a",
      createdBy: "bootstrap-admin",
      objectKey: "ops/xvideo-uploads/expired/source.mp4",
      fileName: "source.mp4",
      contentType: "video/mp4",
      expectedSizeBytes: 1024,
      actualSizeBytes: null,
      etag: null,
      status: "created",
      title: "",
      caption: "",
      quality: "normal",
      textMode: "auto",
      commandId: null,
      errorMessage: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const finalization = await app!.inject({
      method: "POST",
      url: `/api/xvideo/uploads/${expired.id}/finalize`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(finalization.statusCode).toBe(410);

    await repository.updateTemporaryMediaUpload(expired.id, {
      status: "processing",
      actualSizeBytes: 1024,
      errorMessage: null,
    });
    r2.deleteError = true;
    const consumed = await app!.inject({
      method: "POST",
      url: `/api/agent/media-uploads/${expired.id}/consumed`,
      headers: {
        authorization: `Bearer ${rawAgentToken}`,
        "x-ops-agent-id": "pc-holasalta-01",
      },
      payload: { received: true },
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toMatchObject({
      deleted: false,
      warning: "R2_CLEANUP_RETRY_REQUIRED",
      upload: { status: "cleanup_error", objectKey: expired.objectKey },
    });
  });
});
