// Shared error graph/format helpers without the full infra-runtime surface.

/** Stable error code for subagent APIs called outside an authenticated gateway request. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
/** Default message paired with `SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE`. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE =
  "Plugin runtime subagent methods are only available during a gateway request.";

const UNAVAILABLE_SUBAGENT_RUNTIME_FUNCTION_BRAND = Symbol.for(
  "openclaw.pluginRuntime.subagent.unavailableFunction",
);

/** @internal Marks fallback subagent runtime methods that always throw request-scope errors. */
export function markUnavailableSubagentRuntimeFunction<T extends object>(fn: T): T {
  Object.defineProperty(fn, UNAVAILABLE_SUBAGENT_RUNTIME_FUNCTION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return fn;
}

/** Returns true for fallback subagent runtime methods that cannot start workers. */
export function isUnavailableSubagentRuntimeFunction(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as Record<PropertyKey, unknown>)[UNAVAILABLE_SUBAGENT_RUNTIME_FUNCTION_BRAND] === true
  );
}

/** Error thrown when request-scoped plugin runtime APIs are used outside their scope. */
export class RequestScopedSubagentRuntimeError extends Error {
  code = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE;

  constructor(message = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE) {
    super(message);
    this.name = "RequestScopedSubagentRuntimeError";
  }
}

export {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
  readErrorName,
} from "../infra/errors.js";
export { isApprovalNotFoundError } from "../infra/approval-errors.ts";
