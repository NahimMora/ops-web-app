import { Readable } from "node:stream";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { CommandRecord, CommandStatus } from "../../../packages/contracts/src/index.js";
import { agentConfig } from "./config.js";
import { LocalApi } from "./local-api.js";
import type { TemporaryMediaUpload } from "./ops-client.js";

export type ExecutionResult = { status: CommandStatus; result: unknown; localJobId?: string };
export type ExecutionContext = {
  progress(stage: string, percent: number, localJobId?: string): Promise<void>;
  sideEffect(): Promise<void>;
  refreshSnapshots(keys?: string[], onProgress?: (key: string, current: number, total: number) => Promise<void> | void): Promise<void>;
  getTemporaryMediaUpload(id: string): Promise<TemporaryMediaUpload>;
  completeTemporaryMediaUpload(id: string, received: boolean, errorMessage?: string): Promise<unknown>;
};
const scraperRoutes: Record<string, string> = { minutouno: "/api/scraper", tn: "/api/scraper-tn", na: "/api/scraper-na", ambito: "/api/scraper-ambito", aries: "/api/scraper-ariesonline", justicia: "/api/scraper-justiciasalta", fiscales: "/api/scraper-fiscales", nuevodiario: "/api/scraper-nuevodiario", elonce: "/api/scraper-elonce", eloncesalta: "/api/scraper-eloncesalta", eltribuno: "/api/scraper-eltribuno", infobae: "/api/scraper-infobae", quepasasalta: "/api/scraper-quepasasalta" };

export async function executeCommand(command: CommandRecord, api: LocalApi, context: ExecutionContext): Promise<ExecutionResult> {
  const p = command.payload as Record<string, any>; await context.progress("dispatching", 2);
  switch (command.type) {
    case "snapshot.refresh": {
      const keys = Array.isArray(p.keys) ? p.keys : undefined;
      await context.refreshSnapshots(keys, async (key, current, total) => {
        await context.progress(`snapshot:${key}`, Math.max(5, Math.round((current / total) * 90)));
      });
      return ok({ refreshed: true, keys: keys ?? "all" });
    }
    case "scraper.titles": return ok(await api.post(`${scraperRoutes[p.source]}/titles`, { max_articles: p.maxArticles }, 5 * 60_000));
    case "scraper.details": return ok(await prepareArticles(
      await api.post(`${scraperRoutes[p.source]}/details`, { urls: p.urls }, 20 * 60_000),
      api,
    ));
    case "scraper.clear": return ok(await api.post("/api/scraper-all/clear", { source: p.source }, 30_000));
    case "scraper.all.titles": return ok(await api.post("/api/scraper-all/titles", { max_articles_per_source: p.maxArticlesPerSource }, 10 * 60_000));
    case "scraper.all.details": return ok(await prepareArticles(
      await api.post("/api/scraper-all/details", { items: p.items }, 30 * 60_000),
      api,
    ));
    case "news.load_wordpress": {
      await context.progress("wordpress_fetching", 10);
      const result = await api.post(`/api/news/load-from-wordpress?per_page=${Number(p.perPage)}`, {}, 45_000);
      const stored = await api.get("/api/news/", 30_000);
      const imported = Array.isArray(stored) ? stored.filter((item) => item?.wordpress_imported) : [];
      const prepared = imported.length
        ? await api.post("/api/news/prepare-editorial", { items: imported, persist: true }, 45 * 60_000)
        : { articles: [], count: 0 };
      await context.progress("wordpress_imported", 90);
      return ok({ ...result, prepared: prepared.count });
    }
    case "news.save": return ok(await api.post("/api/news/save", p.items, 5 * 60_000));
    case "news.clear_cache": return ok(await api.delete("/api/news/clear-cache"));
    case "publish.clear": return ok(await api.post("/api/publish/jobs/clear"));
    case "automation.start": return ok(await api.post("/api/automation/start"));
    case "automation.stop": return ok(await api.post("/api/automation/stop"));
    case "automation.restart": return ok(await api.post("/api/automation/restart", {}, 5 * 60_000));
    case "automation.job.cancel": return ok(await api.post(`/api/automation/jobs/${encodeURIComponent(p.jobId)}/cancel`));
    case "automation.jobs.clear": return ok(await api.post("/api/automation/jobs/clear"));
    case "instagram.pending.retry": await context.sideEffect(); return ok(await api.post(`/api/automation/ig-pending/${encodeURIComponent(p.pendingId)}/retry`, {}, 10 * 60_000));
    case "instagram.pending.delete": return ok(await api.delete(`/api/automation/ig-pending/${encodeURIComponent(p.pendingId)}`));
    case "whatsapp.groups.extract": return ok(await api.post("/api/whatsapp/groups/extract", {}, 5 * 60_000));
    case "whatsapp.group_set.save": await context.sideEffect(); return ok(await api.post("/api/whatsapp/group-sets", { id: p.id, nombre: p.nombre, grupos: p.grupos }));
    case "news.publish": return publishNews(p, api, context);
    case "wordpress.share": return shareWordPress(p, api, context);
    case "xvideo.create_url": return createVideo(p, api, context);
    case "xvideo.create_upload": return createUploadedVideo(p, api, context);
    case "xvideo.update": return updateVideo(p, api, context);
    case "xvideo.share_test": await context.sideEffect(); return ok(await api.post(`/api/x-video/jobs/${encodeURIComponent(p.jobId)}/share-test-group`, {}, 10 * 60_000));
    case "xvideo.publish": return publishVideo(p, api, context);
    case "xvideo.batch.create": return createVideoBatch(p, api, context);
    case "xvideo.batch.publish": return publishVideoBatch(p, api, context);
    case "xvideo.clear_cache": return ok(await api.post("/api/x-video/cache/clear"));
    case "xvideo.clear_jobs": return clearVideoJobs(api, context);
    case "xvideo.export_r2": return exportVideo(p, api, context);
    default: throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function publishNews(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  let directNewsItems = p.directNewsItems;
  if (Array.isArray(directNewsItems) && directNewsItems.length) {
    const prepared = await api.post(
      "/api/news/prepare-editorial",
      { items: directNewsItems, persist: true },
      45 * 60_000,
    );
    directNewsItems = prepared.articles;
  }
  await ctx.sideEffect();
  const queued = await api.post("/api/publish/", { selected_indices: p.selectedIndices, direct_news_items: directNewsItems, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet, instagram_emojis: p.instagramEmojis }, 60_000);
  const jobId = String(queued.job_id); await ctx.progress("local_job_queued", 5, jobId);
  const job = await poll(api, `/api/publish/jobs/${encodeURIComponent(jobId)}`, (data) => data?.job ?? data, ["success", "partial_success", "failed"], ctx, jobId, 4 * 60 * 60_000);
  return { status: mapStatus(job.status), result: job, localJobId: jobId } as ExecutionResult;
}

async function shareWordPress(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  let post = p.post ?? {};
  if (post.id) {
    post = await api.get(`/api/wordpress/posts/${encodeURIComponent(String(post.id))}`, 30_000);
  }
  const prepared = await api.post(
    "/api/news/prepare-editorial",
    { items: [post], persist: true },
    15 * 60_000,
  );
  post = prepared.articles?.[0] ?? post;
  await ctx.sideEffect();
  const queued = await api.post("/api/publish/", {
    selected_indices: [],
    direct_news_items: [{
      ...post,
      url_wordpress: post.url_wordpress,
      web_url: post.web_url || post.url_wordpress,
    }],
    platforms: p.platforms,
    whatsapp_groups: p.whatsappGroups,
    whatsapp_group_set: p.whatsappGroupSet,
    instagram_emojis: p.instagramEmojis,
  });
  const jobId = String(queued.job_id); const job = await poll(api, `/api/publish/jobs/${encodeURIComponent(jobId)}`, (data) => data?.job ?? data, ["success", "partial_success", "failed"], ctx, jobId, 4 * 60 * 60_000);
  return { status: mapStatus(job.status), result: job, localJobId: jobId } as ExecutionResult;
}

async function prepareArticles(result: any, api: LocalApi) {
  const articles = Array.isArray(result?.articles) ? result.articles : [];
  if (!articles.length) return result;
  const prepared = await api.post(
    "/api/news/prepare-editorial",
    { items: articles, persist: true },
    45 * 60_000,
  );
  return { ...result, articles: prepared.articles, count: prepared.count };
}

async function createVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const form = new FormData(); form.set("source_url", p.sourceUrl); form.set("title", p.title); form.set("caption", p.caption); form.set("quality", p.quality); form.set("text_mode", p.textMode);
  const created = await api.form("/api/x-video/jobs", form); const jobId = String(created.job_id); await ctx.progress("video_queued", 5, jobId);
  const job = await poll(api, `/api/x-video/jobs/${encodeURIComponent(jobId)}`, (data) => data, ["ready", "failed"], ctx, jobId, 4 * 60 * 60_000);
  const result = job.status === "ready" ? await ensureVideoPreview(job, api, ctx) : job;
  return { status: job.status === "ready" ? "completed" : "failed", result, localJobId: jobId } as ExecutionResult;
}

async function createUploadedVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const uploadId = String(p.uploadId);
  await ctx.progress("upload_downloading", 8);
  const temporary = await ctx.getTemporaryMediaUpload(uploadId);
  let receivedLocally = false;
  try {
    const source = await fetch(temporary.downloadUrl, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!source.ok) throw new Error(`R2 temporary download failed with HTTP ${source.status}`);
    const blob = await source.blob();
    const contentType = String(blob.type || source.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
    const declaredSize = Number(temporary.upload.sizeBytes);
    if (!Number.isFinite(declaredSize) || declaredSize <= 0 || blob.size !== declaredSize || blob.size > 250 * 1024 * 1024) {
      throw new Error("Temporary video size does not match its validated metadata");
    }
    if (contentType !== temporary.upload.contentType) throw new Error("Temporary video MIME does not match its validated metadata");
    await ctx.progress("upload_sending_local", 30);
    const form = new FormData();
    form.set("video_file", blob, temporary.upload.fileName);
    form.set("title", temporary.upload.title);
    form.set("caption", temporary.upload.caption);
    form.set("quality", temporary.upload.quality);
    form.set("text_mode", temporary.upload.textMode);
    const created = await api.form("/api/x-video/jobs", form, 20 * 60_000);
    const jobId = String(created.job_id);
    receivedLocally = true;
    let cleanupWarning: unknown = null;
    try {
      const cleanup = await ctx.completeTemporaryMediaUpload(uploadId, true) as any;
      cleanupWarning = cleanup?.warning ?? null;
    } catch (error) {
      cleanupWarning = `No se pudo confirmar la limpieza temporal: ${safeMessage(error)}`;
    }
    await ctx.progress("video_queued", 38, jobId);
    const job = await poll(api, `/api/x-video/jobs/${encodeURIComponent(jobId)}`, (data) => data, ["ready", "failed"], ctx, jobId, 4 * 60 * 60_000);
    const previewed = job.status === "ready" ? await ensureVideoPreview(job, api, ctx) : job;
    return {
      status: job.status === "ready" ? "completed" : "failed",
      result: { ...previewed, temporary_upload_cleanup_warning: cleanupWarning },
      localJobId: jobId,
    } as ExecutionResult;
  } catch (error) {
    if (!receivedLocally) {
      await ctx.completeTemporaryMediaUpload(uploadId, false, safeMessage(error)).catch(() => undefined);
    }
    throw error;
  }
}

async function updateVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const job = await api.patch(
    `/api/x-video/jobs/${encodeURIComponent(p.jobId)}`,
    { title: p.title, caption: p.caption },
    10 * 60_000,
  );
  const result = String(job?.status) === "ready" ? await ensureVideoPreview(job, api, ctx) : job;
  return { status: String(job?.status) === "failed" ? "failed" : "completed", result, localJobId: String(p.jobId) } as ExecutionResult;
}

async function publishVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  await ctx.sideEffect(); const jobId = String(p.jobId);
  await api.post(`/api/x-video/jobs/${encodeURIComponent(jobId)}/publish`, { platforms: p.platforms, title: p.title, caption: p.caption, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet }, 60_000);
  const job = await poll(api, `/api/x-video/jobs/${encodeURIComponent(jobId)}`, (data) => data, ["ready", "failed"], ctx, jobId, 4 * 60 * 60_000, (data) => !["queued", "publishing"].includes(String(data.publish_status)));
  const result = job.status === "ready" ? await ensureVideoPreview(job, api, ctx) : job;
  return { status: mapStatus(job.publish_status), result, localJobId: jobId } as ExecutionResult;
}

async function createVideoBatch(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  if (p.action === "publish") await ctx.sideEffect();
  const result = await api.post("/api/x-video/batches", { source_urls: p.sourceUrls, quality: p.quality, text_mode: p.textMode, action: p.action, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet });
  const batchId = String(result.batch?.job_id ?? ""); if (!batchId) return ok(result);
  const batch = await poll(api, `/api/automation/jobs/${encodeURIComponent(batchId)}`, (data) => data?.job ?? data, ["completed", "completed_unverified", "partial_success", "failed", "cancelled"], ctx, batchId, 8 * 60 * 60_000);
  const previews = await ensureBatchPreviews(api, ctx, (job) => String(job.parent_batch_id ?? "") === batchId);
  return { status: mapStatus(batch.status), result: { ...result, final: batch, previews }, localJobId: batchId } as ExecutionResult;
}

async function publishVideoBatch(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  await ctx.sideEffect(); const result = await api.post("/api/x-video/jobs/publish-batch", { job_ids: p.jobIds, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet });
  const batchId = String(result.batch?.job_id ?? ""); if (!batchId) return resultStatus(result);
  const batch = await poll(api, `/api/automation/jobs/${encodeURIComponent(batchId)}`, (data) => data?.job ?? data, ["completed", "completed_unverified", "partial_success", "failed", "cancelled"], ctx, batchId, 8 * 60 * 60_000);
  const selected = new Set((p.jobIds as unknown[]).map(String));
  const previews = await ensureBatchPreviews(api, ctx, (job) => selected.has(String(job.job_id)));
  return { status: mapStatus(batch.status), result: { ...result, final: batch, previews }, localJobId: batchId } as ExecutionResult;
}

async function ensureBatchPreviews(api: LocalApi, ctx: ExecutionContext, select: (job: any) => boolean) {
  const listed = await api.get("/api/x-video/jobs?limit=100", 30_000);
  const jobs = Array.isArray(listed?.items) ? listed.items.filter((job: any) => select(job) && job.status === "ready") : [];
  const results = [];
  for (const job of jobs) results.push(await ensureVideoPreview(job, api, ctx));
  return results;
}

let previewClient: S3Client | null = null;
function configuredR2Client(): S3Client {
  const r2 = agentConfig.r2;
  if (!r2.endpoint || !r2.bucket || !r2.publicBaseUrl || !r2.accessKeyId || !r2.secretAccessKey) {
    throw new Error("R2 preview storage is not configured");
  }
  previewClient ??= new S3Client({
    region: r2.region,
    endpoint: r2.endpoint,
    maxAttempts: 4,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });
  return previewClient;
}

async function ensureVideoPreview(job: any, api: LocalApi, ctx: ExecutionContext) {
  const jobId = String(job?.job_id ?? "");
  const revision = Number(job?.render_revision ?? 0);
  if (!jobId || !Number.isInteger(revision) || revision <= 0) return job;
  if (job.preview_upload_status === "ready" && Number(job.preview_revision) === revision && job.preview_url) return job;
  try {
    await ctx.progress("preview_uploading", 90, jobId);
    await api.patch(`/api/x-video/jobs/${encodeURIComponent(jobId)}/preview`, {
      status: "uploading",
      revision,
      error: null,
    });
    const response = await api.download(`/api/x-video/jobs/${encodeURIComponent(jobId)}/download`);
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    const objectKey = `${agentConfig.r2.previewPrefix}/${safeJobId}/preview.mp4`;
    const length = Number(response.headers.get("content-length") || 0) || undefined;
    const upload = new Upload({
      client: configuredR2Client(),
      params: {
        Bucket: agentConfig.r2.bucket,
        Key: objectKey,
        Body: Readable.fromWeb(response.body as any),
        ContentLength: length,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000, immutable",
      },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
    const previewUrl = `${agentConfig.r2.publicBaseUrl}/${objectKey}?v=${revision}`;
    return await api.patch(`/api/x-video/jobs/${encodeURIComponent(jobId)}/preview`, {
      status: "ready",
      revision,
      preview_url: previewUrl,
      object_key: objectKey,
      error: null,
    });
  } catch (error) {
    const warning = safeMessage(error);
    await api.patch(`/api/x-video/jobs/${encodeURIComponent(jobId)}/preview`, {
      status: "error",
      revision,
      error: warning,
    }).catch(() => undefined);
    return { ...job, preview_upload_status: "error", preview_error: warning, preview_warning: true };
  }
}

async function clearVideoJobs(api: LocalApi, ctx: ExecutionContext): Promise<ExecutionResult> {
  const listed = await api.get("/api/x-video/jobs?limit=100", 30_000);
  const jobs = Array.isArray(listed?.items) ? listed.items : [];
  const deleted: string[] = [];
  const retained: Array<{ jobId: string; objectKey: string | null; error: string }> = [];
  const skippedActive: string[] = [];
  for (const [index, job] of jobs.entries()) {
    const jobId = String(job.job_id ?? "");
    if (!jobId) continue;
    if (["queued", "processing", "enhancing", "publishing"].includes(String(job.status))) {
      skippedActive.push(jobId);
      continue;
    }
    await ctx.progress("preview_cleanup", Math.min(90, 5 + Math.round(((index + 1) / Math.max(1, jobs.length)) * 80)), jobId);
    const objectKey = String(job.preview_object_key ?? "").trim();
    try {
      if (objectKey) {
        await configuredR2Client().send(new DeleteObjectCommand({ Bucket: agentConfig.r2.bucket, Key: objectKey }));
      }
      await api.delete(`/api/x-video/jobs/${encodeURIComponent(jobId)}`, 60_000);
      deleted.push(jobId);
    } catch (error) {
      const message = safeMessage(error);
      retained.push({ jobId, objectKey: objectKey || null, error: message });
      const revision = Number(job.render_revision ?? 0);
      if (Number.isInteger(revision) && revision >= 0) {
        await api.patch(`/api/x-video/jobs/${encodeURIComponent(jobId)}/preview`, {
          status: String(job.preview_upload_status || "error"),
          revision,
          error: message,
          cleanup_status: "cleanup_error",
        }).catch(() => undefined);
      }
    }
  }
  return {
    status: retained.length ? (deleted.length ? "partial_success" : "failed") : "completed",
    result: { deleted, count: deleted.length, retained, skippedActive, retryable: retained.length > 0 },
  };
}

async function exportVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const r2 = agentConfig.r2; if (!r2.endpoint || !r2.bucket || !r2.publicBaseUrl || !r2.accessKeyId || !r2.secretAccessKey) throw new Error("R2 video export is not configured in the local backend environment");
  await ctx.progress("video_download_local", 15, p.jobId); const response = await api.download(`/api/x-video/jobs/${encodeURIComponent(p.jobId)}/download`);
  const safeName = String(p.filename || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); const key = `${r2.prefix}/${encodeURIComponent(String(p.jobId))}/${safeName}`;
  const client = new S3Client({ region: r2.region, endpoint: r2.endpoint, maxAttempts: 4, credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey } });
  await ctx.progress("r2_upload", 35, p.jobId);
  const body = Readable.fromWeb(response.body as any); const length = Number(response.headers.get("content-length") || 0) || undefined;
  const upload = new Upload({ client, params: { Bucket: r2.bucket, Key: key, Body: body, ContentLength: length, ContentType: response.headers.get("content-type") || "video/mp4", CacheControl: "public, max-age=86400" }, queueSize: 3, partSize: 8 * 1024 * 1024 });
  upload.on("httpUploadProgress", (event) => { if (event.total && event.loaded) void ctx.progress("r2_upload", Math.min(95, 35 + Math.floor((event.loaded / event.total) * 60)), p.jobId); });
  await upload.done(); return { status: "completed", localJobId: String(p.jobId), result: { jobId: p.jobId, objectKey: key, downloadUrl: `${r2.publicBaseUrl}/${key}`, sizeBytes: length ?? null } } as ExecutionResult;
}

async function poll(api: LocalApi, path: string, unwrap: (data: any) => any, terminals: string[], ctx: ExecutionContext, jobId: string, timeoutMs: number, extraDone?: (data: any) => boolean) {
  const start = Date.now(); let attempt = 0;
  while (Date.now() - start < timeoutMs) { const value = unwrap(await api.get(path, 60_000)); const status = String(value?.status ?? ""); const percent = Number(value?.progress_percent ?? Math.min(95, 10 + attempt)); await ctx.progress(String(value?.current_stage ?? status ?? "processing"), Number.isFinite(percent) ? Math.min(95, percent) : 20, jobId); if (terminals.includes(status) && (!extraDone || extraDone(value))) return value; attempt++; await delay(2000); }
  throw new Error(`Local job ${jobId} did not reach terminal status before timeout`);
}
function ok(result: unknown): ExecutionResult { return { status: "completed", result }; }
function resultStatus(result: any): ExecutionResult { const failed = Number(result?.failed ?? 0); const success = Number(result?.success ?? 0); return { status: failed && success ? "partial_success" : failed ? "failed" : "completed", result }; }
function mapStatus(value: unknown): CommandStatus { const status = String(value ?? ""); if (["success", "completed", "ready"].includes(status)) return "completed"; if (status === "partial_success") return "partial_success"; if (status === "completed_unverified") return "completed_unverified"; if (status === "waiting_manual_retry") return "waiting_manual_retry"; if (status === "cancelled") return "cancelled"; return "failed"; }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(Bearer|token|secret|password)[^\s,;]*/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}
