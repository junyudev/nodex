import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PersistedAtomStore } from "../local-store/persisted-atoms";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import {
  codexClientThreadIdentityAtomKey,
  getCodexClientThreadId,
  resolveCodexThreadIdForClientThreadId,
  setCodexClientThreadIdentity,
  readCodexClientThreadIdentityCandidates,
} from "../codex/codex-client-thread-identity";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";

export class CodexClientThreadIdentityError extends Schema.TaggedError<CodexClientThreadIdentityError>()(
  "CodexClientThreadIdentityError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexClientThreadIdentity extends Context.Service<
  CodexClientThreadIdentity,
  {
    readonly remember: (
      threadId: string,
      clientThreadId: string,
      hostId?: string,
    ) => Effect.Effect<void, CodexClientThreadIdentityError>;
    readonly forget: (
      threadId: string,
      hostId?: string,
    ) => Effect.Effect<void, CodexClientThreadIdentityError>;
    readonly threadIdFor: (
      clientThreadId: string,
      hostId?: string,
    ) => Effect.Effect<string | null, CodexClientThreadIdentityError>;
    readonly clientThreadIdFor: (
      threadId: string,
      hostId?: string,
    ) => Effect.Effect<string | null, CodexClientThreadIdentityError>;
    readonly candidates: (
      clientThreadId: string,
      expectedHostId?: string,
    ) => Effect.Effect<
      readonly import("../codex/codex-client-thread-identity").CodexClientThreadIdentity[],
      CodexClientThreadIdentityError
    >;
    /** Resolves the browser-facing Session identity used while a pending Thread is materializing. */
    readonly resolveBrowserConversationId: (
      conversationId: string,
    ) => Effect.Effect<string, CodexClientThreadIdentityError>;
  }
>()("nodex/main/codex-application/CodexClientThreadIdentity") {}

export const make = (
  store: PersistedAtomStore,
): Effect.Effect<
  CodexClientThreadIdentity["Service"],
  never,
  ProjectWorkspace | CodexApplicationEventHub
> =>
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const events = yield* CodexApplicationEventHub;
    const attempt = <A>(operation: string, evaluate: () => A) =>
      Effect.try({
        try: evaluate,
        catch: (cause) => new CodexClientThreadIdentityError({ operation, cause }),
      });
    const remember = (threadId: string, clientThreadId: string, hostId = CODEX_APP_LOCAL_HOST_ID) =>
      attempt("remember", () => {
        const existingThreadId = resolveCodexThreadIdForClientThreadId(
          store,
          hostId,
          clientThreadId,
        );
        if (existingThreadId && existingThreadId !== threadId) {
          throw new Error(
            `Client Thread identity is already bound to Thread '${existingThreadId}'`,
          );
        }
        if (
          !setCodexClientThreadIdentity(store, {
            hostId,
            threadId,
            clientThreadId,
          })
        ) {
          throw new Error(`Invalid client Thread identity for '${threadId}'`);
        }
        events.publish({
          kind: "codex",
          value: { type: "createdThreadTargetChanged", hostId, threadId, clientThreadId },
        });
      });
    const threadIdFor = (clientThreadId: string, hostId = CODEX_APP_LOCAL_HOST_ID) =>
      attempt("resolve-thread", () =>
        resolveCodexThreadIdForClientThreadId(store, hostId, clientThreadId),
      );
    const clientThreadIdFor = (threadId: string, hostId = CODEX_APP_LOCAL_HOST_ID) =>
      attempt("resolve-client", () => getCodexClientThreadId(store, hostId, threadId));

    return CodexClientThreadIdentity.of({
      remember,
      forget: (threadId, hostId = CODEX_APP_LOCAL_HOST_ID) =>
        attempt("forget", () => {
          store.update({
            key: codexClientThreadIdentityAtomKey(hostId, threadId),
            value: null,
          });
        }),
      threadIdFor,
      clientThreadIdFor,
      candidates: (clientThreadId, expectedHostId) =>
        attempt("read-candidates", () =>
          readCodexClientThreadIdentityCandidates(store, clientThreadId, expectedHostId),
        ),
      resolveBrowserConversationId: (conversationId) =>
        Effect.gen(function* () {
          const directSession = yield* workspace.getProjectSession(conversationId).pipe(
            Effect.mapError(
              (cause) =>
                new CodexClientThreadIdentityError({
                  operation: "resolve-browser-session",
                  cause,
                }),
            ),
          );
          if (directSession) return directSession.id;
          const resolvedThreadId = (yield* threadIdFor(conversationId)) ?? conversationId;
          const thread = yield* workspace.getThread(resolvedThreadId).pipe(
            Effect.mapError(
              (cause) =>
                new CodexClientThreadIdentityError({
                  operation: "resolve-browser-thread",
                  cause,
                }),
            ),
          );
          if (thread?.sessionId) return thread.sessionId;
          return (yield* clientThreadIdFor(conversationId)) ?? conversationId;
        }),
    });
  });
