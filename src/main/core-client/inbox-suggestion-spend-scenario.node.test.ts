import { createUuidV7 } from "../../shared/uuid-v7";
import { describe, expect, test } from "vite-plus/test";
import { runScenarioInbox } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  INBOX_SUGGESTION_SPEND_SCENARIO_ID,
  INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
  requireInboxSuggestionSpendScenarioFacts,
} from "../../../scripts/scenarios/scenarios/inbox-suggestion-spend";

describe("inbox/suggestion-spend scenario", () => {
  test("keeps current, outdated, unrequested, grouped and failed advice without starting Agents", async () => {
    await withCoreScenario({ scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID }, async (context) => {
      expect(requireInboxSuggestionSpendScenarioFacts(context.facts)).toEqual({
        scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID,
        scenarioRevision: INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
        messageCount: 7,
        currentProposalCount: 2,
        outdatedProposalCount: 1,
        unrequestedCount: 2,
        groupedMemberCount: 2,
        failedCount: 1,
      });
      const items = (await context.seed.readInbox("inbox")).items;
      const message = (key: string) =>
        items.find((item) => item.pageId === context.manifest.pageIdsByKey[key]);
      expect(message("current")).toMatchObject({
        suggestionState: "settled",
        proposal: {
          origin: "agent",
          state: "open",
          outdated: false,
          action: { type: "new_chat", projectId: context.manifest.projectId },
        },
      });
      expect(message("outdated")).toMatchObject({
        suggestionState: "settled",
        proposal: { origin: "agent", state: "open", outdated: true },
      });
      expect(message("outdated")?.body).toContain("Include the pricing section");
      expect(message("unrequested")).toMatchObject({ suggestionState: "none", proposal: null });
      const group = message("navigation")?.proposal;
      expect(group?.pageIds).toEqual([
        context.manifest.pageIdsByKey.navigation,
        context.manifest.pageIdsByKey.keyboard,
      ]);
      expect(message("keyboard")?.proposal).toEqual(group);
      for (const item of items) {
        expect(item.basis.contentHash).toMatch(/^[a-f0-9]{64}$/u);
        const member = item.proposal?.basis.find((basis) => basis.pageId === item.pageId);
        if (member) expect(member).toEqual(item.basis);
      }
      expect(
        await runScenarioInbox(context.runtime, (inbox) => inbox.suggestionRequests(16)),
      ).toEqual([]);
      const pictured = message("pictured");
      const source = `nodex://files/${context.manifest.entityIdsByKey?.screenshotFile}`;
      expect(pictured?.body).toBe(`![](${source})\n\nCan you look at this?`);
      const input = await runScenarioInbox(context.runtime, (inbox) =>
        inbox.dispatchContext([context.manifest.pageIdsByKey.pictured!]),
      );
      expect(input.entries[0]).toMatchObject({
        body: "[Image 1]\n\nCan you look at this?",
        images: [{ source, file_id: context.manifest.entityIdsByKey?.screenshotFile }],
      });
      expect(input.entries[0]?.images[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(await runScenarioInbox(context.runtime, (inbox) => inbox.outbox(16))).toEqual([]);
    });
  });

  test("resolves a frozen image digest to immutable bytes after its File head changes", async () => {
    await withCoreScenario({ scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID }, async (context) => {
      const pageId = context.manifest.pageIdsByKey.pictured!;
      const input = await runScenarioInbox(context.runtime, (inbox) =>
        inbox.dispatchContext([pageId]),
      );
      const image = input.entries[0]?.images[0];
      if (!image) throw new Error("Scenario message has no image");
      const client = context.runtime.rootClient;
      const original = await client.readFileBlob({
        fileId: image.file_id,
        source: { kind: "direct" },
      });
      const operationId = createUuidV7();
      const replacement = new TextEncoder().encode("Replacement image bytes");
      const prepared = await client.prepareFileBlob({ operationId, bytes: replacement });
      await client.libraryApply({
        operationId,
        intent: {
          kind: "apply_file_change",
          change: {
            kind: "replace_content",
            file_id: image.file_id,
            expected_revision: 1,
            expected_head_version: 1,
            mime_type: "image/png",
            prepared_blob_receipt_id: prepared.receipt_id,
          },
          turn_id: null,
        },
      });
      const latest = await client.libraryRead({
        kind: "file_versions",
        file_id: image.file_id,
        limit: 1,
        cursor: null,
      });
      if (latest.value.kind !== "file_versions") throw new Error("Expected File versions");
      expect(latest.value.value.items[0]?.blob_etag).not.toBe(image.content_hash);
      expect(latest.value.value.has_more).toBe(true);
      const older = await client.libraryRead({
        kind: "file_versions",
        file_id: image.file_id,
        limit: 1,
        cursor: latest.value.value.next_cursor,
      });
      if (older.value.kind !== "file_versions") throw new Error("Expected older File versions");
      const version = older.value.value.items.find(
        (candidate) => candidate.blob_etag === image.content_hash,
      );
      if (!version) throw new Error("Frozen image version was not retained");
      const frozen = await client.readFileBlob({
        fileId: image.file_id,
        source: { kind: "direct" },
        version: version.version,
      });
      expect(frozen.etag).toBe(image.content_hash);
      expect(frozen.bytes).toEqual(original.bytes);
      const current = await client.readFileBlob({
        fileId: image.file_id,
        source: { kind: "direct" },
      });
      expect(Array.from(current.bytes)).toEqual(Array.from(replacement));
      expect(current.etag).not.toBe(frozen.etag);
    });
  });
});
