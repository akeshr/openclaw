// Quiet-hours checkpoint visibility tests cover Phase 1 audit-only obligations.
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { CronService } from "./service.js";
import type { CronServiceDeps } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-quiet-hours-visibility-",
});
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildMainCheckpointJob(overrides: Partial<CronAddInput> = {}): CronAddInput {
  return {
    name: "quiet-hours checkpoint",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "checkpoint" },
    checkpointVisibility: {
      mode: "audit-only",
      idempotencyKey: "wave17:checkpoint",
      ownerSessionKey: "agent:jarvis:whatsapp:direct:+917258067800",
      ownerAgentId: "jarvis",
      missionId: "M094",
      checkpointKind: "quiet-hours",
      evidenceHash: "sha256:plan",
    },
    ...overrides,
  };
}

async function createCron(params?: {
  runHeartbeatOnce?: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
}) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const runHeartbeatOnce =
    params?.runHeartbeatOnce ??
    vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        status: "skipped",
        reason: "quiet-hours",
      }),
    );
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeat,
    runHeartbeatOnce,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
  });
  await cron.start();
  return { cron, store, enqueueSystemEvent, requestHeartbeat, runHeartbeatOnce };
}

async function stopCron(cron: CronService, store: { cleanup: () => Promise<void> }) {
  cron.stop();
  await store.cleanup();
}

describe("quiet-hours checkpoint visibility obligations", () => {
  it("records one pending obligation for an opt-in quiet-hours main checkpoint", async () => {
    const { cron, store, enqueueSystemEvent, requestHeartbeat, runHeartbeatOnce } =
      await createCron();
    try {
      const job = await cron.add(buildMainCheckpointJob());

      await cron.run(job.id, "force");
      await cron.run(job.id, "force");

      const [updated] = await cron.list({ includeDisabled: true });
      const obligations = await cron.listCheckpointVisibilityObligations({
        jobId: job.id,
        status: "pending",
      });
      expect(updated?.state.lastRunStatus).toBe("skipped");
      expect(updated?.state.lastError).toBe("quiet-hours");
      expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
      expect(obligations).toHaveLength(1);
      expect(obligations[0]?.obligation.status).toBe("pending");
      expect(obligations[0]?.obligation.source.ownerSessionKey).toBe(
        "agent:jarvis:whatsapp:direct:+917258067800",
      );
      expect(obligations[0]?.obligation.source.sessionTarget).toBe("main");
      expect(obligations[0]?.obligation.source.wakeMode).toBe("now");
      expect(obligations[0]?.obligation.source.payloadKind).toBe("systemEvent");
      expect(obligations[0]?.obligation.observed).toEqual({
        runStatus: "skipped",
        lastError: "quiet-hours",
        deliveryStatus: "not-requested",
      });
      expect(runHeartbeatOnce).toHaveBeenCalledTimes(2);
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      await stopCron(cron, store);
    }
  });

  it("does not record obligations when the job has no explicit opt-in", async () => {
    const { cron, store } = await createCron();
    try {
      const job = await cron.add({
        ...buildMainCheckpointJob(),
        checkpointVisibility: undefined,
      });

      await cron.run(job.id, "force");

      expect(await cron.listCheckpointVisibilityObligations()).toEqual([]);
    } finally {
      await stopCron(cron, store);
    }
  });

  it("rejects unsupported checkpoint visibility targets", async () => {
    const { cron, store } = await createCron();
    try {
      await expect(
        cron.add({
          ...buildMainCheckpointJob(),
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "checkpoint" },
        }),
      ).rejects.toThrow(
        'cron checkpointVisibility is only supported for main wakeMode="now" systemEvent jobs',
      );
      await expect(
        cron.add({
          ...buildMainCheckpointJob(),
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "checkpoint" },
        }),
      ).rejects.toThrow(
        'cron checkpointVisibility is only supported for main wakeMode="now" systemEvent jobs',
      );
      await expect(
        cron.add({
          ...buildMainCheckpointJob(),
          sessionTarget: "session:abc",
          payload: { kind: "agentTurn", message: "checkpoint" },
        }),
      ).rejects.toThrow(
        'cron checkpointVisibility is only supported for main wakeMode="now" systemEvent jobs',
      );
    } finally {
      await stopCron(cron, store);
    }
  });

  it("closes obligations only with evidence-backed Phase 1 states", async () => {
    const { cron, store } = await createCron();
    try {
      const job = await cron.add(buildMainCheckpointJob());
      await cron.run(job.id, "force");

      await expect(
        cron.closeCheckpointVisibilityObligation({
          jobId: job.id,
          idempotencyKey: "wave17:checkpoint",
          status: "manual-delivered",
          decidedBy: "sentinel",
          messageId: "wa-msg-1",
        }),
      ).rejects.toThrow("manual-delivered close requires Jarvis evidence");
      await expect(
        cron.closeCheckpointVisibilityObligation({
          jobId: job.id,
          idempotencyKey: "wave17:checkpoint",
          status: "suppressed",
          decidedBy: "sentinel",
          evidenceHash: "sha256:decision",
        }),
      ).rejects.toThrow("suppressed/blocked close requires reason");

      const closed = await cron.closeCheckpointVisibilityObligation({
        jobId: job.id,
        idempotencyKey: "wave17:checkpoint",
        status: "manual-delivered",
        decidedBy: "jarvis",
        messageId: "wa-msg-1",
        currentStatusRef: "operator transcript",
      });
      expect(closed.obligation.status).toBe("manual-delivered");
      expect(closed.obligation.decision).toMatchObject({
        status: "manual-delivered",
        decidedBy: "jarvis",
        messageId: "wa-msg-1",
      });

      const repeat = await cron.closeCheckpointVisibilityObligation({
        jobId: job.id,
        idempotencyKey: "wave17:checkpoint",
        status: "blocked",
        decidedBy: "sentinel",
        reason: "not enough proof",
        evidenceHash: "sha256:block",
      });
      expect(repeat.obligation.status).toBe("manual-delivered");
    } finally {
      await stopCron(cron, store);
    }
  });
});
