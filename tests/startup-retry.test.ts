import { describe, expect, it, vi } from "vitest";
import { initializeWithRetry } from "../apps/server/src/startup-retry.js";

describe("startup retry", () => {
  it("retries bounded transient MySQL failures", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { code: "ECONNREFUSED" }))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await initializeWithRetry(operation, { maxAttempts: 3, delaysMs: [25], sleep, onRetry });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 25, reason: "mysql_transient" });
  });

  it("does not retry credential or SQL errors", async () => {
    const error = Object.assign(new Error("access denied"), { code: "ER_ACCESS_DENIED_ERROR" });
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(initializeWithRetry(operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the configured attempt limit", async () => {
    const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(initializeWithRetry(operation, { maxAttempts: 3, delaysMs: [10, 20], sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });
});
