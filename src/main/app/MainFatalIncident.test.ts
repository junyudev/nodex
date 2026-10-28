import { expect, test } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreTransportError } from "../core-client/uds-http";
import { MainApplicationError, type MainExit } from "./MainExit";
import { makeMainFatalIncident, fatalIncidentPresentation } from "./MainFatalIncident";

const context = {
  id: "5fa076e8-3e7a-4cdb-abfc-632bf74fd45d",
  occurredAt: "2026-10-28T06:00:00.000Z",
  appVersion: "0.4.0",
};
const exitFor = (cause: Cause.Cause<MainApplicationError>): MainExit & { _tag: "Failure" } => ({
  _tag: "Failure",
  phase: "runtime",
  cause,
});

test("retains nested failure meaning and code coordinates without copying content or paths", () => {
  const privateError = Object.assign(new Error("private prompt Bearer token-123"), {
    prompt: "private prompt",
    attachment: "private image bytes",
    token: "token-123",
  });
  privateError.stack =
    "Error: private prompt Bearer token-123\n    at Worker.consume (/Users/private-person/secret-workspace/private.ts:42:9)";
  const failure = new MainApplicationError({
    phase: "runtime",
    operation: "core",
    cause: Cause.fail(
      coreRuntimeError({
        operation: "events.read",
        reason: "transport-loss",
        retryable: true,
        generation: "generation-1",
        cause: new CoreTransportError("connection_lost", "response", "ECONNRESET", privateError),
      }),
    ),
  });
  const incident = makeMainFatalIncident(
    exitFor(Cause.fail(failure)),
    {
      failures: [
        { operation: "core.shutdown", subsystem: "core", reason: "private shutdown details" },
      ],
    },
    context,
  );
  expect(failure.message).toContain("core");
  expect(incident.causes.map(({ parent, name }) => ({ parent, name }))).toEqual([
    { parent: null, name: "MainApplicationError" },
    { parent: 0, name: "CoreRuntimeError" },
    { parent: 1, name: "CoreTransportError" },
    { parent: 2, name: "Error" },
  ]);
  expect(incident.causes[1]).toMatchObject({
    operation: "events.read",
    generation: "generation-1",
    reason: "transport-loss",
    retryable: true,
  });
  expect(incident.causes[2]).toMatchObject({
    transportKind: "connection_lost",
    code: "ECONNRESET",
  });
  expect(incident.causes[3]!.frames).toEqual([{ function: "Worker.consume", line: 42, column: 9 }]);
  expect(incident.cleanup).toEqual({
    failureCount: 1,
    failures: [{ operation: "core.shutdown", subsystem: "core" }],
  });
  for (const privateValue of [
    "private prompt",
    "token-123",
    "private image",
    "private-person",
    "secret-workspace",
    "private.ts",
    "private shutdown",
  ]) {
    expect(JSON.stringify(incident)).not.toContain(privateValue);
  }
  expect(
    fatalIncidentPresentation(incident, "/profile/diagnostics/fatal/report.json"),
  ).toMatchObject({
    incidentId: context.id,
    detail: expect.stringContaining("Diagnostics: /profile/diagnostics/fatal/report.json"),
  });
});

test("retains sibling defects and caps a large cause graph", () => {
  const cause = Cause.fromReasons<MainApplicationError>([
    Cause.makeFailReason(
      new MainApplicationError({ phase: "runtime", operation: "core", cause: null }),
    ),
    ...Array.from({ length: 30 }, () => Cause.makeDieReason(new TypeError("private input"))),
  ]);
  const incident = makeMainFatalIncident(exitFor(cause), { failures: [] }, context);
  expect(incident.causes.length).toBeLessThanOrEqual(12);
  expect(incident.causes[1]).toMatchObject({ name: "TypeError", kind: "defect", parent: null });
  expect(incident.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(incident))).toBeLessThan(16 * 1024);
});

test("handles cycles and throwing dependency accessors without hiding the fatal", () => {
  const error = new Error("private input");
  Object.defineProperty(error, "stack", {
    get: () => {
      throw new Error("private getter");
    },
  });
  error.cause = error;
  const incident = makeMainFatalIncident(exitFor(Cause.die(error)), { failures: [] }, context);
  expect(incident.causes).toEqual([
    { kind: "defect", parent: null, name: "UninspectableError", frames: [] },
  ]);
  expect(fatalIncidentPresentation(incident, null).detail).toContain("could not be saved");
});

test("classifies errors without retaining custom names from dependencies", () => {
  const privateName = "private-credential-canary";
  const dependencyError = Object.assign(new Error("private message"), { name: privateName });
  const typeError = Object.assign(new TypeError("private input"), { name: privateName });
  const incident = makeMainFatalIncident(
    exitFor(
      Cause.fromReasons([Cause.makeDieReason(dependencyError), Cause.makeDieReason(typeError)]),
    ),
    { failures: [] },
    context,
  );
  expect(incident.causes.map(({ name }) => name)).toEqual(["Error", "TypeError"]);
  expect(JSON.stringify(incident)).not.toContain(privateName);
});

test("bounds traversal through deeply nested Cause containers", () => {
  let cause: Cause.Cause<unknown> = Cause.die(new Error("private content"));
  for (let index = 0; index < 12_000; index += 1) cause = Cause.fail(cause);
  const incident = makeMainFatalIncident(exitFor(Cause.die(cause)), { failures: [] }, context);
  expect(incident.truncated).toBe(true);
  expect(incident.causes.length).toBeLessThanOrEqual(12);
  expect(fatalIncidentPresentation(incident, null).incidentId).toBe(context.id);
});
