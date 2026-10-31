import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { LIBRARY_INBOX, type InboxSendInput } from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import { MAX_INBOX_TITLE_LENGTH } from "../../shared/schemas/inbox";
import { CoreModuleResponseError } from "../core-client/core-client";
import { inboxOverRealCore } from "./InboxApplication.test-support";

it.effect(
  "saves desktop titles literally as final Page titles that suggestions cannot rename",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox } = yield* inboxOverRealCore();
        const summary = yield* inbox.summary({ scope: LIBRARY_INBOX });
        for (const title of [
          "# *Literal* [title](https://example.com) & <tag> \\path ~~strike~~",
          "中".repeat(MAX_INBOX_TITLE_LENGTH),
        ]) {
          const input: InboxSendInput = {
            operationId: createBoundedOperationId("test.inbox.capture"),
            pageId: createUuidV7(),
            documentId: createUuidV7(),
            issuedAt: Date.now(),
            storeEpoch: summary.storeEpoch,
            scope: LIBRARY_INBOX,
            title: `  ${title}  `,
            body: "The message body stays separate from its title.",
          };
          const result = yield* inbox.send(input);
          assert.deepEqual(result.value, { pageId: input.pageId, state: "saved" });
          const entry = (yield* inbox.pendingSuggestions(8)).find(
            (entry) => entry.page_id === input.pageId,
          );
          if (!entry) return assert.fail("Missing captured message");
          assert.isFalse(entry.title_provisional);
          assert.isNull(
            yield* inbox.nameEntry({ basis: entry.basis, title: "A suggestion title" }),
          );
          const window = yield* inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" });
          assert.deepInclude(
            window.items.find((item) => item.pageId === input.pageId),
            {
              title,
              body: input.body,
            },
          );
        }
      }),
    ),
);

it.effect("replays a capture after a lost reply and retires it when its Page was deleted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox } = yield* inboxOverRealCore();
      const summary = yield* inbox.summary({ scope: LIBRARY_INBOX });
      const input: InboxSendInput = {
        operationId: createBoundedOperationId("test.inbox.capture"),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        storeEpoch: summary.storeEpoch,
        scope: LIBRARY_INBOX,
        body: "Research this later; keep the next draft intact.",
      };
      // Deliberately discard the first response as a renderer disconnect would.
      yield* inbox.send(input);
      const recovered = yield* inbox.send(input);
      assert.deepEqual(recovered.value, { pageId: input.pageId, state: "saved" });
      assert.strictEqual((yield* inbox.summary({ scope: LIBRARY_INBOX })).entryCount, 1);

      yield* inbox.delete({ pageIds: [input.pageId] });
      const afterDeletion = yield* inbox.send(input);
      assert.deepEqual(afterDeletion.value, { pageId: input.pageId, state: "deleted" });
      assert.strictEqual((yield* inbox.summary({ scope: LIBRARY_INBOX })).entryCount, 0);
    }),
  ),
);

it.effect("keeps a post-commit visibility refusal uncertain and recovers the same capture", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, client } = yield* inboxOverRealCore();
      const summary = yield* inbox.summary({ scope: LIBRARY_INBOX });
      const input: InboxSendInput = {
        operationId: createBoundedOperationId("test.inbox.capture"),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        storeEpoch: summary.storeEpoch,
        scope: LIBRARY_INBOX,
        body: "Preserve this captured thought after a lost visibility read",
      };
      const read = vi.spyOn(client, "libraryRead").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code: "conflict",
          message: "The visibility read was refused",
          retryable: false,
          recovery: { kind: "none" },
        }),
      );
      const error = yield* inbox
        .send(input)
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => read.mockRestore())));
      assert.isTrue(error.mayHaveCommitted);
      assert.strictEqual((yield* inbox.summary({ scope: LIBRARY_INBOX })).entryCount, 1);
      const recovered = yield* inbox.send(input);
      assert.deepEqual(recovered.value, { pageId: input.pageId, state: "saved" });
      assert.strictEqual((yield* inbox.summary({ scope: LIBRARY_INBOX })).entryCount, 1);
    }),
  ),
);

it.effect("refuses to change a captured intent while reusing its identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox } = yield* inboxOverRealCore();
      const summary = yield* inbox.summary({ scope: LIBRARY_INBOX });
      const input: InboxSendInput = {
        operationId: createBoundedOperationId("test.inbox.capture"),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        storeEpoch: summary.storeEpoch,
        scope: LIBRARY_INBOX,
        body: "The first captured thought",
      };
      yield* inbox.send(input);
      yield* Effect.flip(inbox.send({ ...input, body: "A different thought" }));
      const window = yield* inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" });
      assert.strictEqual(window.items.length, 1);
      assert.strictEqual(window.items[0]?.body, input.body);
    }),
  ),
);
