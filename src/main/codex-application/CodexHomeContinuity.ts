import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CoreModules } from "../core-runtime/CoreModules";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexSessionTransport,
  type CodexSessionProcessConfig,
} from "../platform/node/CodexSessionTransport";
import {
  assertCodexHomeChangeSafe,
  CodexHomeContinuityError,
  createCodexHomeDirectory,
  writeCodexHomeReceipt,
} from "../platform/node/CodexHomeContinuity";

export class CodexHomeContinuity extends Context.Service<
  CodexHomeContinuity,
  {
    readonly assertChange: (targetHome: string) => Effect.Effect<void, CodexHomeContinuityError>;
    readonly activate: (
      home: string,
      previousHome: string | null,
    ) => Effect.Effect<void, CodexHomeContinuityError>;
  }
>()("nodex/main/codex-application/CodexHomeContinuity") {}

export const live = (input: {
  readonly profileHome: string;
  readonly currentHome: string;
  readonly processConfig: CodexSessionProcessConfig;
}): Layer.Layer<CodexHomeContinuity, never, CoreModules | CodexSessionTransport> =>
  Layer.effect(
    CodexHomeContinuity,
    Effect.gen(function* () {
      const core = yield* CoreModules;
      const transport = yield* CodexSessionTransport;
      const assertChange = Effect.fn("CodexHomeContinuity.assertChange")(function* (
        targetHome: string,
        currentHome = input.currentHome,
      ) {
        if (currentHome === targetHome) return;
        const threadIds: string[] = [];
        let after: string | null = null;
        do {
          const response: ProjectWorkspaceReadSnapshot = yield* core.workspace
            .read({
              kind: "local_codex_thread_ids",
              window: { after, first: 200 },
            })
            .pipe(
              Effect.mapError(
                (cause) => new CodexHomeContinuityError({ targetHome, threadId: null, cause }),
              ),
            );
          if (response.value.kind !== "local_codex_thread_ids") {
            return yield* new CodexHomeContinuityError({
              targetHome,
              threadId: null,
              cause: new Error("Core returned an incompatible Codex home continuity response."),
            });
          }
          threadIds.push(...response.value.thread_ids.items);
          after = response.value.thread_ids.next_cursor ?? null;
        } while (after !== null);
        yield* assertCodexHomeChangeSafe({
          currentHome,
          targetHome,
          requiredThreadIds: threadIds,
          processConfig: input.processConfig,
        }).pipe(Effect.provideService(CodexSessionTransport, transport));
      });
      return CodexHomeContinuity.of({
        assertChange,
        activate: Effect.fn("CodexHomeContinuity.activate")(function* (home, previousHome) {
          if (previousHome !== null) yield* assertChange(home, previousHome);
          yield* Effect.try({
            try: () => {
              createCodexHomeDirectory(home);
              writeCodexHomeReceipt({ profileHome: input.profileHome, codexHome: home });
            },
            catch: (cause) =>
              new CodexHomeContinuityError({ targetHome: home, threadId: null, cause }),
          });
        }),
      });
    }),
  );
