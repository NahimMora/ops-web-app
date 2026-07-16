import { agentConfig, capabilities } from "./config.js";
import { executeCommand } from "./executors.js";
import { LocalApi, LocalApiError } from "./local-api.js";
import { OpsClient } from "./ops-client.js";
import { syncSnapshots } from "./snapshots.js";

const local = new LocalApi(); const ops = new OpsClient(); let stopping = false; let active = false;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function localHealth(): Promise<"healthy" | "degraded" | "offline"> { try { const result = await local.get("/health", 5000); return result?.status === "healthy" ? "healthy" : "degraded"; } catch { return "offline"; } }
async function heartbeatLoop() { while (!stopping) { try { await ops.heartbeat(await localHealth(), capabilities, { active }); } catch (error) { console.error(`[agent] heartbeat failed: ${safeError(error)}`); } await delay(agentConfig.heartbeatMs); } }
async function snapshotLoop() { while (!stopping) { try { if ((await localHealth()) !== "offline") await syncSnapshots(local, ops); } catch (error) { console.error(`[agent] snapshot sync failed: ${safeError(error)}`); } await delay(active ? 10_000 : 20_000); } }

async function processLoop() {
  while (!stopping) {
    try {
      const claim = await ops.claim(capabilities); if (!claim) { await delay(agentConfig.pollMs); continue; }
      active = true; const { command, leaseToken } = claim; let stage = "starting"; let progress = 1; let localJobId: string | undefined; let sideEffect = false;
      console.log(`[agent] claimed ${command.id} (${command.type})`); await ops.start(command.id, leaseToken);
      const leaseTimer = setInterval(() => { void ops.commandHeartbeat(command.id, leaseToken, stage, progress, localJobId).catch((error) => console.error(`[agent] lease heartbeat failed for ${command.id}: ${safeError(error)}`)); }, 20_000); leaseTimer.unref();
      try {
        const result = await executeCommand(command, local, {
          progress: async (nextStage, nextProgress, nextLocalJobId) => { stage = nextStage; progress = nextProgress; localJobId = nextLocalJobId ?? localJobId; await ops.commandHeartbeat(command.id, leaseToken, stage, progress, localJobId); },
          sideEffect: async () => { if (!sideEffect) { await ops.sideEffect(command.id, leaseToken); sideEffect = true; } },
          refreshSnapshots: () => syncSnapshots(local, ops),
        });
        await syncSnapshots(local, ops).catch(() => undefined); await ops.complete(command.id, leaseToken, result.status, result.result, result.localJobId ?? localJobId); console.log(`[agent] completed ${command.id} (${result.status})`);
      } catch (error) {
        const message = safeError(error); const retryable = !sideEffect && (!(error instanceof LocalApiError) || error.status >= 500 || error.status === 429); const status = sideEffect ? "requires_attention" : "failed";
        await ops.fail(command.id, leaseToken, status, sideEffect ? "external_result_unknown" : "execution_failed", message, retryable, localJobId).catch((reportError) => console.error(`[agent] could not report failure for ${command.id}: ${safeError(reportError)}`)); console.error(`[agent] failed ${command.id}: ${message}`);
      } finally { clearInterval(leaseTimer); active = false; }
    } catch (error) { active = false; console.error(`[agent] polling error: ${safeError(error)}`); await delay(10_000); }
  }
}

function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(Bearer|token|secret|password)[^\s,;]*/gi, "$1=[REDACTED]").slice(0, 1000); }
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
console.log("[agent] HolaSalta Ops Agent 1.0.0 starting"); await Promise.all([heartbeatLoop(), snapshotLoop(), processLoop()]);
