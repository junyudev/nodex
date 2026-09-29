import { isDeepStrictEqual } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { isContentTool } from "../../shared/nodex-app-tools/content-catalog";
import { sidebarSchemas } from "../../shared/nodex-app-tools/sidebar-schemas";
import { sessionSchemas } from "../../shared/nodex-app-tools/session-schemas";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import { appToolsServerConfig } from "../codex/app-tools-launch-config";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModules } from "../core-runtime/CoreModules";
import { acquireAppToolPipe, type AppToolPipeError } from "../platform/node/NodexAppToolPipe";
import { AppToolInvocationInbox } from "./AppToolInvocationInbox";
import { createNativeAppToolClaimIssuer } from "./AppToolCaller";
import { toolFailure } from "./app-tool-result";

const commonNames = new Set([
  "load_workspace_dependencies",
  "query_content",
  "describe_content_schema",
  "list_projects",
  "get_app_capabilities",
  "send_message_to_session",
  "automation_update",
  "read_session_terminal",
]);

export const nativeAppToolCatalog = appToolCatalog.filter(
  (tool) =>
    commonNames.has(tool.name) ||
    isContentTool(tool.name) ||
    Object.hasOwn(sidebarSchemas, tool.name) ||
    Object.hasOwn(sessionSchemas, tool.name) ||
    Object.hasOwn(sessionObservationSchemas, tool.name),
);
const nativeNames = new Set(nativeAppToolCatalog.map((tool) => tool.name));
export const isNativeAppTool = (name: string): boolean => nativeNames.has(name);

export interface NativeAppToolSessionLease {
  readonly launchContext: {
    readonly systemPromptAppend: string;
    readonly mcpServers: Options["mcpServers"];
  };
  readonly beginTurn: (authority: FrozenNodexAgentTurnAuthority) => Effect.Effect<boolean>;
  readonly endTurn: (turnId: string) => void;
  readonly setBackgroundTasks: (taskIds: readonly string[]) => void;
  readonly revoke: () => void;
}

export class NativeAppToolSession extends Context.Service<
  NativeAppToolSession,
  {
    readonly acquire: (input: {
      readonly threadId: string;
      readonly hostId: string;
      readonly generation: number;
      /** Main validates the live native owner and current Core binding/location for every call. */
      readonly isCurrent: Effect.Effect<boolean>;
      readonly runtime: Omit<Parameters<typeof appToolsServerConfig>[0], "pipe">;
    }) => Effect.Effect<NativeAppToolSessionLease, AppToolPipeError, Scope.Scope>;
  }
>()("nodex/main/app-tools/NativeAppToolSession") {}

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const invocations = yield* AppToolInvocationInbox;
  const callbacks = yield* ScopedCallbackRuntime;
  return NativeAppToolSession.of({
    acquire: Effect.fn("NativeAppToolSession.acquire")(function* (input) {
      const capture = (authority: FrozenNodexAgentTurnAuthority) =>
        input.isCurrent.pipe(
          Effect.flatMap((current) =>
            current
              ? core.workspace
                  .read(
                    {
                      kind: "turn_authority",
                      thread_id: authority.threadId,
                      turn_id: authority.turnId,
                      root_thread_id: authority.rootThreadId,
                      actor_project_id: authority.actorProjectId,
                    },
                    undefined,
                    authority.actorProjectId,
                  )
                  .pipe(
                    Effect.map((snapshot) => {
                      if (snapshot.value.kind !== "turn_authority") return false;
                      const resolution = snapshot.value.resolution;
                      return (
                        resolution.persisted &&
                        resolution.read_only === authority.readOnly &&
                        resolution.frozen_at_ms === authority.frozenAtMs &&
                        isDeepStrictEqual(
                          resolution.authority,
                          toCoreAgentTurnProvenance("", authority).authority,
                        )
                      );
                    }),
                    Effect.catch(() => Effect.succeed(false)),
                  )
              : Effect.succeed(false),
          ),
        );
      const issuer = createNativeAppToolClaimIssuer({ ...input, capture });
      const pipe = yield* acquireAppToolPipe({
        listTools: Effect.sync(() => structuredClone(nativeAppToolCatalog)),
        callTool: (request) =>
          Effect.gen(function* () {
            if (!nativeNames.has(request.name)) return toolFailure("tool_unavailable");
            if (!(yield* input.isCurrent)) return toolFailure("authority_unavailable");
            const caller = issuer.claim();
            if (!caller) return toolFailure("authority_unavailable");
            return yield* invocations.invoke({
              caller,
              name: request.name,
              arguments: request.arguments,
            });
          }),
      }).pipe(Effect.provideService(ScopedCallbackRuntime, callbacks));
      // Revoke admitted calls before the socket lease closes or waits for its finalizers.
      yield* Effect.addFinalizer(() => Effect.sync(() => issuer.close()));
      const server = appToolsServerConfig({ ...input.runtime, pipe });
      return {
        launchContext: {
          systemPromptAppend:
            "You are working in a Nodex Session. Use nodex_app tools for authorized Nodex Pages, Data Sources, Session metadata, application capabilities, and scheduling. These tools require a foreground turn and pause while background tasks are live. Session messaging requires the user's authorization. Link generated files with absolute paths.",
          mcpServers: {
            nodex_app: {
              type: "stdio",
              command: server.command,
              args: server.args,
              env: server.env,
            },
          },
        },
        beginTurn: (authority) =>
          capture(authority).pipe(Effect.map((current) => current && issuer.beginTurn(authority))),
        endTurn: issuer.endTurn,
        setBackgroundTasks: issuer.setBackgroundTasks,
        revoke: issuer.close,
      } satisfies NativeAppToolSessionLease;
    }),
  });
});

export const layer = Layer.effect(NativeAppToolSession, make);
