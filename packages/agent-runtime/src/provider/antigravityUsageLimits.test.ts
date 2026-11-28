import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";
import { parseAntigravityUsage, readAntigravityUsage } from "./antigravityUsageLimits.ts";

const requestedAt = Date.parse("2026-11-28T08:00:00Z");
const fixture = {
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Models in each group share limits.",
      groups: [
        {
          name: "Gemini Models",
          description: "Gemini models share these limits.",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "Partly used",
              window: "weekly",
              remaining_fraction: 0.25,
              reset_time: "2026-12-03T08:00:00Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-11-28T13:00:10Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-12-02T08:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.5,
              reset_time: "2026-11-28T09:00:00Z",
            },
          ],
        },
      ],
    },
  },
};

describe("Antigravity CLI usage", () => {
  it("decodes native quota groups and suppresses only rolling full-window resets", () => {
    expect(parseAntigravityUsage(JSON.stringify(fixture), requestedAt)).toEqual({
      checkedAt: "2026-11-28T08:00:00.000Z",
      windows: [
        {
          id: "3p-5h",
          label: "Claude & GPT · 5-hour",
          kind: "session",
          windowDurationMins: 300,
          usedPercent: 50,
          resetsAt: "2026-11-28T09:00:00.000Z",
        },
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          windowDurationMins: 300,
          usedPercent: 0,
        },
        {
          id: "3p-weekly",
          label: "Claude & GPT · Weekly",
          kind: "weekly",
          windowDurationMins: 10080,
          usedPercent: 0,
          resetsAt: "2026-12-02T08:00:00.000Z",
        },
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          kind: "weekly",
          windowDurationMins: 10080,
          usedPercent: 75,
          resetsAt: "2026-12-03T08:00:00.000Z",
        },
      ],
    });
  });

  it("keeps separate model families, names unfamiliar or missing windows, and skips disabled buckets", () => {
    const bucket = { name: "Trial", window: "custom", remaining_fraction: 0.5 };
    const groups = [
      { name: "Argon Models", buckets: [{ ...bucket, id: "gemini-argon-trial" }] },
      { name: "Carbon Models", buckets: [{ ...bucket, id: "gemini-carbon-trial" }] },
      {
        name: "New Models",
        buckets: [
          { ...bucket, id: "new-trial" },
          { id: "new-credits", name: "Credits", remaining_fraction: 0.5 },
          { ...bucket, id: "new-disabled", disabled: true },
        ],
      },
    ];
    const payload = { ...fixture, command: { name: "usage", data: { groups } } };
    const windows = parseAntigravityUsage(JSON.stringify(payload), requestedAt)?.windows;
    expect(windows?.map(({ label, kind }) => [label, kind])).toEqual([
      ["Argon Models · Trial", "other"],
      ["Carbon Models · Trial", "other"],
      ["New Models · Credits", "other"],
      ["New Models · Trial", "other"],
    ]);
  });
});

const probe = (input: {
  readonly output?: string;
  readonly exitCode?: number;
  readonly hang?: {
    readonly started: Deferred.Deferred<void>;
    readonly closed: Deferred.Deferred<void>;
  };
}) =>
  readAntigravityUsage({
    prepare: Effect.succeed({
      command: "/fixture/agy",
      cwd: "/fixture/state",
      env: { HOME: "/fixture/home" },
    }),
    spawner: ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Expected one command");
        expect(command.command).toBe("/fixture/agy");
        expect(command.args).toEqual([
          "-p",
          "/usage",
          "--output-format",
          "json",
          "--print-timeout",
          "20s",
        ]);
        expect(command.options).toMatchObject({
          cwd: "/fixture/state",
          env: { HOME: "/fixture/home", AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
          extendEnv: false,
          shell: false,
        });
        if (input.hang) {
          const { started, closed } = input.hang;
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          yield* Deferred.succeed(started, undefined);
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: input.hang
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
          isRunning: Effect.succeed(input.hang !== undefined),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(input.output ?? JSON.stringify(fixture)).pipe(Stream.encodeText),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  });

describe("Antigravity CLI probe", () => {
  it.effect("reads the configured agy and recognizes exit 2 as no subscription limits", () =>
    Effect.gen(function* () {
      expect((yield* probe({})).windows).toHaveLength(4);
      expect((yield* probe({ exitCode: 2 })).unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect(
    "treats timeouts, other failures, and unsafe or malformed replies as failed reads",
    () =>
      Effect.gen(function* () {
        for (const input of [
          { exitCode: 3 },
          { exitCode: 1 },
          { output: "not JSON" },
          { output: JSON.stringify({ ...fixture, num_turns: 1 }) },
          {
            output: JSON.stringify({ ...fixture, command: { ...fixture.command, name: "other" } }),
          },
          { output: JSON.stringify({ ...fixture, command: { name: "usage", data: {} } }) },
          {
            output: JSON.stringify({
              ...fixture,
              command: { name: "usage", data: { groups: [] } },
            }),
          },
        ]) {
          expect((yield* probe(input)).unavailable?.reason).toBe("probeFailed");
        }
      }),
  );

  it.effect("closes the child scope when the whole read times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const reading = yield* probe({ hang: { started, closed } }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(reading)).unavailable?.reason).toBe("probeFailed");
      expect(yield* Deferred.isDone(closed)).toBe(true);
    }),
  );
});
