import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

test("preserves capture and filing decisions while Project counts share the action area", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_INBOX_TRIAGE_ARTIFACT_DIR ?? testInfo.outputPath("inbox-triage-review");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    { label: "inbox-reliable-triage", scenarioId: null },
    async ({ page, seed }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      const target = await seed.createProject({ name: "Inbox filing target", sources: [] });
      const openInbox = async () => {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(page.locator('[data-inbox-scope="library"]')).toBeVisible();
      };
      await page.setViewportSize({ width: 1280, height: 800 });
      await openInbox();
      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
      });
      await page.screencast.showActions({
        position: "bottom",
        style: { title: "font-size: 14px" },
      });
      try {
        const composer = page.getByRole("textbox", { name: "Message your Inbox" });
        const firstText = "Research compact navigation; do not change code.";
        const nextDraft = "Keep the keyboard interaction reference for later.";
        await composer.fill(firstText);
        await composer.press("Enter");
        await composer.fill(nextDraft);
        const first = page.getByTestId("inbox-message").filter({ hasText: firstText });
        await expect(first).toBeVisible();
        const firstId = await first.getAttribute("data-inbox-page-id");
        expect(firstId).toBeTruthy();

        await page.reload();
        await openInbox();
        await expect(composer).toHaveValue(nextDraft);
        claim(
          "A new draft survives reload after the previous capture",
          nextDraft,
          await composer.inputValue(),
        );
        const firstRow = page.locator(`[data-inbox-page-id="${firstId}"]`);
        // Copy and Edit show on the text while the message is hovered.
        await firstRow.getByTestId("inbox-message-unit").hover();
        await firstRow.getByRole("button", { name: "Edit", exact: true }).click();
        await firstRow
          .getByRole("textbox", { name: "Edit message" })
          .fill(`${firstText}\nDeliver a short comparison.`);
        await firstRow.getByRole("button", { name: "Save", exact: true }).click();
        await expect(firstRow.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
        await expect(firstRow).toContainText("Deliver a short comparison.");
        await expect(composer).toHaveValue(nextDraft);
        claim(
          "Inline editing preserves the composer draft",
          nextDraft,
          await composer.inputValue(),
        );

        await composer.press("Enter");
        const second = page.getByTestId("inbox-message").filter({ hasText: nextDraft });
        await expect(second).toBeVisible();
        await firstRow.hover();
        await firstRow.getByRole("checkbox", { name: "Select message", exact: true }).check();
        await second.getByRole("checkbox", { name: "Select message", exact: true }).check();
        const selection = page.getByTestId("inbox-bulk-bar");
        await expect(selection).toContainText("2 selected");
        await selection.getByRole("button", { name: "Handle manually", exact: true }).click();
        await page.getByRole("radio", { name: "Move to Project", exact: true }).click();
        await page.getByRole("button", { name: "Project", exact: true }).click();
        await page.getByRole("option", { name: "Inbox filing target", exact: true }).click();
        await page.getByRole("button", { name: "Move", exact: true }).click();
        // Each message first says where it went, in its own place, and only then folds away.
        await expect(firstRow).toContainText("Moved to Inbox filing target");
        claim(
          "A decided message shows its outcome in place before leaving",
          true,
          (await firstRow.innerText()).includes("Moved to Inbox filing target"),
        );
        await page.screenshot({ path: path.join(artifacts, "decided-in-place.png") });
        await expect(page.getByTestId("inbox-message")).toHaveCount(0);
        const history = await invokeIpc(page, "inbox:window", {
          scope: { kind: "library" },
          filter: "processed",
        });
        claim(
          "One decision records both captures as moved",
          ["moved", "moved"],
          history.items.map((item) => item.outcome),
        );
        // Filing belongs to the original Inbox; the target Project must not get a second capture.
        claim(
          "Filing creates no second capture in the destination Inbox",
          0,
          (
            await invokeIpc(page, "inbox:summary", {
              scope: { kind: "project", projectId: target.id },
            })
          ).entryCount,
        );
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect(page.getByTestId("inbox-message")).toHaveCount(2);
        const restored = await invokeIpc(page, "inbox:window", {
          scope: { kind: "library" },
          filter: "inbox",
        });
        claim(
          "One Undo returns both captures to the original Inbox",
          ["inbox", "inbox"],
          restored.items.map((item) => item.location.kind),
        );
        await expect(firstRow).toContainText("Deliver a short comparison.");
        claim(
          "Undo preserves the edited message",
          true,
          (await firstRow.innerText()).includes("Deliver a short comparison."),
        );
        await seed.sendInboxMessage("Keep the navigation reference.", {
          kind: "project",
          projectId: target.id,
        });
        const projectRow = page.locator(
          '[data-app-action-sidebar-project-label="Inbox filing target"]',
        );
        const count = projectRow.getByLabel("1 in Inbox filing target's Inbox", { exact: true });
        await composer.focus();
        await page.mouse.move(1000, 450);
        await expect(count).toBeVisible();
        await projectRow.hover();
        await expect(count).toBeHidden();
        await page.screenshot({ path: path.join(artifacts, "hover.png") });
        await composer.focus();
        await page.mouse.move(1000, 450);
        await expect(count).toBeVisible();
        claim(
          "The Project count returns after the pointer leaves its shared actions",
          "1",
          await count.innerText(),
        );
        // A message's Page opens beside the Library Inbox, which stays in view.
        await firstRow.getByTestId("inbox-message-unit").hover();
        await firstRow.getByRole("button", { name: "Message actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Open page", exact: true }).click();
        // Each tab group has its own tab row in the window's title row.
        const groups = page.locator('[data-panel-tab-row^="right:"]').filter({ visible: true });
        await expect(groups).toHaveCount(2);
        await expect(groups.nth(1).getByRole("tab", { selected: true })).toContainText(
          "Research compact navigation",
        );
        claim(
          "Open page keeps the Inbox in view beside the Page",
          { inboxScene: 1, space: 0, groups: 2, inboxVisible: true },
          {
            inboxScene: await page.getByTestId("inbox-right-panel").count(),
            space: await page.getByTestId("library-right-panel").count(),
            groups: await groups.count(),
            inboxVisible: await firstRow.isVisible(),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "page-beside-inbox.png") });

        await page.screenshot({ path: path.join(artifacts, "final.png") });
        await page.waitForTimeout(700);
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          `${JSON.stringify({ status, fixture: "fresh disposable Electron Profile; suggestions disabled; synthetic Inbox messages and filing Project", claims, failure }, null, 2)}\n`,
        );
        await writeFile(
          path.join(artifacts, "README.md"),
          `# Inbox triage verification\n\nStatus: **${status}**\n\nA fresh disposable Electron Profile captures a message, restores the next draft after reload, edits the original message inline, files two selected messages to a Project, which each say where they went in place before folding away, and returns both with one Undo. Opening a message's Page shows it beside the Library Inbox, which stays in view. The destination Inbox has no duplicate capture. A separate Project capture then verifies its count is replaced by row actions on hover and returns when the pointer leaves. The recording uses synthetic content and real renderer/Main/Core operations. Exact expected and actual values are in result.json.\n\nArtifacts: review.webm, decided-in-place.png, page-beside-inbox.png, final.png and hover.png.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
        );
      }
    },
  );
});
