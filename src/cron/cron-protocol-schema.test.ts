// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronCheckpointVisibilityCloseParams,
} from "../../packages/gateway-protocol/src/index.js";
import { CronJobStateSchema } from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  properties?: Record<string, unknown>;
  deprecated?: boolean;
};

describe("cron protocol schema", () => {
  it("marks the legacy lastStatus alias deprecated", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastStatus = properties.lastStatus as SchemaLike | undefined;
    if (!lastStatus) {
      throw new Error("expected legacy lastStatus schema alias");
    }
    expect(lastStatus.deprecated).toBe(true);
  });

  it("exposes failure-notification delivery state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.lastFailureNotificationDelivered).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryStatus).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryError).toBeDefined();
  });

  it("exposes checkpoint visibility obligations without summary-delivered close state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.checkpointVisibilityObligations).toBeDefined();
    expect(
      validateCronCheckpointVisibilityCloseParams({
        idempotencyKey: "wave17:checkpoint",
        status: "summary-delivered",
        decidedBy: "jarvis",
        messageId: "wa-msg-1",
      }),
    ).toBe(false);
  });

  it("accepts default-off opt-in checkpoint visibility config on cron.add", () => {
    expect(
      validateCronAddParams({
        name: "checkpoint",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "checkpoint" },
        checkpointVisibility: {
          mode: "audit-only",
          idempotencyKey: "wave17:checkpoint",
          ownerSessionKey: "agent:jarvis:whatsapp:direct:+917258067800",
        },
      }),
    ).toBe(true);
  });
});
