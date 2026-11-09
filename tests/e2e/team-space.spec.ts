import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withCoreScenario } from "../../scripts/scenarios/harness/core-scenario-harness";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-sync-recovery";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import { openBoardPageFromCard } from "./support/open-board-page";
import { invokeIpc } from "./support/editor-scenario";

const exec = promisify(execFile);

test("joins a team Space, collaborates live and keeps personal work isolated through revocation", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await mkdir(screenshots, { recursive: true });
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (host) => {
    const cli = async <Value>(...args: string[]): Promise<Value> => {
      const { stdout } = await exec(
        path.resolve("target/debug/nodex"),
        [
          "--json",
          "--expect-profile",
          host.runtime.identity.profileId,
          "--project",
          host.manifest.projectId,
          ...args,
        ],
        {
          env: { ...process.env, NODEX_HOME: host.profile.nodexHome },
          cwd: host.profile.projectsDirectory,
          timeout: 30_000,
        },
      );
      const result = JSON.parse(stdout) as { ok: boolean; result: Value };
      expect(result.ok).toBe(true);
      return result.result;
    };
    await cli("space", "listen", "--address", "127.0.0.1:0");
    await cli("space", "rename", "Team Research");
    const view = await host.client.databaseRead({
      kind: "view",
      view_id: host.manifest.databaseViewId!,
    });
    if (view.value.kind !== "view") throw new Error("Host View is unavailable");
    const dataSourceId = view.value.value.data_source_id;
    await withElectronScenario(
      {
        label: "team-space",
        scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
        seedThrough: "core",
        onFailure: async ({ page, readRuntimeLogs }) => {
          await page?.screenshot({ path: path.join(screenshots, "failure.png") });
          await writeFile(
            testInfo.outputPath("renderer-errors.json"),
            JSON.stringify(
              {
                errors: (await page?.pageErrors())?.map((error) => ({
                  message: error.message,
                  stack: error.stack,
                })),
                console: (await page?.consoleMessages())?.map((message) => ({
                  type: message.type(),
                  text: message.text(),
                })),
              },
              null,
              2,
            ),
          );
          await writeFile(testInfo.outputPath("runtime.log"), await readRuntimeLogs());
        },
      },
      async ({ page, manifest }) => {
        if (!manifest) throw new Error("Personal scenario is unavailable");
        await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
        const personal = (await invokeIpc(page, "spaces:list")).find(
          (entry) => entry.kind === "personal",
        )!;
        await page.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
        await openProjectBoard(page);
        await expect(
          page.locator(`[data-board-uuid-v7="${manifest.pageIdsByKey.source}"]:visible`),
        ).toBeVisible();
        await page.getByRole("button", { name: "Switch Space", exact: true }).click();
        await page.getByRole("menuitem", { name: "Join a Space…", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Join a Space" });
        await dialog
          .getByLabel("Invite URL")
          .fill(`${invite.url}?fingerprint=${invite.fingerprint}`);
        await expect(dialog.getByText("Certificate pinned", { exact: true })).toBeVisible();
        await expect(dialog.getByLabel("Certificate fingerprint")).toHaveCount(0);
        await dialog.getByLabel("One-time code").fill(invite.code);
        await dialog.getByLabel("Your name").fill("Alice");
        await page.screenshot({ path: path.join(screenshots, "01-join.png") });
        await dialog.getByRole("button", { name: "Join", exact: true }).click();
        await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("spaceId=");
        await expect(page.getByRole("button", { name: "Switch Space", exact: true })).toBeVisible();
        await expect
          .poll(
            async () =>
              (await invokeIpc(page, "spaces:list")).find((space) => space.kind === "team")?.name,
          )
          .toBe("Team Research");
        await expect(
          page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByText("Team Research", { exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Switch Space", exact: true }).click();
        await expect(
          page.getByRole("menuitem", { name: "Team Research", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("button", { name: "Automations", exact: true }),
        ).toHaveCount(0);
        await expect(invokeIpc(page, "sources:automation-options")).rejects.toThrow(
          "This feature runs on the Space host",
        );
        await page.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
        await openProjectBoard(page);
        const created = await cli<{ page_id: string }>(
          "page",
          "create",
          "--parent",
          `data_source:${dataSourceId}`,
          "--title",
          "Shared live Page",
          "--empty",
          "--idempotency-key",
          "team-space-live-page",
        );
        const card = page.locator(`[data-board-uuid-v7="${created.page_id}"]:visible`);
        await expect(card).toBeVisible({ timeout: 20_000 });
        await page.screenshot({ path: path.join(screenshots, "02-team-board.png") });
        await openBoardPageFromCard({ card, page, tabName: "Shared live Page" });
        const editor = page
          .locator(
            `[data-page-stage-page-id="${created.page_id}"]:visible .ProseMirror[contenteditable="true"]`,
          )
          .first();
        await editor.click();
        await page.keyboard.type("Edited from the team desktop");
        await expect
          .poll(async () => (await cli<{ content: string }>("read", created.page_id)).content, {
            timeout: 20_000,
          })
          .toContain("Edited from the team desktop");
        await page.screenshot({ path: path.join(screenshots, "03-team-edit.png") });
        const select = async (spaceId: string) => {
          const entry = (await invokeIpc(page, "spaces:list")).find(
            (space) => space.spaceId === spaceId,
          )!;
          await page.getByRole("button", { name: "Switch Space", exact: true }).click();
          await page.getByRole("menuitem").filter({ hasText: entry.name }).click();
          await expect(
            page.getByRole("button", { name: "Switch Space", exact: true }),
          ).toBeVisible();
        };
        const team = (await invokeIpc(page, "spaces:list")).find((entry) => entry.kind === "team")!;
        await select(personal.spaceId);
        await expect(
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("button", { name: "Automations", exact: true }),
        ).toBeVisible();
        await expect(
          page.locator(`[data-board-uuid-v7="${manifest.pageIdsByKey.source}"]:visible`),
        ).toBeVisible();
        await page.screenshot({ path: path.join(screenshots, "04-personal-restored.png") });
        await select(team.spaceId);
        await expect(editor).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: "Access revoked" })).toBeVisible({
          timeout: 20_000,
        });
        await page.screenshot({ path: path.join(screenshots, "05-revoked.png") });
        await select(personal.spaceId);
        await expect(
          page.locator(`[data-board-uuid-v7="${manifest.pageIdsByKey.source}"]:visible`),
        ).toBeVisible();
      },
    );
  });
});
