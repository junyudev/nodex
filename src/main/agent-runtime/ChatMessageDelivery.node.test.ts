import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make, inboundTextHash } from "./ChatMessageDelivery";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";

const fixture = (managed: boolean) =>
  Effect.gen(function* () {
    const writes: ProjectWorkspaceApplyInput[] = [];
    const record = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: () => Effect.succeed({ value: { kind: "session", session: { managed } } }),
          apply: (command: ProjectWorkspaceApplyInput) =>
            Effect.sync(() => {
              writes.push(command);
              return {};
            }),
        },
      } as never),
    );
    return { writes, record };
  });
it.effect("records the admitted message identity, author, words and binary attachment count", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f
      .record("chat", {
        messageId: "original",
        text: "Keep these words.",
        images: [{ source: "data:image/png;base64,AQID" }],
      })
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    assert.deepInclude(f.writes[0]!.intent, {
      kind: "record_chat_delivery",
      delivery_id: "original",
      session_id: "chat",
      body_hash: inboundTextHash("Keep these words."),
      author: { kind: "user" },
      attachment_count: 1,
      question_answer_run_id: null,
    });
    yield* f
      .record(
        "chat",
        { messageId: "agent", text: "A delegated message" },
        { senderThreadId: "sender" },
      )
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    assert.deepInclude(f.writes[1]!.intent, {
      author: {
        kind: "agent",
        session_id: null,
        thread_id: "sender",
        run_id: null,
        project_id: null,
        label: "Agent",
      },
    });
  }),
);
it.effect("fences question answers even before an unmanaged chat becomes managed", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* f
      .record("chat", { messageId: "ordinary", text: "Hello" })
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    assert.isEmpty(f.writes);
    yield* f
      .record("chat", { messageId: "answer", text: "Yes" }, { questionRunId: "answered-run" })
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    assert.deepInclude(f.writes[0]!.intent, {
      delivery_id: "answer",
      question_answer_run_id: "answered-run",
    });
  }),
);
