import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as callbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import { appToolsLaunchArgs } from "../codex/app-tools-launch-config";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import {
  live as sessionLive,
  type CodexAppServerSessionOptions,
} from "../codex-runtime/CodexAppServerSession";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { acquireAppToolPipe } from "../platform/node/NodexAppToolPipe";
import { AppToolInvocationInbox } from "./AppToolInvocationInbox";
import { selectAppToolCatalog } from "../../shared/nodex-app-tools/catalog-selection";

/** Acquire a private bridge in the physical session Scope, never in a Thread's saved config. */
export const make = Effect.gen(function* () {
  const calls = yield* CodexApplicationRequestInbox;
  const invocations = yield* AppToolInvocationInbox;
  return (
    options: CodexAppServerSessionOptions,
    runtime: Omit<Parameters<typeof appToolsLaunchArgs>[0], "pipe">,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const source = { hostId: options.hostId, generation: options.generation };
        const pipe = yield* acquireAppToolPipe({
          listTools: Effect.sync(() =>
            structuredClone([...selectAppToolCatalog({ nativeMcp: true, purpose: "session" })]),
          ),
          callTool: (input) =>
            calls.runAppCall(source, input, (claim) =>
              invocations.invoke({
                caller: { ...claim, ...source },
                name: input.name,
                arguments: input.arguments,
              }),
            ),
        }).pipe(
          Effect.mapError((cause) =>
            codexRuntimeError({
              ...source,
              operation: "app-tools.acquire",
              reason: "initialize",
              retryable: false,
              cause,
            }),
          ),
        );
        return sessionLive({
          ...options,
          args: [...options.args, ...appToolsLaunchArgs({ ...runtime, pipe })],
        });
      }),
    ).pipe(Layer.provide(callbackRuntimeLayer));
});
