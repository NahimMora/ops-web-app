// One pass of the health monitor: collect, compare against the last run's
// state, mail whatever is new, persist. scripts/monitor.ps1 runs this every
// 5 minutes (scheduled task "HolaSalta Ops Health Monitor"). A fresh process
// per pass means one bad run can never take monitoring down with it.
//
//   node dist/monitor/main.js               normal pass
//   node dist/monitor/main.js --test-email  just send a test mail
//   node dist/monitor/main.js --report-now  pass + send the full report now
//   node dist/monitor/main.js --dry-run     print mails instead of sending
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectSnapshot, enrichJobsFromEvents, readEventsSince, readSupervisorLog, readTerminalJobs } from "./collect.js";
import { mailConfigured, monitorConfig } from "./config.js";
import { buildReport, emptyState, evaluate, formatLocal, type Mail, type MonitorState, reportDue, statusBlock } from "./evaluate.js";
import { sendMail } from "./mailer.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const statePath = join(monitorConfig.stateDir, "monitor-state.json");
const logPath = join(monitorConfig.stateDir, "monitor.log");

async function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    if (((await stat(logPath).catch(() => null))?.size ?? 0) > 2 * 1024 * 1024) await rename(logPath, `${logPath}.1`);
    await appendFile(logPath, line, "utf8");
  } catch { /* logging must never break a pass */ }
}

async function loadState(): Promise<MonitorState | null> {
  try { return JSON.parse(await readFile(statePath, "utf8")) as MonitorState; } catch { return null; }
}
async function saveState(state: MonitorState) {
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, statePath);
}

async function deliver(mail: Mail): Promise<boolean> {
  if (dryRun) { process.stdout.write(`\n===== ${mail.subject}\n${mail.text}\n=====\n`); return true; }
  if (!mailConfigured()) { await log(`mail no configurado (OPS_ALERT_SMTP_USER/PASSWORD en .secrets/agent.env); se omite: ${mail.subject}`); return false; }
  try { await sendMail(mail); await log(`mail enviado: ${mail.subject}`); return true; } catch (error) {
    await log(`fallo el envio de mail (${error instanceof Error ? error.message : String(error)}): ${mail.subject}`); return false;
  }
}

async function main() {
  await mkdir(monitorConfig.stateDir, { recursive: true });
  const snapshot = await collectSnapshot({ localApiUrl: monitorConfig.localApiUrl, serverUrl: monitorConfig.serverUrl, agentEntry: monitorConfig.agentEntry, diskPath: monitorConfig.opsRoot });

  if (args.has("--test-email")) {
    const ok = await deliver({ subject: "[HolaSalta] Mail de prueba del monitor", text: `Si te llego esto, las alertas por mail estan funcionando.\n\n${statusBlock(snapshot)}\n\n-- ${formatLocal(new Date().toISOString())}` });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const previous = await loadState();
  const baseline = previous === null;
  const state = previous ?? emptyState();
  const now = new Date();

  const jobs = await readTerminalJobs(monitorConfig.backendDataDir);
  const newJobs = jobs.filter((j) => !state.jobs[j.id]);
  const allEvents = await readEventsSince(monitorConfig.backendDataDir, undefined);
  enrichJobsFromEvents(newJobs, allEvents);
  const lastEventTs = state.lastEventTs;
  const events = lastEventTs ? allEvents.filter((e) => e.ts > lastEventTs) : allEvents;
  const supervisorLog = await readSupervisorLog(join(monitorConfig.stateDir, "supervisor.log"), state.supervisorLogOffset);

  const { state: next, alert } = evaluate({ state, snapshot, now, newJobs, newEvents: events, newSupervisorLines: supervisorLog.lines, baseline });
  next.lastEventTs = events.at(-1)?.ts ?? state.lastEventTs;
  next.supervisorLogOffset = supervisorLog.offset;
  if (baseline) next.lastReportAt = now.toISOString();

  // If the alert can't be sent, don't persist this pass: the next run then
  // sees the same new jobs/events/conditions again and retries the mail,
  // instead of silently marking them as already notified.
  if (alert && !(await deliver(alert))) return;

  const forced = args.has("--report-now");
  if (forced || reportDue(next, now, monitorConfig.reportIntervalHours)) {
    // A scheduled report covers everything since the previous one; a forced
    // one just covers the last interval.
    const since = forced || !next.lastReportAt ? new Date(now.getTime() - monitorConfig.reportIntervalHours * 3_600_000) : new Date(next.lastReportAt);
    if (await deliver(buildReport(next, snapshot, since, now))) next.lastReportAt = now.toISOString();
  }
  if (!dryRun) await saveState(next);
  await log(`pasada ok: backend=${snapshot.backend.ok} agente=${snapshot.agentRunning} panel=${snapshot.panel.ok} jobs_nuevos=${newJobs.length} eventos=${events.length} supervisor=${supervisorLog.lines.length}${baseline ? " (primera pasada, linea base)" : ""}`);
}

main().catch(async (error) => {
  await log(`error en la pasada del monitor: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
