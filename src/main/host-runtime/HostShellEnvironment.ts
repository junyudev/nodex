import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { withoutDesktopToolHostBindings } from "../codex/desktop-tool-environment";
import {
  captureHostLoginEnvironment,
  type CodexLocalShellEnvironmentOptions,
} from "../codex/codex-worktree-shell-environment";

type HostShellOptions = Omit<CodexLocalShellEnvironmentOptions, "onError"> & {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
};

export type HostShellOutcome =
  | { readonly status: "captured" | "inherited"; readonly environment: NodeJS.ProcessEnv }
  | {
      readonly status: "failed";
      readonly reason: "capture" | "timeout";
      readonly message: string;
    };

export class HostShellEnvironment extends Context.Service<
  HostShellEnvironment,
  {
    /** Joins the current capture or retries the last failure. */
    readonly recover: Effect.Effect<HostShellOutcome>;
    /** The last completed outcome, including the reason for a failed attempt. */
    readonly latest: Effect.Effect<HostShellOutcome | null>;
    /** Recovered environment when available, inherited environment on failure. */
    readonly load: Effect.Effect<NodeJS.ProcessEnv>;
  }
>()("nodex/main/host-runtime/HostShellEnvironment") {}

/** A hung shell gets 25 seconds, while discovery with a usable known install can answer sooner. */
export const live = (options: HostShellOptions) =>
  Layer.effect(
    HostShellEnvironment,
    Effect.gen(function* () {
      const { platform } = options;
      const baseEnvironment = { ...options.baseEnvironment };
      const inherited = withoutDesktopToolHostBindings(baseEnvironment, platform);
      const handle = yield* FiberHandle.make<HostShellOutcome>();
      const admission = yield* Semaphore.make(1);
      let latest: HostShellOutcome | null =
        platform === "win32" ? { status: "inherited", environment: inherited } : null;
      let accepting = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
        }),
      );
      let active: Fiber.Fiber<HostShellOutcome> | null = null;
      const capture = Effect.tryPromise({
        try: (signal) => captureHostLoginEnvironment({ ...options, baseEnvironment, signal }),
        catch: (error) => ({
          reason: "capture" as const,
          message: error instanceof Error ? error.message : "Login shell capture failed",
        }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "25 seconds",
          orElse: () =>
            Effect.fail({ reason: "timeout" as const, message: "Login shell exceeded 25 seconds" }),
        }),
        Effect.match({
          onSuccess: (environment): HostShellOutcome => ({ status: "captured", environment }),
          onFailure: (failure): HostShellOutcome => ({ status: "failed", ...failure }),
        }),
        Effect.tap((outcome) =>
          outcome.status === "failed"
            ? Effect.logWarning("Could not recover the host login shell environment").pipe(
                Effect.annotateLogs({ reason: outcome.reason, message: outcome.message }),
              )
            : Effect.void,
        ),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            latest = outcome;
            active = null;
          }),
        ),
      );
      const acquire = admission.withPermits(1)(
        Effect.gen(function* () {
          if (!accepting) return yield* Effect.interrupt;
          if (latest && latest.status !== "failed") return latest;
          if (active) return active;
          // Publish the shared fiber before its capture can complete.
          active = yield* FiberHandle.run(handle, Effect.yieldNow.pipe(Effect.andThen(capture)));
          return active;
        }),
      );
      const recover = acquire.pipe(
        Effect.flatMap((result) =>
          "status" in result ? Effect.succeed(result) : Fiber.join(result),
        ),
      );
      return HostShellEnvironment.of({
        recover,
        latest: Effect.sync(() => latest),
        load: recover.pipe(
          Effect.map((outcome) => (outcome.status === "failed" ? inherited : outcome.environment)),
        ),
      });
    }),
  );

export const inheritedHostShellEnvironment = (environment: NodeJS.ProcessEnv) =>
  HostShellEnvironment.of({
    recover: Effect.succeed({ status: "inherited", environment }),
    latest: Effect.succeed({ status: "inherited", environment }),
    load: Effect.succeed(environment),
  });
