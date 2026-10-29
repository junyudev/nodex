import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createUuidV7 } from "../../shared/uuid-v7";
import { captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";
import { inboxPageBasisFromCore } from "../core-client/inbox-adapter";

const LIBRARY = { kind: "library" } as const;

it.effect("an edit rewrites the message Page and asks for a fresh suggestion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, client } = yield* inboxOverRealCore();
      const original = "Homepage feels like a dev tool.\nMaybe it should read like an assistant?";
      const { pageId } = yield* captureInbox(inbox, original);
      // A rewrite starts from the body as the Page stores it.
      const originalBody =
        "Homepage feels like a dev tool.\nMaybe it should read like an assistant?";
      const [entry] = yield* inbox.pendingSuggestions(8);
      if (!entry) return assert.fail("Missing pending entry");
      yield* inbox.propose({
        proposalId: createUuidV7(),
        pageIds: [pageId],
        basis: [entry.basis],
        action: { type: "keep" },
        kind: "question",
        summary: "Keep this question for later.",
        rationale: null,
        producedBy: "Test",
      });

      const rewritten = "The homepage should read like a personal assistant.\nKeep the docs link.";
      // The Page keeps the written lines as one paragraph with a line break.
      const stored = "The homepage should read like a personal assistant.\nKeep the docs link.";
      const basis = inboxPageBasisFromCore(entry.basis);
      yield* inbox.edit({ pageId, basis, originalBody, body: rewritten });

      const [item] = (yield* inbox.window({ scope: LIBRARY, filter: "inbox" })).items;
      assert.deepInclude(item, {
        pageId,
        body: stored,
        bodyEditable: true,
        // The provisional title follows the new opening words.
        title: "The homepage should read like a personal…",
        suggestionState: "waiting",
      });
      // The last advice stays visible while a new send waits for its automatic-policy decision.
      assert.isTrue(item?.proposal?.outdated);
      assert.deepEqual(item?.proposal?.action, { type: "keep" });
      // The Page itself changed, so the Board, search, and an open Page agree with the stream.
      const page = yield* Effect.promise(() =>
        client.libraryRead({
          kind: "page_projection_file",
          page_id: pageId,
          file_kind: "body_markdown",
        }),
      );
      assert.strictEqual(page.value.kind, "page_projection_file");
      if (page.value.kind === "page_projection_file") {
        assert.include(page.value.value.content, "Keep the docs link.");
      }
      const [again] = yield* inbox.pendingSuggestions(8);
      assert.strictEqual(again?.body, rewritten);
      assert.isTrue(again?.title_provisional);

      // An edit started from text that has since changed never overwrites it.
      const stale = yield* Effect.flip(
        inbox.edit({ pageId, basis, originalBody, body: "Something else" }),
      );
      assert.match(stale.message, /message changed/);
      const [unchanged] = (yield* inbox.window({ scope: LIBRARY, filter: "inbox" })).items;
      assert.strictEqual(unchanged?.body, stored);
    }),
  ),
);
