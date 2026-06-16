// Wave 21 isolated Gateway E2E proof for audit-only checkpoint visibility obligations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { saveCronStore } from "../cron/store.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";
import { sendWhatsAppMock } from "./test-helpers.runtime-state.js";

const runHeartbeatOnceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<HeartbeatRunResult> => ({ status: "skipped", reason: "quiet-hours" })),
);

vi.mock("../infra/heartbeat-runner.js", () => ({
  runHeartbeatOnce: runHeartbeatOnceMock,
}));

const WAVE21_ROOT =
  process.env.WAVE21_E2E_ROOT ??
  path.join(os.tmpdir(), "openclaw-wave21-isolated-live-gateway-e2e");
const PROOF_PATH = path.join(WAVE21_ROOT, "proof.json");
const STORE_PATH = path.join(WAVE21_ROOT, "cron", "jobs.json");
const PREVIOUS_TMPDIR = process.env.TMPDIR;
const OWNER_SESSION_KEY = "agent:jarvis:whatsapp:direct:+917258067800";

beforeAll(async () => {
  await fs.rm(WAVE21_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  process.env.TMPDIR = WAVE21_ROOT;
});

installGatewayTestHooks({ scope: "suite" });

afterAll(async () => {
  if (PREVIOUS_TMPDIR === undefined) {
    delete process.env.TMPDIR;
    return;
  }
  process.env.TMPDIR = PREVIOUS_TMPDIR;
});

type GatewayRpcResponse<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  ok: boolean;
  payload?: TPayload | null;
  error?: { message?: string; code?: string };
};

type CronJobPayload = {
  id: string;
  name?: string;
  state?: {
    lastRunStatus?: string;
    lastError?: string;
    lastDeliveryStatus?: string;
    checkpointVisibilityObligations?: Array<{
      idempotencyKey?: string;
      status?: string;
      source?: Record<string, unknown>;
      observed?: Record<string, unknown>;
    }>;
  };
};

type CheckpointVisibilityListPayload = {
  obligations: Array<{
    jobId: string;
    jobName?: string;
    obligation: {
      idempotencyKey: string;
      status: string;
      source: Record<string, unknown>;
      observed: Record<string, unknown>;
    };
  }>;
};

function buildCheckpointJob(key: string, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: `wave21 ${key}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: `wave21 checkpoint ${key}` },
    checkpointVisibility: {
      mode: "audit-only",
      idempotencyKey: `wave21:${key}`,
      ownerSessionKey: OWNER_SESSION_KEY,
      ownerAgentId: "jarvis",
      missionId: "M094",
      checkpointKind: "quiet-hours",
      evidenceHash: `sha256:${key}`,
    },
    ...overrides,
  };
}

function expectOk<TPayload extends Record<string, unknown>>(
  response: GatewayRpcResponse<TPayload>,
): TPayload {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  expect(response.payload).toBeTruthy();
  return response.payload as TPayload;
}

function expectRejected(response: GatewayRpcResponse, expectedText: string) {
  expect(response.ok, JSON.stringify(response)).toBe(false);
  expect(response.error?.message ?? "").toContain(expectedText);
}

async function waitForCronFinished(
  ws: Parameters<typeof onceMessage>[0],
  jobId: string,
): Promise<Record<string, unknown>> {
  const message = await onceMessage(
    ws,
    (obj) =>
      obj.type === "event" &&
      obj.event === "cron" &&
      (obj.payload as { action?: unknown; jobId?: unknown } | undefined)?.action === "finished" &&
      (obj.payload as { jobId?: unknown } | undefined)?.jobId === jobId,
    20_000,
  );
  return (message.payload ?? {}) as Record<string, unknown>;
}

async function addCheckpointJob(ws: Parameters<typeof rpcReq>[0], key: string): Promise<string> {
  const created = expectOk<CronJobPayload>(
    await rpcReq(ws, "cron.add", buildCheckpointJob(key), 20_000),
  );
  expect(created.id).toBeTruthy();
  return created.id;
}

async function runCheckpointJob(ws: Parameters<typeof rpcReq>[0], jobId: string) {
  const finished = waitForCronFinished(ws, jobId);
  const run = expectOk(await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000));
  expect(run).toMatchObject({ ok: true, enqueued: true });
  return await finished;
}

async function createAndRunCheckpointJob(
  ws: Parameters<typeof rpcReq>[0],
  key: string,
): Promise<string> {
  const jobId = await addCheckpointJob(ws, key);
  await runCheckpointJob(ws, jobId);
  return jobId;
}

async function closeCheckpoint(ws: Parameters<typeof rpcReq>[0], params: Record<string, unknown>) {
  return await rpcReq(ws, "cron.checkpointVisibility.close", params, 20_000);
}

describe("Wave 21 isolated live Gateway checkpoint visibility E2E", () => {
  test("proves quiet-hours audit-only obligation lifecycle without owner-visible delivery", async () => {
    process.env.OPENCLAW_SKIP_CRON = "0";
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    testState.cronStorePath = STORE_PATH;
    testState.cronEnabled = false;
    testState.sessionConfig = { mainKey: "main" };
    await saveCronStore(STORE_PATH, { version: 1, jobs: [] });

    const started = await startServerWithClient();
    const proof: Record<string, unknown> = {
      root: WAVE21_ROOT,
      storePath: STORE_PATH,
      stateDir: process.env.OPENCLAW_STATE_DIR,
      stateDatabasePath: process.env.OPENCLAW_STATE_DIR
        ? path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite")
        : undefined,
      port: started.port,
      unsupportedPolicyShapesRejected: [],
    };
    try {
      await connectOk(started.ws);

      const primaryJobId = await addCheckpointJob(started.ws, "primary");
      const updated = expectOk<CronJobPayload>(
        await rpcReq(
          started.ws,
          "cron.update",
          { id: primaryJobId, patch: { name: "wave21 primary updated" } },
          20_000,
        ),
      );
      expect(updated.name).toBe("wave21 primary updated");

      const finished = await runCheckpointJob(started.ws, primaryJobId);
      expect(finished).toMatchObject({
        action: "finished",
        jobId: primaryJobId,
        status: "skipped",
        error: "quiet-hours",
        deliveryStatus: "not-requested",
      });

      const primaryJob = expectOk<CronJobPayload>(
        await rpcReq(started.ws, "cron.get", { id: primaryJobId }, 20_000),
      );
      expect(primaryJob.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: "quiet-hours",
        lastDeliveryStatus: "not-requested",
      });
      expect(primaryJob.state?.checkpointVisibilityObligations).toHaveLength(1);
      expect(primaryJob.state?.checkpointVisibilityObligations?.[0]).toMatchObject({
        idempotencyKey: "wave21:primary",
        status: "pending",
        observed: {
          runStatus: "skipped",
          lastError: "quiet-hours",
          deliveryStatus: "not-requested",
        },
        source: {
          sessionTarget: "main",
          wakeMode: "now",
          payloadKind: "systemEvent",
          ownerSessionKey: OWNER_SESSION_KEY,
        },
      });

      const listed = expectOk<CheckpointVisibilityListPayload>(
        await rpcReq(started.ws, "cron.checkpointVisibility.list", { status: "pending" }, 20_000),
      );
      expect(listed.obligations).toHaveLength(1);
      expect(listed.obligations[0]?.jobId).toBe(primaryJobId);
      expect(listed.obligations[0]?.obligation.idempotencyKey).toBe("wave21:primary");

      expectRejected(
        await closeCheckpoint(started.ws, {
          jobId: primaryJobId,
          idempotencyKey: "wave21:primary",
          status: "manual-delivered",
          decidedBy: "sentinel",
          messageId: "wa-test-message",
        }),
        "manual-delivered close requires Jarvis evidence",
      );
      const manualClosed = expectOk(
        await closeCheckpoint(started.ws, {
          jobId: primaryJobId,
          idempotencyKey: "wave21:primary",
          status: "manual-delivered",
          decidedBy: "jarvis",
          messageId: "wa-test-message",
          currentStatusRef: "wave21 isolated transcript",
        }),
      );
      expect(manualClosed.obligation).toMatchObject({ status: "manual-delivered" });

      const suppressedJobId = await createAndRunCheckpointJob(started.ws, "suppressed");
      expectRejected(
        await closeCheckpoint(started.ws, {
          jobId: suppressedJobId,
          idempotencyKey: "wave21:suppressed",
          status: "suppressed",
          decidedBy: "sentinel",
          evidenceHash: "sha256:suppressed-evidence",
        }),
        "suppressed/blocked close requires reason",
      );
      const suppressedClosed = expectOk(
        await closeCheckpoint(started.ws, {
          jobId: suppressedJobId,
          idempotencyKey: "wave21:suppressed",
          status: "suppressed",
          decidedBy: "sentinel",
          reason: "isolated test suppression",
          evidenceHash: "sha256:suppressed-evidence",
        }),
      );
      expect(suppressedClosed.obligation).toMatchObject({ status: "suppressed" });

      const blockedJobId = await createAndRunCheckpointJob(started.ws, "blocked");
      expectRejected(
        await closeCheckpoint(started.ws, {
          jobId: blockedJobId,
          idempotencyKey: "wave21:blocked",
          status: "blocked",
          decidedBy: "sentinel",
          evidenceHash: "sha256:blocked-evidence",
        }),
        "suppressed/blocked close requires reason",
      );
      const blockedClosed = expectOk(
        await closeCheckpoint(started.ws, {
          jobId: blockedJobId,
          idempotencyKey: "wave21:blocked",
          status: "blocked",
          decidedBy: "sentinel",
          reason: "isolated test block",
          evidenceHash: "sha256:blocked-evidence",
        }),
      );
      expect(blockedClosed.obligation).toMatchObject({ status: "blocked" });

      const summaryJobId = await createAndRunCheckpointJob(started.ws, "summary-rejected");
      expectRejected(
        await closeCheckpoint(started.ws, {
          jobId: summaryJobId,
          idempotencyKey: "wave21:summary-rejected",
          status: "summary-delivered",
          decidedBy: "jarvis",
          messageId: "wa-test-message",
        }),
        "invalid cron.checkpointVisibility.close params",
      );

      for (const sessionTarget of ["isolated", "current", "session:wave21"]) {
        const rejected = await rpcReq(
          started.ws,
          "cron.add",
          buildCheckpointJob(`unsupported-${sessionTarget}`, {
            sessionTarget,
            payload: { kind: "agentTurn", message: "blocked unsupported checkpoint" },
          } as Partial<CronJobCreate>),
          20_000,
        );
        expectRejected(rejected, "cron checkpointVisibility is only supported");
        (proof.unsupportedPolicyShapesRejected as string[]).push(sessionTarget);
      }

      expect(sendWhatsAppMock).not.toHaveBeenCalled();
      expect(cronIsolatedRun).not.toHaveBeenCalled();
      expect(runHeartbeatOnceMock).toHaveBeenCalledTimes(4);

      proof.primaryJobId = primaryJobId;
      proof.primaryFinishedEvent = finished;
      proof.primaryJobState = primaryJob.state;
      proof.pendingList = listed;
      proof.closeStatuses = {
        manualDelivered: (manualClosed.obligation as { status?: unknown }).status,
        suppressed: (suppressedClosed.obligation as { status?: unknown }).status,
        blocked: (blockedClosed.obligation as { status?: unknown }).status,
        summaryDeliveredRejected: true,
      };
      proof.noOwnerVisibleDelivery = {
        sendWhatsAppCalls: sendWhatsAppMock.mock.calls.length,
        isolatedAgentRunCalls: cronIsolatedRun.mock.calls.length,
      };
    } finally {
      started.ws.close();
      await started.server.close();
      await fs.writeFile(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");
    }
  }, 60_000);
});
