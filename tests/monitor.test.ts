import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enrichJobsFromItems, parseSupervisorLine, toJobRecord } from "../apps/monitor/src/collect.js";
import { buildReport, emptyState, evaluate, type JobRecord, jobStateKey, type MonitorState, normalizeMessage, type Snapshot } from "../apps/monitor/src/evaluate.js";

const healthy = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  at: "2026-10-20T12:00:00.000Z",
  backend: { ok: true, status: "running", queueDepth: 0, platforms: { whatsapp: { workerStatus: "running", browserConnected: true, needsAuth: false }, x: { workerStatus: "running", browserConnected: true, needsAuth: false } } },
  panel: { ok: true }, agentRunning: true, supervisorTask: "Running", diskFreeGb: 100,
  ...overrides,
});
const pass = (state: MonitorState, snapshot: Snapshot, minutes: number, extra: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({ state, snapshot, now: new Date(Date.parse("2026-10-20T12:00:00Z") + minutes * 60_000), newJobs: [], newEvents: [], newSupervisorLines: [], baseline: false, ...extra });
const xRateLimited = (id: string, finishedAt: string): JobRecord => ({
  id, type: "x_video_publish", status: "failed", createdAt: finishedAt, finishedAt, errorCode: "publish_failed", errorMessage: "No se pudo publicar el video.",
  platforms: { whatsapp_test: { success: 1, partial: 0, failed: 0 }, x: { success: 0, partial: 0, failed: 1, errorCode: "x_rate_limited" } },
});
const downloadBlocked = (id: string, finishedAt: string): JobRecord => ({
  id, type: "x_video_process", status: "failed", createdAt: finishedAt, finishedAt, errorCode: "download_blocked", errorMessage: "ERROR: [youtube] abc: Sign in to confirm you're not a bot", platforms: {},
});

describe("health monitor rules", () => {
  it("waits for a second failed check before paging that the backend is down, then reports recovery once", () => {
    const down = healthy({ backend: { ok: false, platforms: {}, error: "sin respuesta en 15s" } });
    const first = pass(emptyState(), down, 0);
    expect(first.alert).toBeNull();
    const second = pass(first.state, down, 5);
    expect(second.alert?.subject).toContain("CAIDO");
    expect(second.alert?.text).toContain("backend local");
    expect(pass(second.state, down, 10).alert).toBeNull();
    const back = pass(pass(second.state, down, 10).state, healthy(), 15);
    expect(back.alert?.subject).toContain("recuperado");
    expect(pass(back.state, healthy(), 20).alert).toBeNull();
  });

  it("does not page for a transient blip that clears before the threshold", () => {
    const down = healthy({ backend: { ok: false, platforms: {} } });
    const first = pass(emptyState(), down, 0);
    expect(pass(first.state, healthy(), 5).alert).toBeNull();
  });

  it("pages immediately when the supervisor task is not running, and never on an unknown probe", () => {
    expect(pass(emptyState(), healthy({ supervisorTask: "Ready" }), 0).alert?.text).toContain("HolaSalta Ops Local Agent");
    expect(pass(emptyState(), healthy({ agentRunning: null, supervisorTask: null }), 0).alert).toBeNull();
  });

  it("flags a stopped X runtime so publishing doesn't silently stall", () => {
    const stopped = healthy({ backend: { ...healthy().backend, platforms: { x: { workerStatus: "stopped", browserConnected: false, needsAuth: false } } } });
    const result = pass(pass(emptyState(), stopped, 0).state, stopped, 5);
    expect(result.alert?.text).toMatch(/X: runtime en estado "stopped"/);
  });

  it("mails a repeated failure once per window and marks it as recurring", () => {
    let state = emptyState();
    const r1 = pass(state, healthy(), 0, { newJobs: [downloadBlocked("a", "2026-10-20T12:00:00Z")] });
    expect(r1.alert?.text).toContain("download_blocked");
    state = r1.state;
    const r2 = pass(state, healthy(), 5, { newJobs: [downloadBlocked("b", "2026-10-20T12:05:00Z"), downloadBlocked("c", "2026-10-20T12:05:00Z")] });
    expect(r2.alert).toBeNull();
    const r3 = pass(r2.state, healthy(), 7 * 60, { newJobs: [downloadBlocked("d", "2026-10-20T19:00:00Z")] });
    expect(r3.alert?.text).toContain("VIENE FALLANDO: 4 veces en 24h");
  });

  it("never mails X's daily quota", () => {
    expect(pass(emptyState(), healthy(), 0, { newJobs: [xRateLimited("a", "2026-10-20T12:00:00Z")] }).alert).toBeNull();
  });

  it("explains a partial web failure with counts, the real error, and which platforms were only skipped", () => {
    // 2026-11-07: 1 of 21 WordPress posts timed out; the mail listed every
    // platform as failed, with no counts and no reason.
    const job: JobRecord = {
      id: "n1", type: "news_publish", status: "partial_success", createdAt: "2026-10-20T11:50:00Z", finishedAt: "2026-10-20T12:00:00Z",
      platforms: {
        web: { success: 20, partial: 0, failed: 1, errorCode: "message_send_failed", errorMessage: "POST https://holasalta.com/wp-json/wp/v2/posts failed: HTTPSConnectionPool(host='holasalta.com', port=443): Read timed out. (read timeout=30)" },
        instagram: { success: 20, partial: 0, failed: 1, errorCode: "web_url_required" },
        whatsapp: { success: 20, partial: 0, failed: 1, errorCode: "web_url_required" },
        x: { success: 0, partial: 0, failed: 21, errorCode: "x_rate_limited" },
      },
    };
    const text = pass(emptyState(), healthy(), 0, { newJobs: [job] }).alert?.text ?? "";
    expect(text).toContain("Web (WordPress): 1 de 21 fallaron (message_send_failed - WordPress no respondio a tiempo - POST https://holasalta.com");
    expect(text).toContain("Instagram, WhatsApp: 1 de 21 no se publicaron porque la Web no devolvio el link");
    expect(text).not.toContain("x_rate_limited");
  });

  it("does not show a bare job id as the error message, and shows the job's fatal error", () => {
    const video: JobRecord = { id: "61e1825148b6463a80bd87b3128b0b1f", type: "x_video_publish", status: "failed", createdAt: "2026-10-20T12:00:00Z", finishedAt: "2026-10-20T12:00:00Z", errorCode: "unhandled_exception", errorMessage: "61e1825148b6463a80bd87b3128b0b1f", title: "Titulo", platforms: {} };
    const news: JobRecord = {
      id: "n2", type: "news_publish", status: "partial_success", createdAt: "2026-10-20T12:00:00Z", finishedAt: "2026-10-20T12:00:00Z", fatalError: "Runtime x is not running",
      platforms: { web: { success: 5, partial: 0, failed: 0 }, x: { success: 0, partial: 0, failed: 5, errorCode: "runtime_not_ready", errorMessage: "Platform x did not execute." } },
    };
    const text = pass(emptyState(), healthy(), 0, { newJobs: [video, news] }).alert?.text ?? "";
    expect(text).toContain("Publicacion de video fallo (unhandled_exception) - \"Titulo\"");
    expect(text).not.toMatch(/fallo[^\n]*61e1825148b6463a80bd87b3128b0b1f/);
    expect(text).toContain("X: 5 de 5 fallaron (runtime_not_ready - la plataforma no llego a ejecutarse");
    expect(text).toContain("Error general del trabajo: Runtime x is not running");
  });

  it("does not mail the reboot recovery sequence, even when it spans two runs", () => {
    const sup = (ts: string, kind: "supervisor_started" | "backend_started" | "baileys_recovery") => ({ ts, kind, text: kind });
    const unreachable = (ts: string) => ({ id: ts, ts, source: "whatsapp_worker", level: "error", message: "whatsapp baileys service unreachable" });
    const boot = pass(emptyState(), healthy(), 0, { newSupervisorLines: [sup("2026-10-20T11:59:12Z", "supervisor_started"), sup("2026-10-20T11:59:15Z", "backend_started"), sup("2026-10-20T11:59:17Z", "baileys_recovery")] });
    expect(boot.alert).toBeNull();
    const next = pass(boot.state, healthy(), 5, { newEvents: ["12:00:33", "12:00:37", "12:00:41", "12:00:45"].map((t) => unreachable(`2026-10-20T${t}Z`)) });
    expect(next.alert).toBeNull();
    expect(next.state.failures).toHaveLength(0);
    // Outside the grace window the same event is a real problem again.
    expect(pass(next.state, healthy(), 60, { newEvents: [unreachable("2026-10-20T13:00:00Z")] }).alert?.text).toContain("baileys service unreachable");
    // A backend that died on its own (no reboot) still pages.
    expect(pass(emptyState(), healthy(), 0, { newSupervisorLines: [sup("2026-10-20T11:59:15Z", "backend_started")] }).alert?.text).toContain("estaba caido");
  });

  it("sees a video publish that reuses the id of the job that rendered it", () => {
    // The panel's "Publicar" requeues the render job under the same id; the
    // publish outcome used to be dropped as "already seen".
    const rendered: JobRecord = { id: "v1", type: "x_video_process", status: "completed", createdAt: "2026-10-20T11:50:00Z", finishedAt: "2026-10-20T11:55:00Z", platforms: {} };
    const published: JobRecord = {
      ...rendered, type: "x_video_publish", status: "partial_success", finishedAt: "2026-10-20T12:00:00Z", title: "Video",
      platforms: { instagram: { success: 0, partial: 0, failed: 1, errorCode: "message_send_failed", errorMessage: "IG rechazo el video" }, x: { success: 1, partial: 0, failed: 0 } },
    };
    const first = pass(emptyState(), healthy(), 0, { newJobs: [rendered] });
    expect(first.alert).toBeNull();
    expect(jobStateKey(first.state.jobs, rendered)).toBeNull();
    expect(jobStateKey(first.state.jobs, published)).toBe("v1@2026-10-20T12:00:00Z");
    const second = pass(first.state, healthy(), 5, { newJobs: [published] });
    expect(second.alert?.text).toContain("Instagram: 1 de 1 fallaron (message_send_failed - IG rechazo el video)");
    expect(Object.keys(second.state.jobs).sort()).toEqual(["v1", "v1@2026-10-20T12:00:00Z"]);
    // Seen once, never again.
    expect(jobStateKey(second.state.jobs, published)).toBeNull();
  });

  it("records history on the baseline pass without mailing it", () => {
    const result = pass(emptyState(), healthy(), 0, { newJobs: [xRateLimited("a", "2026-10-20T11:00:00Z")], baseline: true });
    expect(result.alert).toBeNull();
    expect(result.state.jobs.a).toBeDefined();
  });

  it("does not double-report a failed job through its own error event", () => {
    const job: JobRecord = { ...xRateLimited("j1", "2026-10-20T12:00:00Z"), type: "x_video_process", platforms: {}, errorMessage: "yt-dlp supero el tiempo limite" };
    const result = pass(emptyState(), healthy(), 0, { newJobs: [job], newEvents: [{ id: "e", ts: "2026-10-20T12:00:00Z", source: "automation_queue", level: "error", message: "job failed: yt-dlp supero el tiempo limite", jobId: "j1" }] });
    expect(result.alert?.text.match(/yt-dlp/g)).toHaveLength(1);
  });

  it("builds a report with per-platform and video stats", () => {
    let state = emptyState();
    state = pass(state, healthy(), 0, { newJobs: [xRateLimited("a", "2026-10-20T12:00:00Z")] }).state;
    const report = buildReport(state, healthy(), new Date("2026-10-19T00:00:00Z"), new Date("2026-10-20T12:10:00Z"));
    expect(report.text).toContain("VIDEOS X");
    expect(report.text).toMatch(/X\s+0 ok, 0 parcial, 1 fallidos .*x_rate_limited x1/);
    expect(report.subject).toContain("1 fallidos");
  });
});

describe("health monitor parsing", () => {
  it("maps backend job platform results", () => {
    const job = toJobRecord({ job_id: "n1", type: "news_publish", status: "partial_success", completed_at: "2026-10-20T13:37:00Z", platform_results: { web: { items_success: 1, items_partial_success: 0, items_failed: 0 }, x: { items_success: 0, items_failed: 1 }, global: { status: "partial_success" } } });
    expect(job?.platforms).toEqual({ web: { success: 1, partial: 0, failed: 0, errorCode: undefined }, x: { success: 0, partial: 0, failed: 1, errorCode: undefined } });
    expect(toJobRecord({ job_id: "n2", type: "news_publish", status: "publishing" })).toBeNull();
    const withDetail = toJobRecord({ job_id: "n3", type: "news_publish", status: "partial_success", completed_at: "2026-10-20T13:37:00Z", platform_results: { instagram: { items_success: 0, items_failed: 2, error_code: "web_url_required", error_message: "Skipped" }, global: { fatal_error: "boom" } } });
    expect(withDetail?.platforms.instagram?.errorMessage).toBe("Skipped");
    expect(withDetail?.fatalError).toBe("boom");
  });

  it("takes each platform's real error text and the fatal error from the publish job's items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monitor-"));
    try {
      const failed = (code: string, message: string) => ({ status: "failed", error_code: code, error_message: message });
      await writeFile(join(dir, "automation_jobs.json"), JSON.stringify({ jobs: [{
        job_id: "n1", error: null, summary: { global: { fatal_error: "cancelled" } },
        items: [
          { platform_results: { web: { status: "success" }, instagram: failed("web_url_required", "Skipped dependent platforms") } },
          { platform_results: { web: failed("message_send_failed", "Read timed out. (read timeout=30)"), instagram: failed("message_send_failed", "IG down") } },
        ],
      }] }), "utf8");
      const job: JobRecord = { id: "n1", type: "news_publish", status: "partial_success", createdAt: "x", finishedAt: "x", platforms: { web: { success: 1, partial: 0, failed: 1 }, instagram: { success: 0, partial: 0, failed: 2 } } };
      await enrichJobsFromItems([job], dir);
      expect(job.platforms.web).toMatchObject({ errorCode: "message_send_failed", errorMessage: "Read timed out. (read timeout=30)" });
      expect(job.platforms.instagram).toMatchObject({ errorCode: "message_send_failed,web_url_required", errorMessage: "IG down" });
      expect(job.fatalError).toBe("cancelled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies supervisor log lines", () => {
    expect(parseSupervisorLine("2026-10-20T18:16:46-03:00 Backend local colgado desde hace 181s (proceso vivo, /health no responde); forzando reinicio.")).toMatchObject({ kind: "backend_hung_restart", ts: "2026-10-20T21:16:46.000Z" });
    expect(parseSupervisorLine("2026-10-20T18:16:46-03:00 Agente no disponible; iniciando.")?.kind).toBe("agent_started");
    expect(parseSupervisorLine("2026-10-20T18:16:46-03:00 Reinicio planificado (deploy.ps1): backend=True agente=False")?.kind).toBe("planned_restart");
    expect(parseSupervisorLine("garbage")).toBeNull();
  });

  it("collapses ids and numbers in error signatures", () => {
    expect(normalizeMessage("job failed: [twitter] 2102213674308170159: No video")).toBe(normalizeMessage("job failed: [twitter] 2111676048974733621: No video"));
  });
});
