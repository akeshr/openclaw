// Workboard plugin module reconciles subagent lifecycle hooks into card state.
import type {
  PluginHookSubagentContext,
  PluginHookSubagentEndedEvent,
} from "openclaw/plugin-sdk/types";
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardStore } from "./store.js";

export function registerWorkboardLifecycleHooks(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}) {
  params.api.on(
    "subagent_ended",
    async (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => {
      if (event.targetKind !== "subagent") {
        return;
      }
      await params.store.reconcileSubagentEnded({
        targetSessionKey: event.targetSessionKey,
        runId: event.runId ?? ctx.runId,
        outcome: event.outcome,
        reason: event.reason,
        error: event.error,
        endedAt: event.endedAt,
      });
    },
    { priority: 25 },
  );
}
