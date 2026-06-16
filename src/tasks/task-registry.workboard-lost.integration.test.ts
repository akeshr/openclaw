// Deterministic proof that lost task maintenance drives Workboard reconciliation.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../extensions/workboard/api.js";
import {
  WorkboardStore,
  type PersistedWorkboardCard,
  type WorkboardKeyedStore,
} from "../../extensions/workboard/src/store.js";
import { registerWorkboardSubagentHooks } from "../../extensions/workboard/src/subagent-hooks.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import { createHookRunner } from "../plugins/hooks.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  resetTaskRegistryForTests,
  setTaskTimingById,
} from "./task-registry.js";
import {
  configureTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  resetTaskRegistryRuntimeForTests,
  type TaskRegistryStore,
} from "./task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

function createTaskRegistryMemoryStore(): TaskRegistryStore {
  const tasks = new Map<string, TaskRecord>();
  const deliveryStates = new Map<string, TaskDeliveryState>();
  return {
    loadSnapshot: () => ({
      tasks: new Map(tasks),
      deliveryStates: new Map(deliveryStates),
    }),
    saveSnapshot: (snapshot) => {
      tasks.clear();
      deliveryStates.clear();
      for (const [taskId, task] of snapshot.tasks.entries()) {
        tasks.set(taskId, task);
      }
      for (const [taskId, state] of snapshot.deliveryStates.entries()) {
        deliveryStates.set(taskId, state);
      }
    },
    upsertTaskWithDeliveryState: ({ task, deliveryState }) => {
      tasks.set(task.taskId, task);
      if (deliveryState) {
        deliveryStates.set(deliveryState.taskId, deliveryState);
      } else {
        deliveryStates.delete(task.taskId);
      }
    },
    upsertTask: (task) => {
      tasks.set(task.taskId, task);
    },
    deleteTaskWithDeliveryState: (taskId) => {
      tasks.delete(taskId);
      deliveryStates.delete(taskId);
    },
    deleteTask: (taskId) => {
      tasks.delete(taskId);
    },
    upsertDeliveryState: (state) => {
      deliveryStates.set(state.taskId, state);
    },
    deleteDeliveryState: (taskId) => {
      deliveryStates.delete(taskId);
    },
    close: () => {},
  };
}

function createWorkboardMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
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

async function withTaskRegistryState<T>(run: () => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-workboard-lost-task-" }, async (root) => {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryRuntime({ store: createTaskRegistryMemoryStore() });
      try {
        return await run();
      } finally {
        resetTaskRegistryForTests({ persist: false });
      }
    });
  });
}

function expectTaskFields(record: unknown, expected: Record<string, unknown>): void {
  if (!record || typeof record !== "object") {
    throw new Error("expected task record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

describe("task registry lost Workboard worker reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTaskRegistryMaintenanceRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskRegistryRuntimeForTests();
  });

  it("marks a missing Workboard-backed task lost and blocks the card through subagent_ended", async () => {
    await withTaskRegistryState(async () => {
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });

      const childSessionKey = "agent:marshal:subagent:workboard-m085-lost-worker-proof";
      const runId = "run-workboard-lost-reconcile";
      const startedAt = Date.now() - 10 * 60_000;
      const workboardStore = new WorkboardStore(createWorkboardMemoryStore());
      const card = await workboardStore.create({
        title: "Lost worker deterministic proof",
        status: "running",
        sessionKey: childSessionKey,
        runId,
        execution: {
          id: "exec-workboard-lost-reconcile",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "default",
          sessionKey: childSessionKey,
          runId,
          startedAt,
          updatedAt: startedAt,
        },
        metadata: {
          attempts: [
            {
              id: runId,
              status: "running",
              startedAt,
              sessionKey: childSessionKey,
              runId,
            },
          ],
        },
      });

      const registry = createMockPluginRegistry([]);
      registerWorkboardSubagentHooks({
        api: {
          on: (hookName, handler, options) => {
            addTestHook({
              registry,
              pluginId: "workboard",
              hookName,
              handler,
              priority: options?.priority,
            });
          },
        } as OpenClawPluginApi,
        store: workboardStore,
      });
      vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(createHookRunner(registry));

      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        sourceId: runId,
        task: "Workboard worker",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: Date.now() - 10 * 60_000,
      });

      await runTaskRegistryMaintenance();

      expectTaskFields(getTaskById(task.taskId), {
        status: "lost",
        error: "backing session missing",
      });
      await expect(workboardStore.get(card.id)).resolves.toMatchObject({
        id: card.id,
        status: "blocked",
        execution: { status: "blocked" },
        metadata: {
          attempts: [
            expect.objectContaining({
              status: "blocked",
              error:
                "Worker stopped before calling workboard_complete or workboard_block: backing session missing.",
            }),
          ],
          workerProtocol: {
            state: "violated",
            detail:
              "Worker stopped before calling workboard_complete or workboard_block: backing session missing.",
          },
          workerLogs: [expect.objectContaining({ level: "error", runId })],
        },
      });
    });
  });
});
