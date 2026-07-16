const RETRYABLE = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT",
]);

type Notice = { attempt: number; delayMs: number; reason: "mysql_transient" | "migration_lock_busy" };
type Options = { maxAttempts?: number; delaysMs?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (notice: Notice) => void };

export async function initializeWithRetry(operation: () => Promise<void>, options: Options = {}): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delays = options.delaysMs ?? [1_000, 2_000];
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try { await operation(); return; }
    catch (error) {
      const reason = transientReason(error);
      if (!reason || attempt >= maxAttempts) throw error;
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1_000;
      options.onRetry?.({ attempt, delayMs, reason });
      await sleep(delayMs);
    }
  }
}

function transientReason(error: unknown): Notice["reason"] | null {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (RETRYABLE.has(code)) return "mysql_transient";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("could not acquire migration lock") ? "migration_lock_busy" : null;
}
