// Workboard tests cover lifecycle hook registration.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardLifecycleHooks } from "./lifecycle.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("Workboard lifecycle hooks", () => {
  it("registers subagent_ended reconciliation for Workboard-owned subagents", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Lifecycle worker",
      status: "running",
      sessionKey: "agent:main:subagent:workboard-default-card-1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
      metadata: {
        attempts: [
          {
            id: "run-1",
            status: "running",
            startedAt: 10,
            sessionKey: "agent:main:subagent:workboard-default-card-1",
            runId: "run-1",
          },
        ],
      },
    });
    const on = vi.fn();
    registerWorkboardLifecycleHooks({ api: { on } as unknown as OpenClawPluginApi, store });

    expect(on).toHaveBeenCalledWith("subagent_ended", expect.any(Function), { priority: 25 });
    const handler = on.mock.calls[0]?.[1] as (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    await handler(
      {
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:workboard-default-card-1",
        runId: "run-1",
        outcome: "ok",
        reason: "subagent-complete",
        endedAt: 20,
      },
      {},
    );

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: {
        workerLogs: [expect.objectContaining({ runId: "run-1" })],
        workerProtocol: {
          state: "violated",
          detail: "Worker exited without calling workboard_complete or workboard_block.",
        },
        attempts: [expect.objectContaining({ status: "blocked", endedAt: 20 })],
      },
    });
  });
});
