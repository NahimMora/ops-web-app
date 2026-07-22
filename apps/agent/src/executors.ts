import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { CommandRecord, CommandStatus } from "../../../packages/contracts/src/index.js";
import { agentConfig } from "./config.js";
import { LocalApi } from "./local-api.js";

export type ExecutionResult = { status: CommandStatus; result: unknown; localJobId?: string };
export type ExecutionContext = {
  progress(stage: string, percent: number, localJobId?: string): Promise<void>;
  sideEffect(): Promise<void>;
  refreshSnapshots(keys?: string[], onProgress?: (key: string, current: number, total: number) => Promise<void> | void): Promise<void>;
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
    case "scraper.details": return ok(await api.post(`${scraperRoutes[p.source]}/details`, { urls: p.urls }, 20 * 60_000));
    case "scraper.clear": return ok(await api.post("/api/scraper-all/clear", { source: p.source }, 30_000));
    case "scraper.all.titles": return ok(await api.post("/api/scraper-all/titles", { max_articles_per_source: p.maxArticlesPerSource }, 10 * 60_000));
    case "scraper.all.details": return ok(await api.post("/api/scraper-all/details", { items: p.items }, 30 * 60_000));
    case "news.load_wordpress": {
      await context.progress("wordpress_fetching", 10);
      const result = await api.post(`/api/news/load-from-wordpress?per_page=${Number(p.perPage)}`, {}, 45_000);
      await context.progress("wordpress_imported", 90);
      return ok(result);
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
    case "xvideo.update": return ok(await api.patch(`/api/x-video/jobs/${encodeURIComponent(p.jobId)}`, { title: p.title, caption: p.caption }, 10 * 60_000));
    case "xvideo.share_test": await context.sideEffect(); return ok(await api.post(`/api/x-video/jobs/${encodeURIComponent(p.jobId)}/share-test-group`, {}, 10 * 60_000));
    case "xvideo.publish": return publishVideo(p, api, context);
    case "xvideo.batch.create": return createVideoBatch(p, api, context);
    case "xvideo.batch.publish": return publishVideoBatch(p, api, context);
    case "xvideo.clear_cache": return ok(await api.post("/api/x-video/cache/clear"));
    case "xvideo.clear_jobs": return ok(await api.post("/api/x-video/jobs/clear"));
    case "xvideo.export_r2": return exportVideo(p, api, context);
    default: throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function publishNews(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  await ctx.sideEffect();
  const queued = await api.post("/api/publish/", { selected_indices: p.selectedIndices, direct_news_items: p.directNewsItems, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet, instagram_emojis: p.instagramEmojis }, 60_000);
  const jobId = String(queued.job_id); await ctx.progress("local_job_queued", 5, jobId);
  const job = await poll(api, `/api/publish/jobs/${encodeURIComponent(jobId)}`, (data) => data?.job ?? data, ["success", "partial_success", "failed"], ctx, jobId, 4 * 60 * 60_000);
  return { status: mapStatus(job.status), result: job, localJobId: jobId } as ExecutionResult;
}

async function shareWordPress(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const post = p.post ?? {}; await ctx.sideEffect();
  const queued = await api.post("/api/publish/", { selected_indices: [], direct_news_items: [{ titulo: post.titulo, url_wordpress: post.url_wordpress, web_url: post.url_wordpress, imagen: post.imagen, extracto: post.extracto }], platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet, instagram_emojis: p.instagramEmojis });
  const jobId = String(queued.job_id); const job = await poll(api, `/api/publish/jobs/${encodeURIComponent(jobId)}`, (data) => data?.job ?? data, ["success", "partial_success", "failed"], ctx, jobId, 4 * 60 * 60_000);
  return { status: mapStatus(job.status), result: job, localJobId: jobId } as ExecutionResult;
}

async function createVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  const form = new FormData(); form.set("source_url", p.sourceUrl); form.set("title", p.title); form.set("caption", p.caption); form.set("quality", p.quality); form.set("text_mode", p.textMode);
  const created = await api.form("/api/x-video/jobs", form); const jobId = String(created.job_id); await ctx.progress("video_queued", 5, jobId);
  const job = await poll(api, `/api/x-video/jobs/${encodeURIComponent(jobId)}`, (data) => data, ["ready", "failed"], ctx, jobId, 4 * 60 * 60_000);
  return { status: job.status === "ready" ? "completed" : "failed", result: job, localJobId: jobId } as ExecutionResult;
}

async function publishVideo(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  await ctx.sideEffect(); const jobId = String(p.jobId);
  await api.post(`/api/x-video/jobs/${encodeURIComponent(jobId)}/publish`, { platforms: p.platforms, title: p.title, caption: p.caption, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet }, 60_000);
  const job = await poll(api, `/api/x-video/jobs/${encodeURIComponent(jobId)}`, (data) => data, ["ready", "failed"], ctx, jobId, 4 * 60 * 60_000, (data) => !["queued", "publishing"].includes(String(data.publish_status)));
  return { status: mapStatus(job.publish_status), result: job, localJobId: jobId } as ExecutionResult;
}

async function createVideoBatch(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  if (p.action === "publish") await ctx.sideEffect();
  const result = await api.post("/api/x-video/batches", { source_urls: p.sourceUrls, quality: p.quality, text_mode: p.textMode, action: p.action, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet });
  const batchId = String(result.batch?.job_id ?? ""); if (!batchId) return ok(result);
  const batch = await poll(api, `/api/automation/jobs/${encodeURIComponent(batchId)}`, (data) => data?.job ?? data, ["completed", "completed_unverified", "partial_success", "failed", "cancelled"], ctx, batchId, 8 * 60 * 60_000);
  return { status: mapStatus(batch.status), result: { ...result, final: batch }, localJobId: batchId } as ExecutionResult;
}

async function publishVideoBatch(p: Record<string, any>, api: LocalApi, ctx: ExecutionContext) {
  await ctx.sideEffect(); const result = await api.post("/api/x-video/jobs/publish-batch", { job_ids: p.jobIds, platforms: p.platforms, whatsapp_groups: p.whatsappGroups, whatsapp_group_set: p.whatsappGroupSet });
  const batchId = String(result.batch?.job_id ?? ""); if (!batchId) return resultStatus(result);
  const batch = await poll(api, `/api/automation/jobs/${encodeURIComponent(batchId)}`, (data) => data?.job ?? data, ["completed", "completed_unverified", "partial_success", "failed", "cancelled"], ctx, batchId, 8 * 60 * 60_000);
  return { status: mapStatus(batch.status), result: { ...result, final: batch }, localJobId: batchId } as ExecutionResult;
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
