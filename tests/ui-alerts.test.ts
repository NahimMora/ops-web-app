import { describe, expect, it } from "vitest";
import { computeOpsAlerts } from "../apps/web/src/ui.js";

function snapshot(payload: unknown) {
  return { payload };
}

describe("computeOpsAlerts", () => {
  it("reports only the agent-offline alert and skips everything else when the bridge is unreachable", () => {
    const alerts = computeOpsAlerts(
      { agent: { online: false } },
      { "automation.status": snapshot({ status: "running", platforms: { whatsapp: { needs_auth: true } } }) },
    );
    expect(alerts).toEqual([{ id: "agent-offline", tone: "critical", message: expect.stringContaining("agente local") }]);
  });

  it("is silent when the agent is online and everything reports healthy", () => {
    const alerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running", platforms: { whatsapp: { worker_status: "running" }, x: { worker_status: "running" } } }) },
    );
    expect(alerts).toEqual([]);
  });

  it("flags a stopped runtime", () => {
    const alerts = computeOpsAlerts({ agent: { online: true } }, { "automation.status": snapshot({ status: "stopped" }) });
    expect(alerts.map((a) => a.id)).toContain("runtime-stopped");
  });

  it("flags a platform needing manual reauthentication as critical", () => {
    const alerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running", platforms: { whatsapp: { needs_auth: true } } }) },
    );
    expect(alerts).toContainEqual({ id: "whatsapp-needs-auth", tone: "critical", message: expect.stringContaining("WhatsApp") });
  });

  it("flags a degraded worker as a warning including its last_error", () => {
    const alerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running", platforms: { x: { worker_status: "degraded", last_error: "browser crashed" } } }) },
    );
    expect(alerts).toContainEqual({ id: "x-worker-error", tone: "warning", message: expect.stringContaining("browser crashed") });
  });

  it("counts pending Instagram items awaiting manual review", () => {
    const alerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running" }), "instagram.pending": snapshot({ pending: [{ id: "a" }, { id: "b" }] }) },
    );
    expect(alerts).toContainEqual({ id: "ig-pending", tone: "warning", message: expect.stringContaining("2 publicación") });
  });

  it("flags a local job that stopped advancing but not one still actively updating", () => {
    const now = Date.now();
    const staleJob = { job_id: "stuck", status: "publishing", updated_at: new Date(now - 25 * 60_000).toISOString() };
    const freshJob = { job_id: "moving", status: "publishing", updated_at: new Date(now - 2 * 60_000).toISOString() };

    const staleAlerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running" }), "automation.jobs": snapshot({ items: [staleJob] }) },
    );
    expect(staleAlerts.map((a) => a.id)).toContain("stale-jobs");

    const freshAlerts = computeOpsAlerts(
      { agent: { online: true } },
      { "automation.status": snapshot({ status: "running" }), "automation.jobs": snapshot({ items: [freshJob] }) },
    );
    expect(freshAlerts.map((a) => a.id)).not.toContain("stale-jobs");
  });
});
