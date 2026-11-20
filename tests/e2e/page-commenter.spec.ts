import { expect, test } from "@playwright/test";
import { withCoreScenario } from "../../scripts/scenarios/harness/core-scenario-harness";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  LAUNCH_REVIEW_PAGE_KEY,
  LAUNCH_REVIEW_INTERPRETATION,
} from "../../scripts/scenarios/scenarios/page-asks-and-comments";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/editor-scenario";
import {
  launchReviewSeed,
  openLaunchReview,
  openReviewSuggestion,
  reviewCard,
  reviewParagraph,
  sendSelectedComment,
} from "./support/page-launch-review";

test("a team Commenter can comment and can only suggest Page edits", async ({}, testInfo) => {
  await withCoreScenario(launchReviewSeed, async ({ manifest, runtime }) => {
    const host = runtime.launch.client;
    const listener = await host.listenSpace({ address: "127.0.0.1:0" });
    const invite = await host.spaceInvite({ role: "commenter" });
    await withElectronScenario(
      {
        label: "page-commenter",
        scenarioId: null,
        onFailure: async ({ page }) => {
          if (page) await page.screenshot({ path: testInfo.outputPath("commenter.png") });
        },
      },
      async ({ page }) => {
        await page.getByRole("button", { name: "Spaces and settings", exact: true }).click();
        await page.getByRole("menuitem", { name: "Join a Space", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Join a Space" });
        await dialog
          .getByLabel("Invite URL")
          .fill(`${listener.url}?fingerprint=${listener.fingerprint}`);
        await dialog.getByLabel("One-time code").fill(invite.code);
        await dialog.getByLabel("Your name").fill("Jordan");
        await dialog.getByRole("button", { name: "Join", exact: true }).click();
        await expect.poll(() => page.url()).toContain("spaceId=");
        const team = (await invokeIpc(page, "spaces:list")).find(({ kind }) => kind === "team");
        if (!team) throw new Error("Commenter's Space is unavailable");

        await expect
          .poll(() =>
            invokeIpc(
              page,
              "library-module:read",
              { kind: "library" },
              {
                read: { mode: "local_member" },
              },
            ),
          )
          .toMatchObject({
            ok: true,
            value: {
              value: { kind: "local_member", value: { id: team.memberId, role: "commenter" } },
            },
          });

        const pageId = manifest.pageIdsByKey[LAUNCH_REVIEW_PAGE_KEY]!;
        const readDescriptor = async () => {
          const snapshot = await host.documentRead("page-commenter-authority", {
            kind: "descriptor",
            owner_block_id: pageId,
          });
          if (snapshot.value.kind !== "descriptor") throw new Error("Missing Page descriptor");
          return snapshot.value.descriptor;
        };
        const beforeOpen = await readDescriptor();
        const stage = await openLaunchReview(page, manifest);
        await expect(stage).toBeVisible();
        const syncStatus = stage.locator("[data-block-document-sync-phase]");
        await expect(syncStatus).toHaveCount(0);
        const mode = page.getByRole("button", {
          name: "You can suggest edits; an editor accepts them",
        });
        await expect(mode).toBeDisabled();
        await expect(mode).toHaveAttribute("aria-pressed", "true");
        const bar = stage.locator("[data-suggestion-bar]");
        await expect(bar).toHaveText("You can comment and suggest edits on this Page");
        expect(await readDescriptor()).toEqual(beforeOpen);

        const commentParagraph = reviewParagraph(stage, "after the launch of in-place Ask");
        const comment = "Could we break down usage by region?";
        const quote = "launch";
        const wordCenter = await commentParagraph.evaluate((element, word) => {
          const text = Array.from(element.childNodes).find(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(word),
          );
          if (!text?.textContent) throw new Error(`Missing review text: ${word}`);
          const offset = text.textContent.indexOf(word);
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + word.length);
          const wordRect = range.getBoundingClientRect();
          const paragraphRect = element.getBoundingClientRect();
          return {
            x: wordRect.left - paragraphRect.left + wordRect.width / 2,
            y: wordRect.top - paragraphRect.top + wordRect.height / 2,
          };
        }, quote);
        await commentParagraph.dblclick({ position: wordCenter });
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
        await sendSelectedComment(page, comment);
        await expect(reviewCard(page, comment)).toBeVisible();
        const read = await host.libraryRead({ kind: "discussions", page_id: pageId });
        if (read.value.kind !== "discussions") throw new Error("Missing host Discussion list");
        expect(read.value.value.items.flatMap(({ comments }) => comments)).toContainEqual(
          expect.objectContaining({
            body: comment,
            author: { type: "member", member_id: team.memberId },
          }),
        );

        const before = await readDescriptor();
        const paragraph = reviewParagraph(stage, LAUNCH_REVIEW_INTERPRETATION);
        await paragraph.click();
        const editor = stage.locator(".ProseMirror");
        await editor.focus();
        await expect(editor).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type("More context. ");
        await expect(bar.getByText("1 suggested change", { exact: true })).toBeVisible();
        await bar.getByRole("button", { name: "Suggest", exact: true }).click();
        const card = await openReviewSuggestion(page);
        const suggestion = card.locator('[data-suggested-edit="open"]');
        await expect(suggestion).toBeVisible();
        await expect(suggestion.getByRole("button", { name: "Accept" })).toHaveCount(0);
        await expect(paragraph).toHaveText(LAUNCH_REVIEW_INTERPRETATION);
        await expect(syncStatus).toHaveCount(0);
        expect(await readDescriptor()).toEqual(before);

        const hostEdit = "A new note from the Space Owner.";
        const committed = await host.documentApply({
          operationId: createBoundedOperationId("e2e.commenter-live-page"),
          clientSessionId: "page-commenter-authority",
          intent: {
            kind: "apply_operation_batch",
            document_id: before.documentId,
            generation: before.generation,
            expected_head_seq: before.headSeq,
            operations: [
              {
                kind: "insert_block",
                parent_block_id: null,
                before_block_id: null,
                block: {
                  id: createUuidV7(),
                  type: "paragraph",
                  props: {},
                  content: [{ type: "text", text: hostEdit, styles: {} }],
                  children: [],
                },
              },
            ],
          },
        });
        await expect(reviewParagraph(stage, hostEdit)).toBeVisible();
        await expect(syncStatus).toHaveCount(0);
        expect((await readDescriptor()).headSeq).toBe(committed.outcome.head_seq);
      },
    );
  });
});
