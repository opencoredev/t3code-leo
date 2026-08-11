/**
 * OrphanedSessionRecovery - settles sessions stranded by a server restart.
 *
 * Provider sessions are child processes of this server, so none survive a
 * restart. Any session the projection still calls `starting` or `running` at
 * boot is therefore stale, and its turn can never finish: the process that
 * would report the result is gone. The thread shows "Working" forever.
 *
 * The inactivity reaper cannot recover these. It walks the live runtime
 * directory, which no longer lists a dead session, and it deliberately skips
 * any session holding an `activeTurnId` — exactly the stranded case.
 *
 * @module OrphanedSessionRecovery
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * OrphanedSessionRecoveryShape - Service API for boot-time session recovery.
 */
export interface OrphanedSessionRecoveryShape {
  /** Settle every session left live by the previous process. Runs once. */
  readonly recover: () => Effect.Effect<void>;
}

/**
 * OrphanedSessionRecovery - Service tag for boot-time session recovery.
 */
export class OrphanedSessionRecovery extends Context.Service<
  OrphanedSessionRecovery,
  OrphanedSessionRecoveryShape
>()("t3/orchestration/Services/OrphanedSessionRecovery") {}
