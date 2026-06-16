/** Audit-only quiet-hours checkpoint visibility obligation helpers. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createCronExecutionId } from "./run-id.js";
import type {
  CronCheckpointVisibilityCloseInput,
  CronCheckpointVisibilityObligation,
  CronCheckpointVisibilityPolicy,
  CronCheckpointVisibilityStatus,
  CronJob,
  CronRunStatus,
} from "./types.js";

type RecordableQuietHoursRun = {
  status: CronRunStatus;
  error?: string;
  sessionKey?: string;
  startedAt: number;
  endedAt: number;
};

export type CronCheckpointVisibilityListOptions = {
  jobId?: string;
  status?: CronCheckpointVisibilityStatus;
  idempotencyKey?: string;
};

export type CronCheckpointVisibilityListEntry = {
  jobId: string;
  jobName?: string;
  obligation: CronCheckpointVisibilityObligation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringField(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function normalizeSupersession(value: unknown): CronCheckpointVisibilityCloseInput["supersededBy"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const messageId = normalizeStringField(value.messageId);
  const reportPath = normalizeStringField(value.reportPath);
  const evidenceHash = normalizeStringField(value.evidenceHash);
  const wave = normalizeStringField(value.wave);
  if (!messageId && !reportPath && !evidenceHash && !wave) {
    return undefined;
  }
  return {
    ...(messageId ? { messageId } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(evidenceHash ? { evidenceHash } : {}),
    ...(wave ? { wave } : {}),
  };
}

function normalizeEvidence(
  raw: Record<string, unknown>,
): Omit<CronCheckpointVisibilityCloseInput, "idempotencyKey" | "jobId" | "status"> {
  const decidedBy = normalizeStringField(raw.decidedBy);
  if (decidedBy !== "jarvis" && decidedBy !== "sentinel") {
    throw new Error('checkpoint visibility close requires decidedBy="jarvis" or "sentinel"');
  }
  const reason = normalizeStringField(raw.reason);
  const messageId = normalizeStringField(raw.messageId);
  const reportPath = normalizeStringField(raw.reportPath);
  const evidenceHash = normalizeStringField(raw.evidenceHash);
  const currentStatusRef = normalizeStringField(raw.currentStatusRef);
  const supersededBy = normalizeSupersession(raw.supersededBy);
  return {
    decidedBy,
    ...(reason ? { reason } : {}),
    ...(messageId ? { messageId } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(evidenceHash ? { evidenceHash } : {}),
    ...(currentStatusRef ? { currentStatusRef } : {}),
    ...(supersededBy ? { supersededBy } : {}),
  };
}

function hasCloseEvidence(input: CronCheckpointVisibilityCloseInput): boolean {
  return Boolean(
    normalizeStringField(input.messageId) ||
    normalizeStringField(input.reportPath) ||
    normalizeStringField(input.evidenceHash) ||
    normalizeStringField(input.currentStatusRef) ||
    normalizeStringField(input.supersededBy?.messageId) ||
    normalizeStringField(input.supersededBy?.reportPath) ||
    normalizeStringField(input.supersededBy?.evidenceHash),
  );
}

function normalizeCheckpointVisibilityStatus(value: unknown): CronCheckpointVisibilityStatus {
  if (
    value === "pending" ||
    value === "manual-delivered" ||
    value === "suppressed" ||
    value === "blocked"
  ) {
    return value;
  }
  throw new Error(
    'checkpoint visibility status must be "pending", "manual-delivered", "suppressed", or "blocked"',
  );
}

export function normalizeCronCheckpointVisibilityPolicy(
  value: unknown,
): CronCheckpointVisibilityPolicy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("cron checkpointVisibility must be an object");
  }
  const mode = normalizeStringField(value.mode);
  if (mode !== "audit-only") {
    throw new Error('cron checkpointVisibility.mode must be "audit-only"');
  }
  const idempotencyKey = normalizeStringField(value.idempotencyKey);
  if (!idempotencyKey) {
    throw new Error("cron checkpointVisibility.idempotencyKey is required");
  }
  const ownerSessionKey = normalizeStringField(value.ownerSessionKey);
  if (!ownerSessionKey || ownerSessionKey === "last") {
    throw new Error("cron checkpointVisibility.ownerSessionKey must be an explicit session key");
  }
  const ownerAgentId = normalizeStringField(value.ownerAgentId);
  const missionId = normalizeStringField(value.missionId);
  const checkpointKind = normalizeStringField(value.checkpointKind);
  const evidenceHash = normalizeStringField(value.evidenceHash);
  return {
    mode,
    idempotencyKey,
    ownerSessionKey,
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(missionId ? { missionId } : {}),
    ...(checkpointKind ? { checkpointKind } : {}),
    ...(evidenceHash ? { evidenceHash } : {}),
  };
}

export function normalizeCronCheckpointVisibilityCloseInput(
  value: unknown,
): CronCheckpointVisibilityCloseInput {
  if (!isRecord(value)) {
    throw new Error("checkpoint visibility close input must be an object");
  }
  const idempotencyKey = normalizeStringField(value.idempotencyKey);
  if (!idempotencyKey) {
    throw new Error("checkpoint visibility close requires idempotencyKey");
  }
  const status = normalizeCheckpointVisibilityStatus(value.status);
  if (status === "pending") {
    throw new Error("checkpoint visibility close cannot set pending status");
  }
  const evidence = normalizeEvidence(value);
  const jobId = normalizeStringField(value.jobId);
  const input: CronCheckpointVisibilityCloseInput = {
    idempotencyKey,
    status,
    ...evidence,
    ...(jobId ? { jobId } : {}),
  };
  assertCronCheckpointVisibilityCloseInput(input);
  return input;
}

export function assertCronCheckpointVisibilityPolicySupported(
  job: Pick<CronJob, "checkpointVisibility" | "sessionTarget" | "wakeMode" | "payload">,
): void {
  if (!job.checkpointVisibility) {
    return;
  }
  normalizeCronCheckpointVisibilityPolicy(job.checkpointVisibility);
  if (
    job.sessionTarget !== "main" ||
    job.wakeMode !== "now" ||
    job.payload.kind !== "systemEvent"
  ) {
    throw new Error(
      'cron checkpointVisibility is only supported for main wakeMode="now" systemEvent jobs',
    );
  }
}

function payloadHash(job: Pick<CronJob, "payload">): string {
  return crypto.createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
}

function isQuietHoursNotRequestedCheckpoint(params: {
  job: CronJob;
  result: RecordableQuietHoursRun;
}): boolean {
  return (
    Boolean(params.job.checkpointVisibility) &&
    params.result.status === "skipped" &&
    params.result.error === "quiet-hours" &&
    params.job.state.lastDeliveryStatus === "not-requested" &&
    params.job.sessionTarget === "main" &&
    params.job.wakeMode === "now" &&
    params.job.payload.kind === "systemEvent"
  );
}

function createPendingObligation(params: {
  job: CronJob;
  policy: CronCheckpointVisibilityPolicy;
  result: RecordableQuietHoursRun;
  nowMs: number;
}): CronCheckpointVisibilityObligation {
  return {
    idempotencyKey: params.policy.idempotencyKey,
    status: "pending",
    source: {
      jobId: params.job.id,
      ...(params.job.name ? { jobName: params.job.name } : {}),
      runId: createCronExecutionId(params.job.id, params.result.startedAt),
      ...(typeof params.job.state.nextRunAtMs === "number"
        ? { scheduleAtMs: params.job.state.nextRunAtMs }
        : {}),
      runAtMs: params.result.startedAt,
      sessionTarget: "main",
      wakeMode: "now",
      payloadKind: "systemEvent",
      payloadHash: payloadHash(params.job),
      ...(params.result.sessionKey ? { targetSessionKey: params.result.sessionKey } : {}),
      ownerSessionKey: params.policy.ownerSessionKey,
      ...(params.policy.ownerAgentId ? { ownerAgentId: params.policy.ownerAgentId } : {}),
      ...(params.policy.missionId ? { missionId: params.policy.missionId } : {}),
      ...(params.policy.checkpointKind ? { checkpointKind: params.policy.checkpointKind } : {}),
      ...(params.policy.evidenceHash ? { evidenceHash: params.policy.evidenceHash } : {}),
    },
    observed: {
      runStatus: "skipped",
      lastError: "quiet-hours",
      deliveryStatus: "not-requested",
    },
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
  };
}

export function maybeRecordCronCheckpointVisibilityObligation(params: {
  job: CronJob;
  result: RecordableQuietHoursRun;
  nowMs: number;
}): boolean {
  if (!isQuietHoursNotRequestedCheckpoint(params)) {
    return false;
  }
  const policy = normalizeCronCheckpointVisibilityPolicy(params.job.checkpointVisibility);
  if (!policy) {
    return false;
  }
  const obligations = params.job.state.checkpointVisibilityObligations ?? [];
  const existingIndex = obligations.findIndex(
    (entry) => entry.idempotencyKey === policy.idempotencyKey,
  );
  if (existingIndex >= 0) {
    const existing = obligations[existingIndex];
    if (!existing || existing.status !== "pending") {
      return false;
    }
    obligations[existingIndex] = {
      ...existing,
      updatedAtMs: params.nowMs,
    };
    params.job.state.checkpointVisibilityObligations = obligations;
    return true;
  }
  params.job.state.checkpointVisibilityObligations = [
    ...obligations,
    createPendingObligation({ ...params, policy }),
  ];
  return true;
}

export function listCronCheckpointVisibilityObligations(
  jobs: readonly CronJob[],
  opts?: CronCheckpointVisibilityListOptions,
): CronCheckpointVisibilityListEntry[] {
  const entries: CronCheckpointVisibilityListEntry[] = [];
  for (const job of jobs) {
    if (opts?.jobId && job.id !== opts.jobId) {
      continue;
    }
    for (const obligation of job.state.checkpointVisibilityObligations ?? []) {
      if (opts?.status && obligation.status !== opts.status) {
        continue;
      }
      if (opts?.idempotencyKey && obligation.idempotencyKey !== opts.idempotencyKey) {
        continue;
      }
      entries.push({
        jobId: job.id,
        ...(job.name ? { jobName: job.name } : {}),
        obligation,
      });
    }
  }
  return entries;
}

export function assertCronCheckpointVisibilityCloseInput(
  input: CronCheckpointVisibilityCloseInput,
): void {
  if (input.status === "manual-delivered" && input.decidedBy !== "jarvis") {
    throw new Error("checkpoint visibility manual-delivered close requires Jarvis evidence");
  }
  if (!hasCloseEvidence(input)) {
    throw new Error("checkpoint visibility close requires messageId, reportPath, or evidenceHash");
  }
  if ((input.status === "suppressed" || input.status === "blocked") && !input.reason?.trim()) {
    throw new Error("checkpoint visibility suppressed/blocked close requires reason");
  }
}

export function closeCronCheckpointVisibilityObligation(params: {
  job: CronJob;
  input: CronCheckpointVisibilityCloseInput;
  nowMs: number;
}): CronCheckpointVisibilityObligation {
  assertCronCheckpointVisibilityCloseInput(params.input);
  const obligations = params.job.state.checkpointVisibilityObligations ?? [];
  const index = obligations.findIndex(
    (entry) => entry.idempotencyKey === params.input.idempotencyKey,
  );
  if (index < 0) {
    throw new Error(`unknown checkpoint visibility obligation: ${params.input.idempotencyKey}`);
  }
  const existing = obligations[index];
  if (!existing) {
    throw new Error(`unknown checkpoint visibility obligation: ${params.input.idempotencyKey}`);
  }
  if (existing.status !== "pending") {
    return existing;
  }
  if (!existing.source.ownerSessionKey) {
    throw new Error("checkpoint visibility obligation has no explicit owner session target");
  }
  const updated: CronCheckpointVisibilityObligation = {
    ...existing,
    status: params.input.status,
    decision: {
      status: params.input.status,
      decidedBy: params.input.decidedBy,
      atMs: params.nowMs,
      ...(params.input.reason ? { reason: params.input.reason } : {}),
      ...(params.input.messageId ? { messageId: params.input.messageId } : {}),
      ...(params.input.reportPath ? { reportPath: params.input.reportPath } : {}),
      ...(params.input.evidenceHash ? { evidenceHash: params.input.evidenceHash } : {}),
      ...(params.input.currentStatusRef ? { currentStatusRef: params.input.currentStatusRef } : {}),
    },
    ...(params.input.supersededBy ? { supersededBy: params.input.supersededBy } : {}),
    updatedAtMs: params.nowMs,
  };
  obligations[index] = updated;
  params.job.state.checkpointVisibilityObligations = obligations;
  return updated;
}
