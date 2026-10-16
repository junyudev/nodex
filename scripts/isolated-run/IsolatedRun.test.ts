import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  terminateForegroundProcessGroup,
  IsolatedRunFailure,
  type IsolatedProcessGroup,
  type IsolatedRunClock,
} from "./IsolatedRun";

it.effect("escalates a foreground process group against the control-plane clock", ({ expect }) =>
  Effect.gen(function* () {
    const signals: NodeJS.Signals[] = [];
    const clock: IsolatedRunClock = {
      now: Clock.currentTimeMillis,
      sleep: Effect.sleep,
    };
    const processGroup: IsolatedProcessGroup = {
      isAlive: () => Effect.succeed(true),
      signal: (_processGroupId, signal) =>
        Effect.sync(() => {
          signals.push(signal);
        }),
    };
    const termination = yield* Effect.forkChild(
      Effect.result(
        terminateForegroundProcessGroup({
          clock,
          processGroup,
          processGroupId: 4321,
          requestedSignal: "SIGINT",
        }),
      ),
    );

    yield* Effect.yieldNow;
    expect(signals).toEqual(["SIGINT"]);

    yield* TestClock.adjust("1500 millis");
    yield* Effect.yieldNow;
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);

    yield* TestClock.adjust("1500 millis");
    yield* Effect.yieldNow;
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);

    yield* TestClock.adjust("1000 millis");
    const result = yield* Fiber.join(termination);
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect("waits for the group to disappear when signaling a reaping process fails", ({ expect }) =>
  Effect.gen(function* () {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    let completed = false;
    const termination = yield* Effect.forkChild(
      terminateForegroundProcessGroup({
        clock: { now: Clock.currentTimeMillis, sleep: Effect.sleep },
        processGroup: {
          isAlive: () => Effect.sync(() => alive),
          signal: (_processGroupId, signal) =>
            Effect.sync(() => signals.push(signal)).pipe(
              Effect.andThen(
                new IsolatedRunFailure({
                  cause: Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
                }),
              ),
            ),
        },
        processGroupId: 4321,
        requestedSignal: "SIGINT",
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.result,
      ),
    );

    yield* Effect.yieldNow;
    expect(signals).toEqual(["SIGINT"]);
    expect(completed).toBe(false);
    alive = false;
    yield* TestClock.adjust("25 millis");
    expect(Result.isSuccess(yield* Fiber.join(termination))).toBe(true);
    expect(completed).toBe(true);
    expect(signals).toEqual(["SIGINT"]);
  }),
);
