---
name: taskflow
description: "Manage durable wait/resume flows with owner context, state, child tasks, and revision-safe continuation."
metadata: { "openclaw": { "emoji": "🪝" } }
---

# TaskFlow

Use when one managed job must persist across prompts, runs, waits, restarts, or
child tasks.

TaskFlow is a durable wait/resume primitive. It is not the whole Mission Loop,
not a Workboard ledger, not worker-start proof, not a notification cursor, and
not release authority.

## What TaskFlow Owns

- flow id and owner session/requester context;
- `currentStep`;
- `stateJson` as the persisted state bag;
- `waitJson` and blocked/waiting reason;
- linked child tasks;
- revision-checked mutations;
- terminal state: finished, failed, cancelled, or blocked.

It does not own business logic, branching policy, Workboard dispatch/run proof,
notification cursor handling, or Mission Loop release posture.

## Composition

When composed with Mission Loop or Workboard:

- Mission Loop owns outcome, owners, gates, proof, release posture, and next
  action.
- TaskFlow owns managed state and revision-safe continuation.
- Workboard owns visible cards, dependencies, dispatch, runs, proof, and
  notification cursors.
- Sessions/subagents execute work; tasks/task registry record execution.
- Notifications/cron wake a consumer; they do not resume a flow by themselves.

Link ids deliberately. Store `flowId` on the Workboard side or store
`boardId`/`cardId`/`sessionKey` in `stateJson`. Source-read both sides before
claiming resume or terminal proof.

## Runtime Shape

Canonical runtime entrypoint:

- `api.runtime.tasks.managedFlows`
- `api.runtime.tasks.flow` may exist as a compatibility alias.
- `api.runtime.taskFlow` may exist as a compatibility alias.

Bind from trusted context:

- `api.runtime.tasks.managedFlows.fromToolContext(ctx)`
- `api.runtime.tasks.managedFlows.bindSession({ sessionKey, requesterOrigin })`

Managed lifecycle:

1. `createManaged(...)`
2. `runTask(...)` when TaskFlow owns child task linkage.
3. `setWaiting(...)` when waiting on a person/system/event.
4. `resume(...)` when source-read wake evidence allows continuation.
5. `finish(...)`, `fail(...)`, `requestCancel(...)`, or `cancel(...)`.

Use `runTask(...)` instead of manually creating detached work when the child
task should belong to the flow.

## Operating Rules

- Store only the minimum state needed to resume.
- Every mutation after creation is revision-checked. Carry forward the latest
  revision after each successful mutation.
- Use `stateJson`, not a nonexistent output append API, for persisted state.
- Keep decision logic in the caller/controller; TaskFlow stores state and links.
- Treat one-task mirrored flows as runtime-created execution records unless the
  assignment explicitly makes them the managed flow.
- `waitJson` alone is not a wake. A consumer must observe a wake source,
  source-read the relevant systems, then call the revision-safe mutation.
- A stale resume attempt must fail rather than overwrite newer state.

## Proof

For wait/resume proof, report:

- flow id;
- owner/controller;
- current step;
- latest revision before and after mutation;
- wait condition and wake source;
- linked child task/card/session ids when relevant;
- source-read evidence after wake;
- `resume(...)` result with expected revision;
- terminal `finish(...)`, `fail(...)`, cancel, blocked state, or explicit HOLD.

Do not treat a Workboard subscription, cron wake, child session completion, or
stored `waitJson` alone as a resumed flow.

## Escalation

Read runtime source/docs only when live APIs disagree with this skill, a
revision or persistence behavior is unclear, or a release/source gate requires
implementation proof. Put reusable procedure here; keep scenario evidence in
mission artifacts.
