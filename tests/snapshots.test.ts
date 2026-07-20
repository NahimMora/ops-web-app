import { describe, expect, it, vi } from "vitest";
import type { LocalApi } from "../apps/agent/src/local-api.js";
import type { OpsClient } from "../apps/agent/src/ops-client.js";
import { syncSnapshots } from "../apps/agent/src/snapshots.js";

describe("snapshot synchronization", () => {
  it("omits server-owned fields and retries unchanged data after an upload failure", async () => {
    const local = {
      get: vi.fn().mockResolvedValue({ status: "healthy", nested: { value: 1 } }),
    } as unknown as LocalApi;
    const snapshot = vi.fn()
      .mockRejectedValueOnce(new Error("temporary upload failure"))
      .mockResolvedValue({ ok: true });
    const ops = { snapshot } as unknown as OpsClient;

    await expect(syncSnapshots(local, ops, ["system.health"])).rejects.toThrow("temporary upload failure");
    await expect(syncSnapshots(local, ops, ["system.health"])).resolves.toBeUndefined();
    await expect(syncSnapshots(local, ops, ["system.health"])).resolves.toBeUndefined();

    expect(snapshot).toHaveBeenCalledTimes(2);
    const submitted = snapshot.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(submitted).toMatchObject({
      key: "system.health",
      schemaVersion: 1,
      payload: { status: "healthy", nested: { value: 1 } },
    });
    expect(submitted).not.toHaveProperty("updatedAt");
    expect(submitted).not.toHaveProperty("fresh");
  });
});
