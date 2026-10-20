// Pure alerting/reporting logic for the health monitor: everything here takes
// already-collected data plus the previous persisted state and returns the
// next state and what (if anything) should be mailed. No I/O, so the rules
// can be tested without a backend, a Gmail account, or Windows.

export interface PlatformHealth { workerStatus: string; browserConnected: boolean | null; needsAuth: boolean }
export interface Snapshot {
  at: string;
  backend: { ok: boolean; status?: string; queueDepth?: number; platforms: Record<string, PlatformHealth>; error?: string };
  panel: { ok: boolean; error?: string };
  // null = couldn't be determined this run (the probe itself failed) - never
  // treated as "down", so a flaky probe can't page anyone.
  agentRunning: boolean | null;
  supervisorTask: string | null;
  diskFreeGb: number | null;
}
export interface BackendEvent { id: string; ts: string; source: string; level: string; message: string; jobId?: string; errorCode?: string; detail?: string }
export interface PlatformOutcome { success: number; partial: number; failed: number; errorCode?: string }
export interface JobRecord {
  id: string; type: string; status: string; createdAt: string; finishedAt: string;
  errorCode?: string; errorMessage?: string; title?: string; platforms: Record<string, PlatformOutcome>;
}
export type SupervisorKind = "supervisor_started" | "backend_started" | "backend_hung_restart" | "backend_unresponsive" | "agent_started" | "baileys_recovery" | "supervisor_error" | "other";
export interface SupervisorLine { ts: string; kind: SupervisorKind; text: string }
export interface Failure { ts: string; signature: string; text: string; category: string }

export interface MonitorState {
  version: 1;
  conditions: Record<string, { since: string; consecutive: number; notified: boolean; detail: string }>;
  lastEventTs?: string;
  supervisorLogOffset?: number;
  jobs: Record<string, JobRecord>;
  failures: Failure[];
  supervisor: { ts: string; kind: SupervisorKind }[];
  samples: { at: string; backend: boolean; agent: boolean | null; panel: boolean; supervisor: boolean | null; platforms: Record<string, boolean> }[];
  lastAlertBySignature: Record<string, string>;
  lastReportAt?: string;
}

export interface Mail { subject: string; text: string }

export const emptyState = (): MonitorState => ({ version: 1, conditions: {}, jobs: {}, failures: [], supervisor: [], samples: [], lastAlertBySignature: {} });

const HOUR = 3_600_000;
const RETENTION_MS = 10 * 24 * HOUR;
const RECURRING_WINDOW_MS = 24 * HOUR;
const RECURRING_THRESHOLD = 3;
const DISK_LOW_GB = 10;
// Supervisor restarts are rarer and each one matters more than, say, the
// 20th "X daily limit" failure of the day - so they're re-mailed sooner.
const suppressionMs = (signature: string) => (signature.startsWith("sup:") ? HOUR : 6 * HOUR);
// How many consecutive monitor runs (5 min apart) a condition must persist
// before it pages. The backend's /health routinely misses a 4s probe for a
// few seconds (see supervisor.log), and a deploy restarts things on purpose;
// neither should send a "service down" mail.
const REQUIRED_CONSECUTIVE: Record<string, number> = { backend: 2, agent: 2, panel: 3, supervisor: 1, disk: 1 };
const requiredFor = (key: string) => REQUIRED_CONSECUTIVE[key] ?? 2;

const PLATFORM_LABEL: Record<string, string> = { whatsapp: "WhatsApp", x: "X", web: "Web (WordPress)", instagram: "Instagram", facebook: "Facebook", whatsapp_test: "WhatsApp (grupo de prueba)" };
const JOB_LABEL: Record<string, string> = { news_publish: "Publicacion de noticias", x_video_publish: "Publicacion de video", x_video_batch: "Lote de videos", x_video_process: "Descarga y render de video" };
export const platformLabel = (name: string) => PLATFORM_LABEL[name] ?? name;
export const jobLabel = (type: string) => JOB_LABEL[type] ?? type;
const TERMINAL = new Set(["completed", "failed", "partial_success", "cancelled"]);
export const isTerminal = (status: string) => TERMINAL.has(status);

// Collapses ids, counts and timestamps so "the same error" on different jobs
// shares one signature (and one mail per suppression window).
export function normalizeMessage(text: string): string {
  // Any token with a digit in it is an id/count/video id ("[youtube] F54AwRuivWo:").
  return text.toLowerCase().replace(/[^\s:]*\d[^\s:]*/g, "#").replace(/\s+/g, " ").trim().slice(0, 140);
}

function problemsFor(snap: Snapshot): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!snap.backend.ok) {
    problems.backend = `El backend local (127.0.0.1:8000) no responde${snap.backend.error ? `: ${snap.backend.error}` : ""}.`;
  } else {
    for (const [name, p] of Object.entries(snap.backend.platforms)) {
      const label = platformLabel(name);
      if (p.needsAuth) problems[`platform:${name}`] = `${label}: la sesion necesita login/QR.`;
      else if (p.workerStatus === "needs_intervention") problems[`platform:${name}`] = `${label}: worker en needs_intervention (circuit breaker abierto) - reiniciar el runtime desde Ops.`;
      else if (p.workerStatus !== "running") problems[`platform:${name}`] = `${label}: runtime en estado "${p.workerStatus}" - no se publica hasta iniciarlo desde Ops.`;
      else if (p.browserConnected === false) problems[`platform:${name}`] = `${label}: el navegador no esta conectado.`;
    }
  }
  if (snap.agentRunning === false) problems.agent = "El agente de Ops (dist/agent/main.js) no esta corriendo - el panel no puede ejecutar comandos.";
  if (snap.supervisorTask !== null && snap.supervisorTask !== "Running") problems.supervisor = `La tarea "HolaSalta Ops Local Agent" esta en estado "${snap.supervisorTask}" - nadie reinicia backend/agente si se caen.`;
  if (!snap.panel.ok) problems.panel = `El panel ops.holasalta.com no responde${snap.panel.error ? `: ${snap.panel.error}` : ""}.`;
  if (snap.diskFreeGb !== null && snap.diskFreeGb < DISK_LOW_GB) problems.disk = `Queda poco disco: ${snap.diskFreeGb.toFixed(1)} GB libres.`;
  return problems;
}

export function jobFailure(job: JobRecord): Failure | null {
  const failedPlatforms = Object.entries(job.platforms).filter(([, o]) => o.failed > 0);
  // The backend marks a news job "completed" when only X hit its daily quota
  // (other platforms published) - still a platform failure worth reporting.
  if (job.status === "cancelled" || (job.status !== "failed" && failedPlatforms.length === 0)) return null;
  const platforms = failedPlatforms.map(([name, o]) => `${platformLabel(name)}${o.errorCode ? ` (${o.errorCode})` : ""}`);
  const signature = `job:${job.type}:${job.status === "failed" ? "failed" : "partial"}:${job.errorCode ?? ""}:${failedPlatforms.map(([n, o]) => `${n}=${o.errorCode ?? ""}`).sort().join(",")}`;
  const parts = [`${jobLabel(job.type)} ${job.status === "failed" ? "fallo" : "con fallas parciales"}`];
  if (platforms.length) parts.push(`plataformas: ${platforms.join(", ")}`);
  if (job.errorMessage) parts.push(job.errorMessage);
  if (job.title) parts.push(`"${job.title}"`);
  return { ts: job.finishedAt, signature, text: parts.join(" - "), category: job.type.startsWith("x_video") ? "video" : "job" };
}

const ALERT_WARNING = /watchdog|needs_intervention|interrupted|stale jobs/i;
export function eventFailure(event: BackendEvent): Failure | null {
  if (event.level !== "error" && !(event.level === "warning" && ALERT_WARNING.test(event.message))) return null;
  const text = [`${event.source}: ${event.message}`, event.errorCode, event.detail].filter(Boolean).join(" - ").slice(0, 400);
  return { ts: event.ts, signature: `event:${event.source}:${normalizeMessage(event.message)}`, text, category: "event" };
}

const SUPERVISOR_ALERT: Partial<Record<SupervisorKind, string>> = {
  backend_hung_restart: "El backend estaba colgado y el supervisor lo reinicio a la fuerza",
  backend_started: "El backend estaba caido (sin proceso) y el supervisor lo volvio a levantar",
  agent_started: "El agente de Ops se habia caido y el supervisor lo volvio a levantar",
  baileys_recovery: "El servicio Baileys (WhatsApp) no respondia y el supervisor intento recuperarlo",
  supervisor_error: "El supervisor tuvo un error interno",
};
export function supervisorFailure(line: SupervisorLine): Failure | null {
  const label = SUPERVISOR_ALERT[line.kind];
  return label ? { ts: line.ts, signature: `sup:${line.kind}`, text: `${label} (${line.text})`, category: "supervisor" } : null;
}

export interface EvaluateInput {
  state: MonitorState; snapshot: Snapshot; now: Date;
  newJobs: JobRecord[]; newEvents: BackendEvent[]; newSupervisorLines: SupervisorLine[];
  // First run: everything already on disk is history, not news - it's
  // recorded for the stats but never mailed.
  baseline: boolean;
}

export function evaluate(input: EvaluateInput): { state: MonitorState; alert: Mail | null } {
  const { snapshot: snap, now, baseline } = input;
  const nowIso = now.toISOString();
  const state: MonitorState = structuredClone(input.state);
  const cutoff = now.getTime() - RETENTION_MS;

  // --- service conditions -------------------------------------------------
  const problems = problemsFor(snap);
  const down: string[] = []; const recovered: string[] = [];
  for (const [key, detail] of Object.entries(problems)) {
    const cond = state.conditions[key] ?? { since: nowIso, consecutive: 0, notified: false, detail };
    cond.consecutive += 1; cond.detail = detail;
    if (!cond.notified && cond.consecutive >= requiredFor(key)) { down.push(`${detail} (desde ${formatLocal(cond.since)})`); cond.notified = true; }
    state.conditions[key] = cond;
  }
  for (const [key, cond] of Object.entries(state.conditions)) {
    if (problems[key]) continue;
    if (cond.notified) recovered.push(`${cond.detail.replace(/\.$/, "")} -> se recupero (estuvo mal ${formatDuration(now.getTime() - Date.parse(cond.since))}).`);
    delete state.conditions[key];
  }

  state.samples.push({
    at: nowIso, backend: snap.backend.ok, agent: snap.agentRunning, panel: snap.panel.ok,
    supervisor: snap.supervisorTask === null ? null : snap.supervisorTask === "Running",
    platforms: Object.fromEntries(Object.entries(snap.backend.platforms).map(([n, p]) => [n, p.workerStatus === "running" && !p.needsAuth && p.browserConnected !== false])),
  });

  // --- failures -----------------------------------------------------------
  const knownJobIds = new Set([...Object.keys(state.jobs), ...input.newJobs.map((j) => j.id)]);
  const fresh: Failure[] = [];
  for (const job of input.newJobs) { state.jobs[job.id] = job; const f = jobFailure(job); if (f) fresh.push(f); }
  for (const event of input.newEvents) {
    // A failed job already produces its own (richer) failure entry above.
    if (event.jobId && knownJobIds.has(event.jobId) && event.level === "error" && event.message.startsWith("job failed")) continue;
    const f = eventFailure(event); if (f) fresh.push(f);
  }
  for (const line of input.newSupervisorLines) {
    state.supervisor.push({ ts: line.ts, kind: line.kind });
    const f = supervisorFailure(line); if (f) fresh.push(f);
  }
  state.failures.push(...fresh);

  const failureLines: string[] = [];
  if (!baseline) {
    const bySignature = new Map<string, Failure[]>();
    for (const f of fresh) bySignature.set(f.signature, [...(bySignature.get(f.signature) ?? []), f]);
    for (const [signature, group] of bySignature) {
      const recent = state.failures.filter((f) => f.signature === signature && now.getTime() - Date.parse(f.ts) <= RECURRING_WINDOW_MS).length;
      const last = state.lastAlertBySignature[signature];
      if (last && now.getTime() - Date.parse(last) < suppressionMs(signature)) continue;
      state.lastAlertBySignature[signature] = nowIso;
      const latest = group[group.length - 1]!;
      const tag = recent >= RECURRING_THRESHOLD ? `[VIENE FALLANDO: ${recent} veces en 24h] ` : group.length > 1 ? `[x${group.length}] ` : "";
      failureLines.push(`${tag}${latest.text} (${formatLocal(latest.ts)})`);
    }
  }

  // --- retention ----------------------------------------------------------
  for (const [id, job] of Object.entries(state.jobs)) if (Date.parse(job.finishedAt) < cutoff) delete state.jobs[id];
  state.failures = state.failures.filter((f) => Date.parse(f.ts) >= cutoff);
  state.supervisor = state.supervisor.filter((s) => Date.parse(s.ts) >= cutoff);
  state.samples = state.samples.filter((s) => Date.parse(s.at) >= cutoff);
  for (const [sig, ts] of Object.entries(state.lastAlertBySignature)) if (Date.parse(ts) < cutoff) delete state.lastAlertBySignature[sig];

  if (!down.length && !recovered.length && !failureLines.length) return { state, alert: null };
  const sections: string[] = [];
  if (down.length) sections.push(`SERVICIOS CAIDOS / CON PROBLEMAS\n${down.map((l) => `  - ${l}`).join("\n")}`);
  if (failureLines.length) sections.push(`FALLAS\n${failureLines.map((l) => `  - ${l}`).join("\n")}`);
  if (recovered.length) sections.push(`RECUPERADOS\n${recovered.map((l) => `  - ${l}`).join("\n")}`);
  const subject = down.length ? `[HolaSalta] CAIDO: ${down.length} servicio(s) con problemas`
    : failureLines.length ? `[HolaSalta] ${failureLines.length} falla(s) nueva(s)${failureLines.some((l) => l.startsWith("[VIENE FALLANDO")) ? " - algo viene fallando" : ""}`
      : `[HolaSalta] Servicio recuperado`;
  return { state, alert: { subject, text: `${sections.join("\n\n")}\n\n${statusBlock(snap)}\n\n-- Monitor de salud HolaSalta (PC ${hostLabel()}), ${formatLocal(nowIso)}` } };
}

export function reportDue(state: MonitorState, now: Date, intervalHours: number): boolean {
  return !state.lastReportAt || now.getTime() - Date.parse(state.lastReportAt) >= intervalHours * HOUR;
}

// --- report ---------------------------------------------------------------

const pct = (ok: number, total: number) => (total ? `${((ok / total) * 100).toFixed(1)}%` : "sin datos");

export function buildReport(state: MonitorState, snap: Snapshot, since: Date, now: Date): Mail {
  const from = since.getTime();
  const inWindow = (ts: string) => Date.parse(ts) >= from;
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);

  out(`Periodo: ${formatLocal(since.toISOString())} -> ${formatLocal(now.toISOString())}`);
  out(); out(statusBlock(snap));

  const samples = state.samples.filter((s) => inWindow(s.at));
  out(); out("DISPONIBILIDAD (chequeos cada 5 min)");
  out(`  Backend local:      ${pct(samples.filter((s) => s.backend).length, samples.length)}`);
  const agentSamples = samples.filter((s) => s.agent !== null);
  out(`  Agente Ops:         ${pct(agentSamples.filter((s) => s.agent).length, agentSamples.length)}`);
  out(`  Panel Hostinger:    ${pct(samples.filter((s) => s.panel).length, samples.length)}`);
  const supSamples = samples.filter((s) => s.supervisor !== null);
  out(`  Supervisor:         ${pct(supSamples.filter((s) => s.supervisor).length, supSamples.length)}`);
  const platformNames = [...new Set(samples.flatMap((s) => Object.keys(s.platforms)))];
  for (const name of platformNames) {
    const withData = samples.filter((s) => name in s.platforms);
    out(`  Runtime ${platformLabel(name).padEnd(11)} ${pct(withData.filter((s) => s.platforms[name]).length, withData.length)}`);
  }

  const sup = state.supervisor.filter((s) => inWindow(s.ts));
  const supCount = (k: SupervisorKind) => sup.filter((s) => s.kind === k).length;
  out(); out("SUPERVISOR");
  out(`  Backend reiniciado por cuelgue:    ${supCount("backend_hung_restart")}`);
  out(`  Backend levantado (estaba caido):  ${supCount("backend_started")}`);
  out(`  Backend lento (no respondio /health a tiempo): ${supCount("backend_unresponsive")}`);
  out(`  Agente relanzado:                  ${supCount("agent_started")}`);
  out(`  Supervisor reiniciado:             ${supCount("supervisor_started")}`);
  if (supCount("baileys_recovery")) out(`  Recuperaciones de Baileys:         ${supCount("baileys_recovery")}`);

  const jobs = Object.values(state.jobs).filter((j) => inWindow(j.finishedAt));
  out(); out(`TRABAJOS (${jobs.length} terminados)`);
  const types = [...new Set(jobs.map((j) => j.type))].sort();
  if (!types.length) out("  Ninguno en el periodo.");
  for (const type of types) {
    const ofType = jobs.filter((j) => j.type === type);
    const c = (s: string) => ofType.filter((j) => j.status === s).length;
    out(`  ${jobLabel(type)}: ${ofType.length} total - ${c("completed")} ok, ${c("partial_success")} parcial, ${c("failed")} fallidos${c("cancelled") ? `, ${c("cancelled")} cancelados` : ""}`);
  }

  const platformTotals = (subset: JobRecord[]) => {
    const totals: Record<string, PlatformOutcome & { codes: Record<string, number> }> = {};
    for (const job of subset) for (const [name, o] of Object.entries(job.platforms)) {
      const t = (totals[name] ??= { success: 0, partial: 0, failed: 0, codes: {} });
      t.success += o.success; t.partial += o.partial; t.failed += o.failed;
      if (o.failed && o.errorCode) t.codes[o.errorCode] = (t.codes[o.errorCode] ?? 0) + o.failed;
    }
    return totals;
  };
  const printTotals = (totals: ReturnType<typeof platformTotals>) => {
    const names = Object.keys(totals).sort();
    if (!names.length) { out("  Sin datos en el periodo."); return; }
    for (const name of names) {
      const t = totals[name]!; const total = t.success + t.partial + t.failed;
      const codes = Object.entries(t.codes).map(([c, n]) => `${c} x${n}`).join(", ");
      out(`  ${platformLabel(name).padEnd(27)} ${t.success} ok, ${t.partial} parcial, ${t.failed} fallidos (exito ${pct(t.success, total)})${codes ? ` - ${codes}` : ""}`);
    }
  };
  out(); out("NOTICIAS POR PLATAFORMA");
  printTotals(platformTotals(jobs.filter((j) => j.type === "news_publish")));

  const videoJobs = jobs.filter((j) => j.type.startsWith("x_video"));
  const videoFailures = state.failures.filter((f) => f.category === "video" || (f.category === "event" && /yt-dlp|youtube|twitter|video/i.test(f.text))).filter((f) => inWindow(f.ts));
  out(); out("VIDEOS X (descarga, render y publicacion)");
  const processed = videoJobs.filter((j) => j.type === "x_video_process");
  out(`  Descargas + render: ${processed.length} - ${processed.filter((j) => j.status === "completed").length} ok, ${processed.filter((j) => j.status === "failed").length} fallidas`);
  const publishes = videoJobs.filter((j) => j.type === "x_video_publish");
  out(`  Publicaciones de video: ${publishes.length} - ${publishes.filter((j) => j.status === "completed").length} ok, ${publishes.filter((j) => j.status === "failed").length} fallidas`);
  printTotals(platformTotals(publishes));
  const downloadErrors = videoFailures.filter((f) => /yt-dlp|download|descarg|no video|403|sign in|bot/i.test(f.text));
  out(`  Errores de descarga/procesamiento: ${downloadErrors.length}`);

  const grouped = new Map<string, { count: number; text: string }>();
  for (const f of state.failures.filter((f) => inWindow(f.ts))) {
    const g = grouped.get(f.signature) ?? { count: 0, text: f.text }; g.count += 1; g.text = f.text; grouped.set(f.signature, g);
  }
  const top = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  out(); out("ERRORES MAS FRECUENTES");
  if (!top.length) out("  Ninguno.");
  for (const g of top) out(`  ${String(g.count).padStart(4)}x  ${g.text.slice(0, 220)}`);

  const failedJobs = jobs.filter((j) => j.status === "failed").length;
  const subject = `[HolaSalta] Reporte de salud - ${jobs.length} trabajos, ${failedJobs} fallidos, backend ${pct(samples.filter((s) => s.backend).length, samples.length)} arriba`;
  out(); out(`-- Monitor de salud HolaSalta (PC ${hostLabel()})`);
  return { subject, text: lines.join("\n") };
}

export function statusBlock(snap: Snapshot): string {
  const yesNo = (v: boolean | null) => (v === null ? "desconocido" : v ? "OK" : "CAIDO");
  const lines = ["ESTADO ACTUAL",
    `  Backend local:   ${snap.backend.ok ? `OK (${snap.backend.status ?? "?"}, cola ${snap.backend.queueDepth ?? "?"})` : "CAIDO"}`];
  for (const [name, p] of Object.entries(snap.backend.platforms)) lines.push(`  ${platformLabel(name).padEnd(16)} ${p.workerStatus}${p.needsAuth ? ", necesita login" : ""}${p.browserConnected === false ? ", navegador desconectado" : ""}`);
  lines.push(`  Agente Ops:      ${yesNo(snap.agentRunning)}`, `  Supervisor:      ${snap.supervisorTask ?? "desconocido"}`, `  Panel Hostinger: ${yesNo(snap.panel.ok)}`);
  if (snap.diskFreeGb !== null) lines.push(`  Disco libre:     ${snap.diskFreeGb.toFixed(1)} GB`);
  return lines.join("\n");
}

const hostLabel = () => (typeof process !== "undefined" && process.env.COMPUTERNAME) || "?";

export function formatLocal(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-AR", { timeZone: "America/Argentina/Salta", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}
