import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createUuidV7 } from "../../shared/uuid-v7";
import { inboxOverRealCore } from "./InboxApplication.test-support";

const LIBRARY = { kind: "library" } as const;

it.effect("names a provisional title only on the exact Page the Agent read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox } = yield* inboxOverRealCore();
      const message =
        "Homepage feels like a dev tool.\nMaybe it should read like a personal assistant?";
      const { pageId } = yield* inbox.send({ scope: LIBRARY, text: message });

      const [entry] = yield* inbox.pendingSuggestions(8);
      if (!entry) return assert.fail("Missing pending entry");
      assert.strictEqual(entry.body, message);
      assert.isTrue(entry.title_provisional);

      const named = yield* inbox.nameEntry({ basis: entry.basis, title: "Homepage positioning" });
      if (!named) return assert.fail("The untouched Page was not named");
      assert.isAbove(named.head_seq, entry.basis.head_seq);
      // A stale read never overwrites the Page.
      assert.isNull(yield* inbox.nameEntry({ basis: entry.basis, title: "Stale name" }));

      // The proposal is fenced by the named Page, so it stays confirmable.
      const proposalId = createUuidV7();
      yield* inbox.propose({
        proposalId,
        pageIds: [pageId],
        basis: [named],
        action: { type: "keep" },
        kind: "question",
        summary: "Keep this question for later.",
        rationale: null,
        producedBy: "Test",
      });
      const window = yield* inbox.window({ scope: LIBRARY, filter: "inbox" });
      assert.deepInclude(window.items[0], {
        pageId,
        title: "Homepage positioning",
        body: message,
      });
      assert.strictEqual(window.items[0]?.proposal?.proposalId, proposalId);
      assert.strictEqual(window.items[0]?.proposal?.state, "open");

      // Once named, the title belongs to the Page; a fresh suggestion pass may not rename it.
      yield* inbox.requestSuggestion({ pageIds: [pageId] });
      const [again] = yield* inbox.pendingSuggestions(8);
      assert.strictEqual(again?.page_id, pageId);
      assert.isFalse(again?.title_provisional);
    }),
  ),
);

it.effect("deleting a message erases it from both views and wakes Store maintenance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let erasureRequests = 0;
      const { inbox, client } = yield* inboxOverRealCore(
        Effect.sync(() => {
          erasureRequests += 1;
        }),
      );
      const { pageId } = yield* inbox.send({
        scope: LIBRARY,
        text: "Use the key sk-live-0123456789 for staging",
      });
      yield* inbox.delete({ pageIds: [pageId] });

      assert.deepEqual((yield* inbox.window({ scope: LIBRARY, filter: "inbox" })).items, []);
      assert.deepEqual((yield* inbox.window({ scope: LIBRARY, filter: "processed" })).items, []);
      assert.strictEqual((yield* inbox.summary({ scope: LIBRARY })).entryCount, 0);
      assert.strictEqual(erasureRequests, 1);
      // The Page is no longer readable anywhere in the Library.
      const page = yield* Effect.promise(() =>
        client
          .libraryRead({ kind: "page_projection_file", page_id: pageId, file_kind: "meta_yaml" })
          .then(
            () => "readable",
            () => "gone",
          ),
      );
      assert.strictEqual(page, "gone");
    }),
  ),
);
