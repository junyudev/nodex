import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { commandReceiptIdentity } from "./CommandIdentity.ts";

const message = {
  type: "message.dispatch" as const,
  commandId: CommandId.make("command:immutable"),
  threadId: ThreadId.make("thread:immutable"),
  messageId: MessageId.make("message:immutable"),
  text: "Inspect the workspace",
  attachments: [],
  dispatchMode: { type: "defer_start" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
};

it("binds every immutable field while permitting a new retry command ID", () => {
  const identity = commandReceiptIdentity(message);
  const retry = commandReceiptIdentity({ ...message, commandId: CommandId.make("command:retry") });
  expect(retry.requestFingerprint).not.toBe(identity.requestFingerprint);
  expect(retry.messageFingerprint).toBe(identity.messageFingerprint);
  expect(commandReceiptIdentity({ ...message, text: "Replace files" }).messageFingerprint).not.toBe(
    identity.messageFingerprint,
  );
  expect(
    commandReceiptIdentity({
      ...message,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    }).messageFingerprint,
  ).not.toBe(identity.messageFingerprint);
  expect(commandReceiptIdentity({ ...message, creationSource: message.creationSource })).toEqual(
    identity,
  );
  expect(
    commandReceiptIdentity({ ...message, createdBy: "agent", creationSource: "server" }).messageId,
  ).toBeUndefined();
});

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  CommandReceiptStore.layer.pipe(Layer.provide(database)),
);
const testLayer = EventSink.layer.pipe(Layer.provideMerge(stores));

it.effect("atomically reserves a message once and refuses command or message identity reuse", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const input = {
      commandId: message.commandId,
      threadId: message.threadId,
      commandType: message.type,
      ...commandReceiptIdentity(message),
      acceptedAt: yield* DateTime.now,
      events: [],
      effects: [],
    };
    const retryMessage = { ...message, commandId: CommandId.make("command:immutable-retry") };
    const attempts = yield* Effect.all(
      [
        sink.commitCommand(input),
        sink.commitCommand({
          ...input,
          commandId: retryMessage.commandId,
          ...commandReceiptIdentity(retryMessage),
        }),
      ],
      { concurrency: "unbounded" },
    );
    expect(attempts.filter((attempt) => attempt.committed)).toHaveLength(1);
    expect(attempts[0]!.receipt.commandId).toBe(attempts[1]!.receipt.commandId);
    const receipt = yield* receipts.getByMessageId(message.messageId, message.commandId);
    expect(Option.isSome(receipt)).toBe(true);
    const count = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM orchestration_command_receipts`;
    expect(count[0]?.count).toBe(1);

    for (const changed of [
      { ...message, text: "Changed" },
      { ...message, commandId: CommandId.make("command:changed"), text: "Changed" },
      {
        ...message,
        commandId: CommandId.make("command:other-thread"),
        threadId: ThreadId.make("other-thread"),
      },
    ]) {
      const result = yield* sink
        .commitCommand({
          ...input,
          commandId: changed.commandId,
          threadId: changed.threadId,
          ...commandReceiptIdentity(changed),
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(yield* receipts.getByMessageId(message.messageId, message.commandId)).toEqual(receipt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records rejected request identity without reserving its unaccepted message", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const rejected = {
      commandId: message.commandId,
      threadId: message.threadId,
      commandType: message.type,
      ...commandReceiptIdentity(message),
      rejectedAt: yield* DateTime.now,
      error: "Provider unavailable",
    };
    const receipt = yield* sink.commitRejectedCommand(rejected);
    expect(receipt.status).toBe("rejected");
    expect(
      Option.isNone(yield* receipts.getByMessageId(message.messageId, message.commandId)),
    ).toBe(true);
    const changed = commandReceiptIdentity({ ...message, text: "Changed" });
    expect(
      (yield* sink.commitRejectedCommand({ ...rejected, ...changed }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* receipts.getByCommandId(message.commandId)).toEqual(Option.some(receipt));
  }).pipe(Effect.provide(testLayer)),
);
