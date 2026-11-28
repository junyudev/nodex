import type { ServerProviderUsageWindow } from "@nodex/runtime-contracts";
import { collectUint8StreamText } from "@nodex/provider-core/server/collectStreamText";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@nodex/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const MAX_OUTPUT_BYTES = 256 * 1024;
const Bucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.Finite,
  reset_time: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const decodeUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("SUCCESS"),
      num_turns: Schema.Literal(0),
      command: Schema.Struct({
        name: Schema.Literal("usage"),
        data: Schema.Struct({
          groups: Schema.Array(
            Schema.Struct({ name: Schema.NonEmptyString, buckets: Schema.Array(Bucket) }),
          ),
        }),
      }),
    }),
  ),
);

function bucketFamily(id: string, group: string): string {
  if (id.startsWith("gemini-argon-")) return group.trim() || "Gemini Argon";
  if (id.startsWith("gemini-carbon-")) return group.trim() || "Gemini Carbon";
  if (id.startsWith("gemini-")) return "Gemini";
  if (id.startsWith("3p-")) return "Claude & GPT";
  return group.trim() || id;
}

function bucketResetAt(
  bucket: typeof Bucket.Type,
  duration: number | undefined,
  requestedAt: number,
) {
  const resetAt = Date.parse(bucket.reset_time ?? "");
  if (!Number.isFinite(resetAt)) return undefined;
  // agy reports a rolling full-window reset for some untouched buckets.
  if (
    bucket.remaining_fraction === 1 &&
    bucket.description === undefined &&
    duration !== undefined &&
    Math.abs(resetAt - requestedAt - duration * 60_000) <= 60_000
  )
    return undefined;
  return new Date(resetAt).toISOString();
}

export function parseAntigravityUsage(output: string, requestedAt: number) {
  const decoded = decodeUsage(output);
  if (Option.isNone(decoded)) return undefined;
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const group of decoded.value.command.data.groups) {
    for (const bucket of group.buckets) {
      if (bucket.disabled) continue;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = WINDOW_MINS.get(bucket.window ?? "");
      const resetsAt = bucketResetAt(bucket, windowDurationMins, requestedAt);
      windows.set(bucket.id, {
        id: bucket.id,
        label: `${bucketFamily(bucket.id, group.name)} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.name.trim() || "Quota"}`,
        kind: weekly ? "weekly" : session ? "session" : "other",
        usedPercent: (1 - Math.max(0, Math.min(1, bucket.remaining_fraction))) * 100,
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  if (windows.size === 0) return undefined;
  return makeUsageLimits({
    checkedAt: new Date(requestedAt).toISOString(),
    windows: windows.values(),
  });
}

/** Print mode handles /usage without starting a model turn. Process and preparation share a scope. */
export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* <E>(input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly prepare: Effect.Effect<
    {
      readonly command: string;
      readonly cwd: string;
      readonly env?: NodeJS.ProcessEnv | undefined;
    },
    E,
    Scope.Scope
  >;
}) {
  const requestedAt = yield* Clock.currentTimeMillis;
  const checkedAt = new Date(requestedAt).toISOString();
  const failed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Couldn't read Antigravity limits. Nodex tries again with the next check.",
  });
  return yield* Effect.gen(function* () {
    const { command, cwd, env } = yield* input.prepare;
    const child = yield* input.spawner.spawn(
      ChildProcess.make(
        command,
        ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"],
        {
          cwd,
          env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
          extendEnv: false,
          shell: false,
          stdin: "ignore",
          stderr: "ignore",
          forceKillAfter: "1 second",
        },
      ),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) === 2)
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    if (Number(exitCode) !== 0 || stdout.truncated || stdout.invalidUtf8) return failed;
    return parseAntigravityUsage(stdout.text, requestedAt) ?? failed;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(failed) }),
    Effect.orElseSucceed(() => failed),
  );
});
