// Workboard subagent hooks reconcile worker exits with card protocol state.
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardStore } from "./store.js";
import type { WorkboardCard, WorkboardRunAttempt } from "./types.js";

type WorkboardSubagentEndedEvent = {
  targetSessionKey: string;
  runId?: string;
  reason?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isWorkboardWorkerSessionKey(value: string | undefined): boolean {
  return Boolean(value?.includes("subagent:workboard-"));
}

function cardSessionKey(card: WorkboardCard): string | undefined {
  return normalize(card.sessionKey) ?? normalize(card.execution?.sessionKey);
}

function cardRunId(card: WorkboardCard): string | undefined {
  return normalize(card.runId) ?? normalize(card.execution?.runId);
}

function attemptMatchesSession(
  attempt: WorkboardRunAttempt,
  sessionKey: string | undefined,
): boolean {
  return Boolean(sessionKey && normalize(attempt.sessionKey) === sessionKey);
}

function attemptMatchesRun(attempt: WorkboardRunAttempt, runId: string | undefined): boolean {
  return Boolean(runId && normalize(attempt.runId) === runId);
}

function isActiveWorkerCard(card: WorkboardCard): boolean {
  return (
    card.status === "running" ||
    card.execution?.status === "running" ||
    Boolean(card.metadata?.attempts?.some((attempt) => attempt.status === "running"))
  );
}

function findWorkboardWorkerCard(
  cards: WorkboardCard[],
  event: WorkboardSubagentEndedEvent,
): WorkboardCard | undefined {
  const sessionKey = normalize(event.targetSessionKey);
  const runId = normalize(event.runId);
  if (!sessionKey && !runId) {
    return undefined;
  }
  return cards.find((card) => {
    if (!isActiveWorkerCard(card)) {
      return false;
    }
    const attempts = card.metadata?.attempts ?? [];
    const matchedSession =
      Boolean(sessionKey && cardSessionKey(card) === sessionKey) ||
      attempts.some((attempt) => attemptMatchesSession(attempt, sessionKey));
    const matchedRun =
      Boolean(runId && cardRunId(card) === runId) ||
      attempts.some((attempt) => attemptMatchesRun(attempt, runId));
    if (!matchedSession && !matchedRun) {
      return false;
    }
    const workerSessionKey =
      sessionKey ??
      cardSessionKey(card) ??
      normalize(attempts.find((attempt) => attempt.runId === runId)?.sessionKey);
    return isWorkboardWorkerSessionKey(workerSessionKey);
  });
}

function formatProtocolViolationDetail(event: WorkboardSubagentEndedEvent): string {
  const reason = normalize(event.error) ?? normalize(event.reason) ?? event.outcome;
  return reason
    ? `Worker stopped before calling workboard_complete or workboard_block: ${reason}.`
    : "Worker stopped without calling workboard_complete or workboard_block.";
}

export async function handleWorkboardSubagentEnded(
  event: WorkboardSubagentEndedEvent,
  store: WorkboardStore,
): Promise<WorkboardCard | undefined> {
  const card = findWorkboardWorkerCard(await store.list(), event);
  if (!card) {
    return undefined;
  }
  return await store.recordProtocolViolation(card.id, {
    detail: formatProtocolViolationDetail(event),
    sessionKey: normalize(event.targetSessionKey),
    runId: normalize(event.runId),
  });
}

export function registerWorkboardSubagentHooks(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}): void {
  params.api.on("subagent_ended", async (event) => {
    await handleWorkboardSubagentEnded(event, params.store);
  });
}
