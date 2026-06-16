/**
 * Tool-surface policy for runs that must not expose owner/source-visible sends.
 */
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

export type VisibleSendPolicy = "allow" | "deny";

const VISIBLE_SEND_TOOL_NAMES = new Set(["message", "sessions_send"]);

export function visibleSendPolicyDenies(policy?: VisibleSendPolicy): boolean {
  return policy === "deny";
}

export function isVisibleSendToolName(toolName: string): boolean {
  return VISIBLE_SEND_TOOL_NAMES.has(normalizeToolName(toolName));
}

export function filterVisibleSendTools<TTool extends { name: string }>(
  tools: readonly TTool[],
  policy?: VisibleSendPolicy,
): TTool[] {
  if (!visibleSendPolicyDenies(policy)) {
    return [...tools];
  }
  return tools.filter((tool) => !isVisibleSendToolName(tool.name));
}

export function filterVisibleSendToolAllowlist(
  toolsAllow: string[] | undefined,
  policy?: VisibleSendPolicy,
): string[] | undefined {
  if (!visibleSendPolicyDenies(policy) || toolsAllow === undefined) {
    return toolsAllow;
  }
  if (toolsAllow.length === 0) {
    return toolsAllow;
  }
  const expanded = expandToolGroups(toolsAllow);
  if (expanded.some((toolName) => normalizeToolName(toolName) === "*")) {
    return toolsAllow;
  }
  return expanded.filter((toolName) => !isVisibleSendToolName(toolName));
}
