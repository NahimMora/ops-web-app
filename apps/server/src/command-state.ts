import type { CommandStatus, CommandType } from "../../../packages/contracts/src/index.js";
import { hasExternalSideEffect } from "../../../packages/contracts/src/index.js";

const terminal = new Set<CommandStatus>(["completed", "partial_success", "completed_unverified", "waiting_manual_retry", "requires_attention", "failed", "cancelled"]);
const transitions: Record<CommandStatus, Set<CommandStatus>> = {
  queued: new Set(["claimed", "cancelled"]),
  claimed: new Set(["running", "queued", "failed", "cancelled", "requires_attention"]),
  running: new Set(["completed", "partial_success", "completed_unverified", "waiting_manual_retry", "requires_attention", "failed", "cancelled"]),
  completed: new Set(), partial_success: new Set(), completed_unverified: new Set(), waiting_manual_retry: new Set(["queued", "cancelled"]),
  requires_attention: new Set(["queued", "cancelled"]), failed: new Set(["queued"]), cancelled: new Set(),
};

export function isTerminal(status: CommandStatus): boolean { return terminal.has(status); }
export function canTransition(from: CommandStatus, to: CommandStatus): boolean { return transitions[from].has(to); }

export function expiredLeaseOutcome(input: { type: CommandType; status: CommandStatus; sideEffectStarted: boolean; attemptCount: number; maxAttempts: number }): CommandStatus {
  if (input.sideEffectStarted && hasExternalSideEffect(input.type)) return "requires_attention";
  if (input.attemptCount < input.maxAttempts) return "queued";
  return "failed";
}
