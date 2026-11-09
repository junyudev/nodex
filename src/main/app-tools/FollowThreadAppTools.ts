import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { followThreadSchema } from "../../shared/nodex-app-tools/work-schema";
import { GitHubSourceAdapter } from "../../host/sources/GitHubSourceAdapter";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { captureAppToolAuthority, type AppToolCaller } from "./AppToolCaller";
import { make as makeOperation } from "./AppToolOperation";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
type Model = components["schemas"];
export const makeWithCapture = (
  capture: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const identity = yield* CoreAuthority;
    const github = yield* GitHubSourceAdapter;
    const admit = yield* makeOperation;
    return Effect.fn("FollowThreadAppTools.execute")(
      function* (input: AppToolInvocation) {
        const parsed = parseAppToolArguments(followThreadSchema, input.arguments);
        if (!parsed.success) return parsed.result;
        const authority = yield* capture(input.caller);
        if (!authority?.runtime) return toolFailure("managed_chat_required");
        const operation = yield* admit(input, authority, identity.identity.profileId, parsed.data);
        if (!operation.success) return operation.result;
        const url = yield* Effect.try({
          try: () => new URL(parsed.data.url),
          catch: () => new Error("Invalid GitHub thread URL"),
        });
        let source: Model["Source"] | undefined;
        let after: string | null = null;
        while (!source) {
          const snapshot: import("../core-client/types").ProjectWorkspaceReadSnapshot =
            yield* core.workspace.read(
              { kind: "sources", read: { kind: "sources", after_id: after, limit: 100 } },
              undefined,
              null,
            );
          if (snapshot.value.kind !== "sources" || snapshot.value.value.kind !== "sources")
            return toolFailure("source_unavailable");
          const sources = snapshot.value.value.sources;
          source = sources.find(
            (s) =>
              s.enabled &&
              s.config.host === url.hostname &&
              s.config.repositories.some(
                (r) =>
                  r.enabled && url.pathname.toLowerCase().startsWith(`/${r.name.toLowerCase()}/`),
              ),
          );
          if (source || sources.length < 100) break;
          after = sources.at(-1)!.id;
        }
        if (!source)
          return toolFailure(
            "source_unavailable",
            "Enable this repository in Sources before following its thread.",
          );
        let thread = yield* github.verifyThread(source, parsed.data.url);
        after = null;
        while (true) {
          const snapshot: import("../core-client/types").ProjectWorkspaceReadSnapshot =
            yield* core.workspace.read(
              {
                kind: "sources",
                read: {
                  kind: "threads",
                  host: thread.host,
                  repository_id: thread.repository_id,
                  after_id: after,
                  limit: 100,
                },
              },
              undefined,
              null,
            );
          if (snapshot.value.kind !== "sources" || snapshot.value.value.kind !== "threads")
            return toolFailure("source_unavailable");
          const threads = snapshot.value.value.threads;
          const current = threads.find((t) => t.id === thread.id);
          if (current) {
            thread = {
              ...thread,
              observation_revision: current.observation_revision,
              observations: current.observations,
            };
            break;
          }
          if (threads.length < 100) break;
          after = threads.at(-1)!.id;
        }
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const latest = yield* capture(input.caller);
        if (
          !latest ||
          latest.turnId !== authority.turnId ||
          latest.storeEpoch !== authority.storeEpoch
        )
          return toolFailure("authority_unavailable");
        const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
        yield* core.workspace
          .apply(
            {
              operationId: operation.operationId,
              intent: {
                kind: "agent_command",
                provenance,
                intent: {
                  kind: "source",
                  command: {
                    kind: "follow_thread",
                    source_id: source.id,
                    config_revision: source.revision,
                    thread,
                  },
                },
              },
            },
            undefined,
            authority.actorProjectId,
          )
          .pipe(Effect.provideService(CoreApplicationAgent, null));
        return toolSuccess({ following: true, url: thread.url });
      },
      Effect.catch(() =>
        Effect.succeed(
          toolFailure(
            "follow_unavailable",
            "The thread could not be verified or this chat has no unambiguous active work Page.",
          ),
        ),
      ),
    );
  });
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
