import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

test("Inbox sends only the reviewed Codex skill and preserves the person's invocation", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const log = testInfo.outputPath("codex-wire.jsonl");
  await mkdir(dirname(log), { recursive: true });
  await withElectronScenario(
    {
      label: "inbox-skill-suggestions",
      scenarioId: "inbox/triage",
      seedThrough: "core",
      environment: {
        NODEX_FAKE_CODEX_LOG_PATH: log,
        NODEX_FAKE_CODEX_INBOX_SKILLS: "1",
      },
    },
    async ({ page, manifest }) => {
      await invokeIpc(page, "settings:inbox:update", {
        suggestions: "off",
        showPageBesideNewChats: false,
      });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const row = page.locator(
        `[data-inbox-scope="library"] [data-inbox-page-id="${manifest!.pageIdsByKey.newChatSuggestion}"]`,
      );
      const dropped = row.getByRole("button", { name: "Use positioning-review skill" });
      await expect(dropped).toHaveAttribute("aria-pressed", "true");
      await dropped.click();
      await expect(dropped).toHaveAttribute("aria-pressed", "false");
      await row.getByRole("button", { name: "New chat in Nodex", exact: true }).click();

      await expect
        .poll(
          async () => {
            const records = (await readFile(log, "utf8").catch(() => ""))
              .split("\n")
              .filter(Boolean);
            const inputs = records
              .map((line) => JSON.parse(line))
              .filter(({ method }) => method === "turn/start")
              .map(
                ({ params }) => params.input as { type: string; text?: string; name?: string }[],
              );
            return inputs
              .find((input) => input.some((item) => item.text?.includes("$positioning-context")))
              ?.filter((item) => item.type === "skill")
              .map((item) => item.name);
          },
          { timeout: 60_000 },
        )
        .toEqual(["homepage-audit"]);
    },
  );
});
