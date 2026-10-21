import { execFile } from "node:child_process";
import { open, readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendEvent, JobRecord, PlatformHealth, PlatformOutcome, Snapshot, SupervisorKind, SupervisorLine } from "./evaluate.js";
import { isTerminal } from "./evaluate.js";

const run = promisify(execFile);
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function getJson(url: string, timeoutMs: number): Promise<{ ok: boolean; body?: any; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => undefined);
    return res.ok ? { ok: true, body } : { ok: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.name === "TimeoutError" ? `sin respuesta en ${timeoutMs / 1000}s` : error.message) : String(error) };
  }
}

// One PowerShell call for the two things Node can't see on its own: whether
// the agent process exists, and the supervisor scheduled task's state.
async function windowsProbe(agentEntry: string): Promise<{ agentRunning: boolean | null; supervisorTask: string | null }> {
  if (process.platform !== "win32") return { agentRunning: null, supervisorTask: null };
  const script = [
    `$entry = '${agentEntry.replace(/'/g, "''")}'`,
    "$agent = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }).Count",
    "$task = Get-ScheduledTask -TaskName 'HolaSalta Ops Local Agent' -ErrorAction SilentlyContinue",
    "@{ agent = $agent; task = $(if ($task) { [string]$task.State } else { 'NoInstalada' }) } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim());
    return { agentRunning: Number(parsed.agent) > 0, supervisorTask: String(parsed.task) };
  } catch {
    return { agentRunning: null, supervisorTask: null };
  }
}

export async function collectSnapshot(opts: { localApiUrl: string; serverUrl: string; agentEntry: string; diskPath: string }): Promise<Snapshot> {
  const [health, panel, probe, disk] = await Promise.all([
    getJson(`${opts.localApiUrl}/health`, 15_000),
    getJson(`${opts.serverUrl}/api/health`, 20_000),
    windowsProbe(opts.agentEntry),
    statfs(opts.diskPath).then((s) => (s.bavail * s.bsize) / 1024 ** 3).catch(() => null),
  ]);
  const body = asRecord(health.body);
  const platforms: Record<string, PlatformHealth> = {};
  for (const [name, raw] of Object.entries(asRecord(body.platforms))) {
    const p = asRecord(raw);
    if (p.enabled === false) continue;
    platforms[name] = { workerStatus: String(p.worker_status ?? "unknown"), browserConnected: typeof p.browser_connected === "boolean" ? p.browser_connected : null, needsAuth: p.needs_auth === true };
  }
  return {
    at: new Date().toISOString(),
    backend: { ok: health.ok, status: str(body.status), queueDepth: typeof body.common_queue_depth === "number" ? body.common_queue_depth : undefined, platforms, error: health.error },
    panel: { ok: panel.ok, error: panel.error },
    agentRunning: probe.agentRunning,
    supervisorTask: probe.supervisorTask,
    diskFreeGb: disk,
  };
}

async function readJsonFile(path: string): Promise<any> {
  try { return JSON.parse((await readFile(path, "utf8")).replace(BOM, "")); } catch { return undefined; }
}
const listOf = (raw: any, key: string): any[] => {
  const inner = Array.isArray(raw) ? raw : asRecord(raw)[key];
  return Array.isArray(inner) ? inner : inner && typeof inner === "object" ? Object.values(inner) : [];
};

export function toJobRecord(raw: any): JobRecord | null {
  const job = asRecord(raw);
  const id = str(job.job_id); const status = str(job.status);
  if (!id || !status || !isTerminal(status)) return null;
  const platforms: Record<string, PlatformOutcome> = {};
  for (const [name, value] of Object.entries(asRecord(job.platform_results))) {
    if (name === "global") continue;
    const v = asRecord(value);
    if ("items_success" in v || "items_failed" in v) {
      platforms[name] = { success: num(v.items_success), partial: num(v.items_partial_success), failed: num(v.items_failed), errorCode: str(v.error_code) };
    } else if (str(v.status)) {
      const s = String(v.status);
      platforms[name] = { success: ["success", "completed", "posted"].includes(s) ? 1 : 0, partial: s === "partial_success" ? 1 : 0, failed: s === "failed" ? 1 : 0, errorCode: str(v.error_code) };
    }
  }
  const summary = asRecord(job.payload_summary);
  // The backend runs both "download + render" and "publish" for a video as
  // job type x_video_publish; only the latter carries a real publish_status.
  const type = str(job.type) === "x_video_publish" && str(summary.publish_status) === "idle" ? "x_video_process" : str(job.type) ?? "unknown";
  return {
    id, type, status,
    createdAt: str(job.created_at) ?? new Date().toISOString(),
    finishedAt: str(job.completed_at) ?? str(job.updated_at) ?? new Date().toISOString(),
    errorCode: str(job.error_code), errorMessage: str(job.error_message), title: str(summary.title), platforms,
  };
}

export async function readTerminalJobs(dataDir: string): Promise<JobRecord[]> {
  return listOf(await readJsonFile(join(dataDir, "automation_common_jobs.json")), "jobs").map(toJobRecord).filter((j): j is JobRecord => j !== null);
}

export async function readEventsSince(dataDir: string, sinceTs: string | undefined): Promise<BackendEvent[]> {
  const files = ["automation_common_events.json", "automation_events.json"];
  const events: BackendEvent[] = [];
  for (const file of files) {
    for (const raw of listOf(await readJsonFile(join(dataDir, file)), "events")) {
      const e = asRecord(raw); const ts = str(e.ts);
      if (!ts || (sinceTs && ts <= sinceTs)) continue;
      events.push({ id: str(e.event_id) ?? ts, ts, source: str(e.source) ?? "?", level: str(e.level) ?? "info", message: str(e.message) ?? "", jobId: str(e.job_id), errorCode: str(e.error_code), detail: str(e.error) ?? str(e.detail) ?? str(e.reason) });
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

// Platform results often only say "failed" (news X: items_failed 1); the
// reason (x_rate_limited, ...) is on the worker's event for that job.
export function enrichJobsFromEvents(jobs: JobRecord[], events: BackendEvent[]): void {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const event of events) {
    const outcome = event.jobId ? byId.get(event.jobId)?.platforms[event.source.replace(/_worker$/, "")] : undefined;
    if (outcome && outcome.failed > 0 && !outcome.errorCode && event.errorCode) outcome.errorCode = event.errorCode;
  }
}

const SUPERVISOR_PATTERNS: [RegExp, SupervisorKind][] = [
  [/^Supervisor iniciado/, "supervisor_started"],
  [/^Reinicio planificado/, "planned_restart"],
  [/colgado.*forzando reinicio/, "backend_hung_restart"],
  [/Backend local no disponible y sin proceso/, "backend_started"],
  [/Backend local sin respuesta/, "backend_unresponsive"],
  [/^Agente no disponible; iniciando/, "agent_started"],
  [/Baileys.*no responde|Fallo al recuperar el servicio Baileys/, "baileys_recovery"],
  [/^Error de supervision/, "supervisor_error"],
];

export function parseSupervisorLine(line: string): SupervisorLine | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) (.*)$/.exec(line.trim());
  if (!match) return null;
  const text = match[2]!;
  const kind = SUPERVISOR_PATTERNS.find(([re]) => re.test(text))?.[1] ?? "other";
  return { ts: new Date(match[1]!).toISOString(), kind, text };
}

// Reads only what was appended since the last run. supervisor.ps1 rotates
// the log at 5MB (moves it to .1 and starts fresh), which shows up here as
// the file being shorter than the saved offset - then start from 0.
export async function readSupervisorLog(path: string, offset: number | undefined): Promise<{ lines: SupervisorLine[]; offset: number }> {
  let size: number;
  try { size = (await stat(path)).size; } catch { return { lines: [], offset: 0 }; }
  if (offset === undefined) return { lines: [], offset: size };
  const start = size < offset ? 0 : offset;
  if (size === start) return { lines: [], offset: start };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], offset: start };
    const text = buffer.subarray(0, lastNewline + 1).toString("utf8").replace(BOM, "");
    return { lines: text.split(/\r?\n/).map(parseSupervisorLine).filter((l): l is SupervisorLine => l !== null && l.kind !== "other"), offset: start + lastNewline + 1 };
  } finally {
    await handle.close();
  }
}
