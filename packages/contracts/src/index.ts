import { z } from "zod";

export const commandStatuses = [
  "queued", "claimed", "running", "completed", "partial_success",
  "completed_unverified", "waiting_manual_retry", "requires_attention", "failed", "cancelled",
] as const;
export const commandStatusSchema = z.enum(commandStatuses);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

export const scraperSources = [
  "minutouno", "tn", "na", "ambito", "aries", "justicia", "fiscales",
  "nuevodiario", "elonce", "eloncesalta", "eltribuno", "infobae", "quepasasalta",
] as const;
export const scraperSourceSchema = z.enum(scraperSources);

const whatsappGroupSchema = z.object({
  id: z.string().min(1).max(300),
  nombre: z.string().min(1).max(300),
  group_query_hint: z.string().max(300).nullish(),
  imagen: z.string().url().nullish(),
});
const publishPlatforms = z.enum(["web", "wix", "instagram", "facebook", "whatsapp", "x"]);
const videoPlatforms = z.enum(["facebook", "instagram", "x", "whatsapp"]);
const jsonObject = z.record(z.string(), z.unknown());

export const commandPayloadSchemas = {
  "snapshot.refresh": z.object({ keys: z.array(z.string().min(1).max(100)).max(20).optional() }).strict(),
  "scraper.titles": z.object({ source: scraperSourceSchema, maxArticles: z.number().int().min(1).max(100).default(20) }).strict(),
  "scraper.details": z.object({ source: scraperSourceSchema, urls: z.array(z.string().url()).min(1).max(100) }).strict(),
  "scraper.all.titles": z.object({ maxArticlesPerSource: z.number().int().min(1).max(50).default(10) }).strict(),
  "scraper.all.details": z.object({ items: z.array(z.object({ source: z.string().min(1).max(50), url: z.string().url() })).min(1).max(300) }).strict(),
  "news.load": z.object({}).strict(),
  "news.load_wordpress": z.object({ perPage: z.number().int().min(1).max(100).default(20) }).strict(),
  "news.save": z.object({ items: z.array(jsonObject).max(1000) }).strict(),
  "news.clear_cache": z.object({}).strict(),
  "news.publish": z.object({
    selectedIndices: z.array(z.number().int().min(0)).max(1000).default([]),
    directNewsItems: z.array(jsonObject).max(100).optional(),
    platforms: z.array(publishPlatforms).min(1),
    whatsappGroups: z.array(whatsappGroupSchema).max(100).default([]),
    whatsappGroupSet: jsonObject.nullish(),
    instagramEmojis: z.boolean().default(true),
    wixPin: z.boolean().default(false),
    wixCategories: z.boolean().default(false),
  }).strict(),
  "publish.clear": z.object({}).strict(),
  "automation.start": z.object({}).strict(),
  "automation.stop": z.object({}).strict(),
  "automation.restart": z.object({}).strict(),
  "automation.job.cancel": z.object({ jobId: z.string().min(1).max(128) }).strict(),
  "automation.jobs.clear": z.object({}).strict(),
  "instagram.pending.retry": z.object({ pendingId: z.string().min(1).max(256) }).strict(),
  "instagram.pending.delete": z.object({ pendingId: z.string().min(1).max(256) }).strict(),
  "whatsapp.groups.extract": z.object({}).strict(),
  "whatsapp.group_set.save": z.object({ id: z.string().max(128).optional(), nombre: z.string().min(1).max(200), grupos: z.array(whatsappGroupSchema).max(100) }).strict(),
  "xvideo.create_url": z.object({
    sourceUrl: z.string().url(), title: z.string().max(180).default(""), caption: z.string().max(2200).default(""),
    quality: z.enum(["borrador", "rapido", "normal"]).default("normal"),
    textMode: z.enum(["auto", "manual", "disabled"]).default("auto"),
  }).strict(),
  "xvideo.update": z.object({ jobId: z.string().min(1).max(128), title: z.string().max(180).optional(), caption: z.string().max(2200).optional() }).strict(),
  "xvideo.share_test": z.object({ jobId: z.string().min(1).max(128) }).strict(),
  "xvideo.publish": z.object({
    jobId: z.string().min(1).max(128), platforms: z.array(videoPlatforms).min(1),
    title: z.string().max(180).optional(), caption: z.string().max(2200).optional(),
    whatsappGroups: z.array(whatsappGroupSchema).max(100).default([]), whatsappGroupSet: jsonObject.nullish(),
  }).strict(),
  "xvideo.batch.create": z.object({
    sourceUrls: z.array(z.string().url()).min(1).max(100),
    quality: z.enum(["borrador", "rapido", "normal"]).default("normal"),
    textMode: z.enum(["auto", "manual", "disabled"]).default("auto"),
    action: z.enum(["process", "publish", "download"]).default("process"),
    platforms: z.array(videoPlatforms).default([]),
    whatsappGroups: z.array(whatsappGroupSchema).max(100).default([]), whatsappGroupSet: jsonObject.nullish(),
  }).strict(),
  "xvideo.batch.publish": z.object({ jobIds: z.array(z.string().min(1).max(128)).min(1).max(100), platforms: z.array(videoPlatforms).min(1), whatsappGroups: z.array(whatsappGroupSchema).max(100).default([]), whatsappGroupSet: jsonObject.nullish() }).strict(),
  "xvideo.clear_cache": z.object({}).strict(),
  "xvideo.clear_jobs": z.object({}).strict(),
  "xvideo.export_r2": z.object({ jobId: z.string().min(1).max(128), filename: z.string().max(200).optional() }).strict(),
  "wix.pin": z.object({ postIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict(),
  "wix.assign_categories": z.object({ postIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict(),
  "wordpress.share": z.object({ post: jsonObject, platforms: z.array(publishPlatforms).min(1), whatsappGroups: z.array(whatsappGroupSchema).max(100).default([]), whatsappGroupSet: jsonObject.nullish(), instagramEmojis: z.boolean().default(true) }).strict(),
} as const;

export const commandTypes = Object.keys(commandPayloadSchemas) as Array<keyof typeof commandPayloadSchemas>;
export type CommandType = keyof typeof commandPayloadSchemas;

export function isCommandType(value: string): value is CommandType {
  return Object.hasOwn(commandPayloadSchemas, value);
}

export function parseCommandPayload(type: CommandType, payload: unknown): Record<string, unknown> {
  return commandPayloadSchemas[type].parse(payload) as Record<string, unknown>;
}

export const commandCreateSchema = z.object({ type: z.string().refine(isCommandType), payload: jsonObject.default({}), priority: z.number().int().min(-10).max(10).default(0) }).strict();
export const agentHeartbeatSchema = z.object({
  agentId: z.string().min(1).max(100), version: z.string().min(1).max(50),
  capabilities: z.array(z.string().min(1).max(100)).max(100),
  localHealth: z.enum(["healthy", "degraded", "offline"]), metadata: jsonObject.default({}),
}).strict();
export const agentUpdateSchema = z.object({
  leaseToken: z.string().min(32).max(512), currentStage: z.string().min(1).max(100).optional(),
  progressPercent: z.number().int().min(0).max(100).optional(), result: z.unknown().optional(),
  errorCode: z.string().max(100).optional(), errorMessage: z.string().max(2000).optional(),
  retryable: z.boolean().optional(), localJobId: z.string().max(200).optional(),
}).strict();

export interface CommandRecord {
  id: string; type: CommandType; status: CommandStatus; payload: Record<string, unknown>; priority: number;
  requiredCapability: string; resourceKey: string | null; currentStage: string | null; progressPercent: number;
  localJobId: string | null; result: unknown; errorCode: string | null; errorMessage: string | null;
  retryable: boolean; attemptCount: number; maxAttempts: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface SnapshotRecord {
  key: string; revision: number; schemaVersion: number; payload: unknown; contentHash: string;
  capturedAt: string; updatedAt: string; fresh?: boolean;
}

export function requiredCapability(type: CommandType): string {
  if (type.startsWith("scraper.")) return "scraping";
  if (type.startsWith("xvideo.")) return type === "xvideo.export_r2" ? "r2-video" : "video";
  if (type.startsWith("automation.") || type.startsWith("instagram.") || type.startsWith("whatsapp.")) return "automation";
  if (type.startsWith("wix.")) return "wix";
  if (type.startsWith("wordpress.")) return "wordpress";
  if (type.startsWith("news.") || type.startsWith("publish.")) return "publishing";
  return "core";
}
export function resourceKeyFor(type: CommandType, payload: Record<string, unknown>): string | null {
  if (type.startsWith("whatsapp.")) return "whatsapp:profile_default";
  if (["automation.start", "automation.stop", "automation.restart"].includes(type)) return "automation:runtime";
  if (type.startsWith("xvideo.")) return `video:${String(payload.jobId ?? "pipeline")}`;
  if (type === "news.publish" || type === "wordpress.share") return "publishing:global";
  if (type.startsWith("instagram.")) return "instagram:default";
  if (type.startsWith("wix.")) return "wix:default";
  return null;
}
export function hasExternalSideEffect(type: CommandType): boolean {
  return ["news.publish", "wordpress.share", "xvideo.publish", "xvideo.batch.publish", "xvideo.share_test", "wix.pin", "wix.assign_categories", "instagram.pending.retry", "whatsapp.group_set.save"].includes(type);
}
