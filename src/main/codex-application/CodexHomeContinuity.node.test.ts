import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CoreModules } from "../core-runtime/CoreModules";
import { readCodexHomeReceipt, writeCodexHomeReceipt } from "../platform/node/CodexHomeContinuity";
import {
  CodexSessionTransport,
  type CodexSessionTransportHandle,
} from "../platform/node/CodexSessionTransport";
import { CodexHomeContinuity, live } from "./CodexHomeContinuity";

const fixture = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "nodex-home-activation-")))),
  (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
);

const processConfig = {
  hostId: "local",
  generation: 1,
  command: "/pinned/codex",
  args: ["app-server"],
  env: {},
  forceTermination: "1 second",
} as const;
const continuity = (
  profileHome: string,
  core: CoreModules["Service"],
  transport: CodexSessionTransport["Service"],
) =>
  live({ profileHome, currentHome: join(profileHome, "old"), processConfig }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CoreModules, core),
        Layer.succeed(CodexSessionTransport, transport),
      ),
    ),
  );

it.effect(
  "activation checks every bound native history page and preserves the active receipt on failure",
  () =>
    Effect.gen(function* () {
      const profileHome = yield* fixture;
      const old = join(profileHome, "old");
      const target = join(profileHome, "target");
      yield* Effect.sync(() => {
        mkdirSync(old);
        mkdirSync(target);
        writeCodexHomeReceipt({ profileHome, codexHome: old });
      });
      const coreReads: unknown[] = [];
      const core = {
        workspace: {
          read: (read: {
            readonly kind: string;
            readonly window: { readonly after: string | null };
          }) =>
            Effect.sync(() => {
              coreReads.push(read);
              expect(read.kind).toBe("local_codex_thread_ids");
              return {
                value: {
                  kind: "local_codex_thread_ids",
                  thread_ids: {
                    items: read.window.after === null ? ["root"] : ["child"],
                    next_cursor: read.window.after === null ? "next" : null,
                  },
                },
              };
            }),
        },
      } as unknown as CoreModules["Service"];
      const reads: string[] = [];
      const transport = {
        open: (config: { readonly env: Record<string, string> }) =>
          Effect.succeed({
            pid: 1,
            transportKind: "stdio",
            termination: Effect.never,
            client: {
              request: (method: string, params: { readonly threadId?: string }) => {
                if (method === "initialize")
                  return Effect.succeed({ codexHome: config.env.CODEX_HOME });
                if (method === "thread/turns/list")
                  return Effect.succeed({ data: [], nextCursor: null, backwardsCursor: null });
                reads.push(params.threadId ?? "missing");
                if (params.threadId === "child")
                  return Effect.fail(
                    new CodexAppServerRequestError({
                      code: -32600,
                      method,
                      errorMessage: "thread not loaded: child",
                    }),
                  );
                return Effect.succeed({ thread: { id: params.threadId } });
              },
              notify: () => Effect.void,
            },
          } as unknown as CodexSessionTransportHandle),
        canonicalPath: (path: string) => Effect.succeed(path),
      } as CodexSessionTransport["Service"];
      const service = Context.get(
        yield* Layer.build(continuity(profileHome, core, transport)),
        CodexHomeContinuity,
      );
      const result = yield* Effect.result(service.activate(target, old));
      expect(Result.isFailure(result)).toBe(true);
      expect(coreReads).toHaveLength(2);
      expect(reads).toEqual(["root", "child"]);
      expect(readCodexHomeReceipt(profileHome)).toBe(old);
    }),
);

it.effect("a Profile without native bindings activates a new home without starting a peer", () =>
  Effect.gen(function* () {
    const profileHome = yield* fixture;
    const target = join(profileHome, "new");
    const core = {
      workspace: {
        read: () =>
          Effect.succeed({
            value: { kind: "local_codex_thread_ids", thread_ids: { items: [], next_cursor: null } },
          }),
      },
    } as unknown as CoreModules["Service"];
    const transport = {
      open: () => Effect.die(new Error("empty Profile must not inspect native destination")),
      canonicalPath: (path: string) => Effect.succeed(path),
    } as CodexSessionTransport["Service"];
    const service = Context.get(
      yield* Layer.build(continuity(profileHome, core, transport)),
      CodexHomeContinuity,
    );
    expect(existsSync(target)).toBe(false);
    yield* service.assertChange(target);
    expect(existsSync(target)).toBe(false);
    yield* service.activate(target, join(profileHome, "old"));
    expect(existsSync(target)).toBe(true);
    expect(readCodexHomeReceipt(profileHome)).toBe(target);
  }),
);
