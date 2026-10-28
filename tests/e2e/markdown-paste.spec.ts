import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ElectronScenarioHarness,
  withElectronScenario,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { writeTestClipboardRichText } from "./clipboard";
import { invokeIpc } from "./support/editor-scenario";
import { createAgentSmokeDraft } from "./support/agent-smoke-harness";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

test("the chat Composer pastes rich text with every line it shows", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "markdown-paste-chat",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(process.cwd(), "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await createAgentSmokeDraft(page, harness.profile.runRoot, "Markdown paste");
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await composer.click();
    // A browser copy: one paragraph broken by <br>, then a list.
    await writeTestClipboardRichText(harness.application, {
      html: "<p>First line<br>second line</p><ul><li>one</li><li>two</li></ul>",
      text: "First line\nsecond line\none\ntwo",
    });
    await page.keyboard.press(primaryShortcut("v"));
    await expect(composer.locator("p")).toHaveText(["First line", "second line", "- one", "- two"]);
  } finally {
    await harness.close();
  }
});

test("the Inbox Composer pastes rich text as its Markdown and sends every line", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "markdown-paste-inbox", scenarioId: null },
    async ({ application, page }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestionsEnabled: false });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const composer = page.getByRole("textbox", { name: "Message your Inbox" });
      await composer.click();
      // A Notes copy: one <div> per line, bold as <b>, a blank line, then a list.
      await writeTestClipboardRichText(application, {
        html: "<div><b>Release</b> notes</div><div>second line</div><div><br></div><ul><li>one</li><li>two</li></ul>",
        text: "Release notes\nsecond line\n\none\ntwo",
      });
      await page.keyboard.press(primaryShortcut("v"));
      await expect(composer).toHaveValue("**Release** notes\nsecond line\n- one\n- two");

      await composer.press("Enter");
      const message = page.getByTestId("inbox-message").filter({ hasText: "second line" });
      await expect(message.getByText("Release", { exact: true })).toBeVisible();
      await expect(message.getByRole("listitem")).toHaveText(["one", "two"]);
      const [item] = (
        await invokeIpc(page, "inbox:window", { scope: { kind: "library" }, filter: "inbox" })
      ).items;
      expect(item?.body).toBe("**Release** notes\nsecond line\n\n- one\n- two");
    },
  );
});
