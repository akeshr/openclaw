// Cron wake tests cover waking the scheduler for due jobs and service changes.
import { describe, expect, it, vi } from "vitest";
import { wake } from "./wake.js";

function createState() {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const nowMs = vi.fn(() => 0);
  return {
    state: {
      deps: {
        enqueueSystemEvent,
        requestHeartbeat,
        nowMs,
      },
    } as unknown as Parameters<typeof wake>[0],
    enqueueSystemEvent,
    requestHeartbeat,
    nowMs,
  };
}

describe("wake (cron timer)", () => {
  it("returns ok:false on empty text without enqueueing or waking", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(await wake(state, { mode: "now", text: "   " })).toEqual({ ok: false });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("enqueues without sessionKey when omitted", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(await wake(state, { mode: "now", text: "ping" })).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });

  it("threads sessionKey to both enqueue and heartbeat on mode=now", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", {
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:telegram:dm:42",
    });
  });

  it("threads sessionKey to enqueue and fires a targeted immediate wake on mode=next-heartbeat", async () => {
    // next-heartbeat + sessionKey collapses to immediate-targeted behavior:
    // the regularly-scheduled heartbeat fires for agent-main and never peeks
    // a non-main session queue, and an "event"-intent wake is not retried by
    // the heartbeat runner. Targeted immediate is the only reliable path.
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      await wake(state, {
        mode: "next-heartbeat",
        text: "ping",
        sessionKey: "agent:main:slack:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", {
      sessionKey: "agent:main:slack:42",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:slack:42",
    });
  });

  it("does not fire a wake on mode=next-heartbeat when no sessionKey is supplied", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("treats whitespace-only sessionKey as omitted", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    await wake(state, { mode: "now", text: "ping", sessionKey: "   " });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("ping", undefined);
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });

  it("rejects subagent sessionKey targets without enqueueing or waking", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:subagent:worker",
      }),
    ).toEqual({ ok: false, reason: "unwakeable-session-key" });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("returns ok:false when the event queue rejects the wake", async () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = createState();
    enqueueSystemEvent.mockReturnValueOnce({ accepted: false });

    expect(await wake(state, { mode: "now", text: "ping" })).toEqual({
      ok: false,
      reason: "event-not-queued",
    });
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("returns ok:true only after a wake-now heartbeat run succeeds", async () => {
    const { state, requestHeartbeat } = createState();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 12 }));
    state.deps.runHeartbeatOnce = runHeartbeatOnce;

    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:whatsapp:direct:+1",
      }),
    ).toEqual({ ok: true, heartbeat: { status: "ran", durationMs: 12 } });
    expect(runHeartbeatOnce).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:whatsapp:direct:+1",
    });
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("retries a temporarily busy heartbeat before reporting wake success", async () => {
    const { state, requestHeartbeat } = createState();
    let now = 0;
    state.deps.nowMs = vi.fn(() => {
      now += 10;
      return now;
    });
    state.deps.wakeNowHeartbeatBusyMaxWaitMs = 100;
    state.deps.wakeNowHeartbeatBusyRetryDelayMs = 0;
    state.deps.runHeartbeatOnce = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped" as const, reason: "requests-in-flight" })
      .mockResolvedValueOnce({ status: "ran" as const, durationMs: 12 });

    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:whatsapp:direct:+1",
      }),
    ).toEqual({ ok: true, heartbeat: { status: "ran", durationMs: 12 } });
    expect(state.deps.runHeartbeatOnce).toHaveBeenCalledTimes(2);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("returns ok:false and re-arms the wake when heartbeat is busy", async () => {
    const { state, requestHeartbeat } = createState();
    let now = 0;
    state.deps.nowMs = vi.fn(() => {
      now += 10;
      return now;
    });
    state.deps.wakeNowHeartbeatBusyMaxWaitMs = 1;
    state.deps.wakeNowHeartbeatBusyRetryDelayMs = 0;
    state.deps.runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "requests-in-flight",
    }));

    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:whatsapp:direct:+1",
      }),
    ).toEqual({
      ok: false,
      reason: "heartbeat-skipped",
      heartbeat: { status: "skipped", reason: "requests-in-flight" },
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:whatsapp:direct:+1",
    });
  });

  it("returns ok:false when the immediate heartbeat fails", async () => {
    const { state, requestHeartbeat } = createState();
    state.deps.runHeartbeatOnce = vi.fn(async () => ({
      status: "failed" as const,
      reason: "not ready",
    }));

    expect(await wake(state, { mode: "now", text: "ping" })).toEqual({
      ok: false,
      reason: "heartbeat-failed",
      heartbeat: { status: "failed", reason: "not ready" },
    });
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
