import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { components } from "@nodex/core-protocol";
import { expect, type Page } from "@playwright/test";
import { withElectronScenario } from "../../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { openProjectBoard } from "../../../scripts/scenarios/harness/project-board-ui";
import { LocalHttpTransport } from "../../../src/main/core-client/local-http";
import { readCoreRuntimeConnection } from "../../../src/main/core-client/runtime-descriptor";
import type { CoreClient } from "../../../src/main/core-client/core-client";
import { invokeIpc } from "./editor-scenario";
import { openBoardPageFromCard } from "./open-board-page";

/** Three real minutes of paced navigation and edits, with both renderers alive behind one IP.
 * Clock waits define the workload cadence; every edit synchronizes on Core and rendered content.
 */
export async function proveTwoDesktopBudget(input: {
  alice: Page;
  host: CoreClient;
  home: string;
  projectId: string;
  pageId: string;
  invite: { url: string; fingerprint: string; code: string };
  question: { sessionId: string; runId: string; requestId: string };
  answerQuestion: () => Promise<void>;
  screenshots: string;
  evidence: string;
}) {
  const runtime = readCoreRuntimeConnection(input.home);
  const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
  const stats = () =>
    admin.requestJson<components["schemas"]["RemoteTransportStats"]>(
      "GET",
      "/core/v1/admin/space/transport-stats",
    );
  const samples: components["schemas"]["RemoteTransportStats"][] = [];
  const startedAt = Date.now();
  const participants = {
    alice: (await invokeIpc(input.alice, "spaces:context")).memberId,
    bob: null as string | null,
  };
  await withElectronScenario(
    { label: "budget-bob", scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID, seedThrough: "core" },
    async ({ page: bob }) => {
      await bob.getByRole("button", { name: "Switch Space", exact: true }).click();
      await bob.getByRole("menuitem", { name: "Join a Space…", exact: true }).click();
      const dialog = bob.getByRole("dialog", { name: "Join a Space" });
      await dialog
        .getByLabel("Invite URL")
        .fill(`${input.invite.url}?fingerprint=${input.invite.fingerprint}`);
      await dialog.getByLabel("One-time code").fill(input.invite.code);
      await dialog.getByLabel("Your name").fill("Bob");
      await dialog.getByRole("button", { name: "Join", exact: true }).click();
      await expect.poll(() => bob.url(), { timeout: 30_000 }).toContain("spaceId=");
      participants.bob = (await invokeIpc(bob, "spaces:context")).memberId;
      // An operation denial traverses the real desktop IPC/authority/HTTPS seam.
      await expect(
        invokeIpc(bob, "agent-runtime:session:respond", {
          ...input.question,
          answers: { scope: "Project" },
        }),
      ).rejects.toThrow();
      expect((await invokeIpc(bob, "spaces:context")).availability).toBe("ready");
      await invokeIpc(bob, "inbox:window", {
        scope: { kind: "all" },
        after: null,
        first: 50,
      });
      await bob.getByRole("button", { name: "Open Host Project", exact: true }).click();
      await openProjectBoard(bob);
      let title = "Budget navigation Page";
      const card = bob.locator(`[data-board-uuid-v7="${input.pageId}"]:visible`);
      await expect(card).toBeVisible();
      await input.answerQuestion();
      await input.alice
        .getByRole("button", { name: "Host runner task", exact: true })
        .and(input.alice.locator("[data-app-action-sidebar-thread-row]"))
        .click();
      const composer = input.alice.locator('[data-codex-composer="true"]:visible').first();
      await expect(
        input.alice.getByText("Host work is ready. The member answered the question.", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(composer).toBeEditable({ timeout: 20_000 });
      await composer.fill("Retain this unsent draft during refresh");
      const workloadStart = Date.now();
      for (let index = 1; index <= 12; index++) {
        await openProjectBoard(bob);
        await expect(card).toContainText(title);
        await openBoardPageFromCard({ card, page: bob, tabName: title });
        const stage = bob.locator(`[data-page-stage-page-id="${input.pageId}"]:visible`).first();
        title = `Budget navigation Page ${index}`;
        await stage.getByRole("textbox", { name: "Page title", exact: true }).fill(title);
        const editor = stage.locator('.ProseMirror[contenteditable="true"]').first();
        await editor.click();
        await bob.keyboard.press("ControlOrMeta+End");
        await bob.keyboard.type(` Normal Page edit ${index}.`);
        await expect
          .poll(
            async () => {
              const draft = await input.host.libraryRead({
                kind: "page_draft_projection",
                page_id: input.pageId,
              });
              return draft.value.kind === "page_draft_projection"
                ? draft.value.value.body_markdown
                : "";
            },
            { timeout: 20_000 },
          )
          .toContain(`Normal Page edit ${index}.`);
        // The loaded hosted transcript and its draft stay available through every background refresh.
        await expect(composer).toBeEditable();
        await expect(composer).toHaveText("Retain this unsent draft during refresh");
        expect((await invokeIpc(input.alice, "spaces:context")).availability).toBe("ready");
        expect((await invokeIpc(bob, "spaces:context")).availability).toBe("ready");
        samples.push(await stats());
        await expect
          .poll(() => Date.now() - workloadStart, { timeout: 20_000, intervals: [1_000] })
          .toBeGreaterThanOrEqual(index * 15_000);
      }
      await openProjectBoard(bob);
      await expect(card).toContainText(title);
      samples.push(await stats());
      await input.alice.screenshot({
        path: path.join(input.screenshots, "budget-alice-transcript.png"),
      });
      await bob.screenshot({ path: path.join(input.screenshots, "budget-bob-board.png") });
      await composer.fill("");
      await input.alice.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
    },
  );
  const logs = (await readdir(path.join(input.home, "logs"))).filter(
    (name) => name.startsWith("core-") && name.endsWith(".log"),
  );
  const rateLimits = (
    await Promise.all(logs.map((name) => readFile(path.join(input.home, "logs", name), "utf8")))
  )
    .flatMap((text) =>
      text
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { ts?: string; status?: number }),
    )
    .filter((event) => event.status === 429 && Date.parse(event.ts ?? "") >= startedAt);
  await writeFile(
    input.evidence,
    JSON.stringify(
      {
        durationMs: Date.now() - startedAt,
        minutes: 3,
        edits: 12,
        participants,
        rateLimits,
        logFileCount: logs.length,
        samples,
      },
      null,
      2,
    ),
  );
  expect(logs.length).toBeGreaterThan(0);
  expect(rateLimits).toEqual([]);
  for (const sample of samples) expect(sample.refusals).toEqual({});
}
