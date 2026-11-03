import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type { WindowsSandboxSetupCompletedNotification } from "@nodex/codex-app-server-protocol/v2";
import { makeCodexWindowsSandbox, requireCodexWindowsSandbox } from "./CodexWindowsSandbox.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
const success: WindowsSandboxSetupCompletedNotification = {
  mode: "elevated",
  success: true,
  error: null,
};

const fixture = (termination: Effect.Effect<never, unknown> = Effect.never) => {
  const handles: {
    closed: boolean;
    emit?: (event: WindowsSandboxSetupCompletedNotification) => Effect.Effect<unknown>;
  }[] = [];
  const requests: { method: string; params: unknown }[] = [];
  let readiness = "notConfigured";
  let allowed: readonly string[] | null = null;
  let started = true;
  let onStart: (() => Effect.Effect<unknown>) | undefined;
  const open = Effect.gen(function* () {
    const handle: (typeof handles)[number] = { closed: false };
    handles.push(handle);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        handle.closed = true;
      }),
    );
    return {
      raw: { termination },
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          requests.push({ method, params });
          if (method === "windowsSandbox/readiness") return { status: readiness };
          if (method === "configRequirements/read")
            return { requirements: { allowedWindowsSandboxImplementations: allowed } };
          if (method === "windowsSandbox/setupStart") {
            if (onStart) yield* onStart();
            return { started };
          }
          return yield* Effect.die(`Unexpected request ${method}`);
        }),
      handleServerNotification: (_method: string, handler: NonNullable<(typeof handle)["emit"]>) =>
        Effect.sync(() => {
          handle.emit = handler;
        }),
    } as unknown as Client;
  });
  return {
    open,
    handles,
    requests,
    ready: () => {
      readiness = "ready";
    },
    allowed: (value: readonly string[]) => {
      allowed = value;
    },
    notStarted: () => {
      started = false;
    },
    onStart: (run: () => Effect.Effect<unknown>) => {
      onStart = run;
    },
    emit: (event = success) =>
      handles.findLast((handle) => handle.emit !== undefined)!.emit!(event),
  };
};

const prepare = Effect.fnUntraced(function* () {
  const source = fixture();
  const owner = yield* makeCodexWindowsSandbox("win32");
  yield* owner.register("codex", source.open);
  yield* owner.read("codex");
  yield* settle;
  return { owner, source };
});

describe("Windows Codex sandbox endpoint", () => {
  it.effect("settles a lost setup endpoint immediately and releases its process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exited = yield* Deferred.make<never, Error>();
        const source = fixture(Deferred.await(exited));
        const owner = yield* makeCodexWindowsSandbox("win32");
        yield* owner.register("codex", source.open);
        yield* owner.read("codex");
        yield* settle;
        yield* owner.setup("codex", "elevated");
        yield* settle;
        yield* Deferred.fail(exited, new Error("Private native transport details"));
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).failure, "setupFailed");
        assert.isTrue(source.handles.every((handle) => handle.closed));
      }),
    ),
  );
  it.effect("waits for completion, checks a fresh endpoint and releases both processes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        assert.strictEqual((yield* owner.read("codex")).status, "notConfigured");
        const attempt = yield* owner.setup("codex", "elevated");
        yield* settle;
        assert.strictEqual(attempt.status, "settingUp");
        assert.deepStrictEqual(
          source.requests.find((request) => request.method === "windowsSandbox/setupStart")?.params,
          { mode: "elevated" },
        );
        yield* source.emit({ ...success, mode: "unelevated" });
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).status, "settingUp");
        source.ready();
        yield* source.emit();
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).status, "ready");
        assert.strictEqual(source.handles.length, 3);
        assert.isTrue(source.handles.every((handle) => handle.closed));
      }),
    ),
  );

  it.effect("accepts completion before the setupStart response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        source.onStart(() => {
          source.ready();
          return source.emit();
        });
        yield* owner.setup("codex", "elevated");
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).status, "ready");
      }),
    ),
  );

  it.effect("cancels only the captured attempt and ignores late completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        const first = yield* owner.setup("codex", "elevated");
        yield* settle;
        const late = source.emit;
        yield* owner.cancel("codex", first.generation);
        assert.strictEqual((yield* owner.read("codex")).failure, "cancelled");
        assert.isTrue(source.handles.every((handle) => handle.closed));
        const oldHandle = source.handles.findLast((handle) => handle.emit !== undefined)!;
        const second = yield* owner.setup("codex", "unelevated");
        yield* settle;
        yield* owner.cancel("codex", first.generation);
        yield* oldHandle.emit!(success);
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).generation, second.generation);
        assert.strictEqual((yield* owner.read("codex")).status, "settingUp");
        source.ready();
        yield* late({ ...success, mode: "unelevated" });
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).status, "ready");
      }),
    ),
  );

  it.effect("times out a hung setup and releases the endpoint before allowing retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        yield* owner.setup("codex", "elevated");
        yield* settle;
        yield* TestClock.adjust("20 minutes");
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).failure, "timeout");
        assert.isTrue(source.handles.every((handle) => handle.closed));
        assert.strictEqual((yield* owner.setup("codex", "elevated")).status, "settingUp");
      }),
    ),
  );

  it.effect("replaces an endpoint without inheriting its completion or cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        const old = yield* owner.setup("codex", "elevated");
        yield* settle;
        const oldHandle = source.handles.findLast((handle) => handle.emit !== undefined)!;
        const replacement = fixture();
        yield* owner.register("codex", replacement.open);
        assert.isTrue(source.handles.every((handle) => handle.closed));
        yield* owner.read("codex");
        yield* settle;
        const next = yield* owner.setup("codex", "elevated");
        yield* settle;
        yield* oldHandle.emit!(success);
        yield* owner.cancel("codex", old.generation);
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).generation, next.generation);
        assert.strictEqual((yield* owner.read("codex")).status, "settingUp");
      }),
    ),
  );

  it.effect("does not claim readiness from an acknowledgement or leak helper errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        yield* owner.setup("codex", "elevated");
        yield* settle;
        yield* source.emit({
          ...success,
          success: false,
          error: "orchestrator_helper_launch_canceled: C:\\private\\credentials",
        });
        yield* settle;
        const failed = yield* owner.read("codex");
        assert.strictEqual(failed.failure, "cancelled");
        assert.isFalse(JSON.stringify(failed).includes("private"));
        source.notStarted();
        yield* owner.setup("codex", "unelevated");
        yield* settle;
        assert.strictEqual((yield* owner.read("codex")).status, "notConfigured");
      }),
    ),
  );

  it.effect("honors managed setup choices and leaves other platforms untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owner, source } = yield* prepare();
        source.allowed(["unelevated"]);
        yield* owner.read("codex", true);
        yield* settle;
        assert.deepStrictEqual((yield* owner.read("codex")).allowedModes, ["unelevated"]);
        yield* owner.setup("codex", "elevated");
        assert.isFalse(
          source.requests.some((request) => request.method === "windowsSandbox/setupStart"),
        );
        for (const platform of ["darwin", "linux"] as const) {
          const other = yield* makeCodexWindowsSandbox(platform);
          yield* other.register("codex", Effect.die("must not open"));
          assert.strictEqual((yield* other.read("codex")).status, "notApplicable");
          assert.strictEqual((yield* other.setup("codex", "elevated")).status, "notApplicable");
        }
      }),
    ),
  );

  it.effect("fails closed when the execution endpoint has no configured sandbox", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = fixture();
        const client = yield* source.open;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(requireCodexWindowsSandbox(client))));
        source.ready();
        yield* requireCodexWindowsSandbox(client);
      }),
    ),
  );
});
