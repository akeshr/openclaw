/** Manual cron wake helper for queueing system events into sessions. */
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  isRetryableHeartbeatBusySkipReason,
  type HeartbeatRunResult,
} from "../../infra/heartbeat-wake.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { CronSystemEventEnqueueResult } from "./state.js";
import type { CronServiceState } from "./state.js";

function isSystemEventAccepted(result: CronSystemEventEnqueueResult): boolean {
  if (typeof result === "boolean") {
    return result;
  }
  if (result && typeof result === "object") {
    return result.accepted !== false;
  }
  return true;
}

function wakeHeartbeatOptions(params: { sessionKey?: string; agentId?: string }) {
  return {
    source: "manual" as const,
    intent: "immediate" as const,
    reason: "wake",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Enqueues a manual cron wake event and optionally pokes the targeted heartbeat loop. */
export async function wake(
  state: CronServiceState,
  opts: {
    mode: "now" | "next-heartbeat";
    text: string;
    /**
     * Internal session key to enqueue the system event against. When omitted,
     * the dep's default (heartbeat / main) is used — wakes from a non-main
     * session would otherwise route to the wrong place. Callers wiring an
     * agent-tool `wake` should thread the resolved session key (e.g. from
     * `cron-tool`'s `resolveInternalSessionKey`) so the event lands on the
     * originating conversation lane.
     */
    sessionKey?: string;
    /**
     * Agent id paired with `sessionKey`. Forwarded to `enqueueSystemEvent`
     * and the heartbeat request so multi-agent setups route to the agent
     * that owns the targeted session — fixes the related half of #46886
     * ("always routes to default agent").
     */
    agentId?: string;
  },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  const agentId = opts.agentId?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  // Carry the originating session's channel-correct delivery context (e.g. the
  // bound Telegram topic/thread) so a wake routes back into that thread instead
  // of the chat root. Only attempt this when an origin session is targeted; a
  // no-origin wake keeps the exact pre-fix `enqueueSystemEvent(text, undefined)`
  // shape so its default-sessionKey binding still kicks in.
  const originDeliveryContext =
    sessionKey || agentId
      ? state.deps.resolveOriginDeliveryContext?.({ sessionKey, agentId })
      : undefined;
  const enqueueOpts =
    sessionKey || agentId
      ? {
          ...(sessionKey ? { sessionKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(originDeliveryContext ? { deliveryContext: originDeliveryContext } : {}),
        }
      : undefined;
  const queued = state.deps.enqueueSystemEvent(text, enqueueOpts);
  if (!isSystemEventAccepted(queued)) {
    return { ok: false, reason: "event-not-queued" } as const;
  }

  const shouldWakeImmediately = opts.mode === "now" || Boolean(sessionKey);
  if (shouldWakeImmediately && state.deps.runHeartbeatOnce) {
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 5_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();
    let heartbeat: HeartbeatRunResult;

    for (;;) {
      heartbeat = await state.deps.runHeartbeatOnce(wakeHeartbeatOptions({ sessionKey, agentId }));
      if (heartbeat.status !== "skipped" || !isRetryableHeartbeatBusySkipReason(heartbeat.reason)) {
        break;
      }
      if (heartbeat.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS) {
        state.deps.requestHeartbeat(wakeHeartbeatOptions({ sessionKey, agentId }));
        return { ok: false, reason: "heartbeat-skipped", heartbeat } as const;
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        state.deps.requestHeartbeat(wakeHeartbeatOptions({ sessionKey, agentId }));
        return { ok: false, reason: "heartbeat-skipped", heartbeat } as const;
      }
      await wait(retryDelayMs);
    }

    if (heartbeat.status === "ran") {
      return { ok: true, heartbeat } as const;
    }
    return {
      ok: false,
      reason: heartbeat.status === "failed" ? "heartbeat-failed" : "heartbeat-skipped",
      heartbeat,
    } as const;
  }

  if (opts.mode === "now") {
    state.deps.requestHeartbeat(wakeHeartbeatOptions({ sessionKey, agentId }));
  } else if (sessionKey) {
    // next-heartbeat + sessionKey still needs a targeted immediate wake.
    // Reasons:
    //   1. The regularly-scheduled heartbeat fires for the agent's main
    //      session, not the supplied sessionKey, so it never peeks the queue
    //      we just enqueued - the event would sit stranded indefinitely.
    //   2. An `intent: "event"` wake gets deferred by heartbeat-runner as
    //      not-due and is not retried (only busy-skips are), so it cannot
    //      stand in for the regular cadence either.
    // Effectively, --session-key collapses --mode now and --mode next-heartbeat
    // into the same targeted-immediate behavior - this matches the documented
    // user intent (target a specific session for relay) better than silently
    // dropping the event.
    state.deps.requestHeartbeat(wakeHeartbeatOptions({ sessionKey, agentId }));
  }
  return { ok: true } as const;
}
