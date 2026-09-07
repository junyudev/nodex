import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationUpdateInput,
} from "../../../shared/types";
import {
  AutomationApplication,
  AutomationApplicationError,
} from "../../automation-application/AutomationApplication";
import { AutomationExecution } from "../../automation-application/AutomationExecution";
import { updateAutomationFromRenderer } from "./AutomationIpc";

const proposal: CodexScheduledAutomationUpdateInput = {
  id: "automation-1",
  expectedRevision: 4,
  kind: "heartbeat",
  status: "ACTIVE",
  name: "Reviewed task",
  prompt: "Check progress",
  rrule: "FREQ=DAILY",
  targetSessionId: "session:original",
  notificationPolicy: null,
};

function harness(revision: number, changeDuringPreparation = false) {
  let currentRevision = revision;
  const prepared: unknown[] = [];
  const updates: unknown[] = [];
  const committed: unknown[] = [];
  const current = () =>
    ({ ...proposal, definitionRevision: currentRevision }) as CodexScheduledAutomation;
  const definitions: Pick<AutomationApplication["Service"]["definitions"], "get" | "update"> = {
    get: () => Effect.sync(current),
    update: (input, command) =>
      Effect.gen(function* () {
        updates.push({ input, command });
        if (
          command?.expectedRevision !== undefined &&
          command.expectedRevision !== currentRevision
        ) {
          return yield* new AutomationApplicationError({
            operation: "definitions.update",
            cause: new Error("conflict"),
          });
        }
        committed.push(input);
        return current();
      }),
  };
  const application = AutomationApplication.of({
    definitions,
  } as unknown as AutomationApplication["Service"]);
  const executionMethods: Pick<AutomationExecution["Service"], "prepareDefinition"> = {
    prepareDefinition: (input) =>
      Effect.sync(() => {
        prepared.push(input);
        if (changeDuringPreparation) currentRevision += 1;
        return input;
      }),
  };
  const execution = AutomationExecution.of(executionMethods as AutomationExecution["Service"]);
  return {
    prepared,
    updates,
    committed,
    run: (input = proposal) =>
      updateAutomationFromRenderer(input).pipe(
        Effect.provideService(AutomationApplication, application),
        Effect.provideService(AutomationExecution, execution),
      ),
  };
}

it.effect("rejects stale reviewed updates before preparation or mutation", () =>
  Effect.gen(function* () {
    const state = harness(5);
    expect(Exit.isFailure(yield* Effect.exit(state.run()))).toBe(true);
    expect(state.prepared).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.committed).toEqual([]);
  }),
);

it.effect(
  "preserves the reviewed revision at Core after a concurrent change during preparation",
  () =>
    Effect.gen(function* () {
      const state = harness(4, true);
      expect(Exit.isFailure(yield* Effect.exit(state.run()))).toBe(true);
      expect(state.updates).toEqual([
        expect.objectContaining({ command: expect.objectContaining({ expectedRevision: 4 }) }),
      ]);
      expect(state.committed).toEqual([]);
    }),
);

it.effect("saves the reviewed stable target and explicit notification reset", () =>
  Effect.gen(function* () {
    const state = harness(4);
    yield* state.run();
    expect(state.committed).toEqual([
      expect.objectContaining({ targetSessionId: "session:original", notificationPolicy: null }),
    ]);
    expect(state.updates).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ expectedRevision: 4, operationId: expect.any(String) }),
      }),
    ]);
  }),
);
