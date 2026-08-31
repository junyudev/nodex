import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

const repositoryRoot = process.cwd();

interface NewChatTransitionSample {
  readonly atMs: number;
  readonly composerText: string | null;
  readonly hasNewChatHome: boolean;
  readonly hasUserMessage: boolean;
  readonly initialComposerConnected: boolean;
}

const createHarness = async (): Promise<ElectronScenarioHarness> => {
  const harness = await ElectronScenarioHarness.create({
    label: "new-chat-lifecycle",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(repositoryRoot, "tests/e2e/fixtures/codex-subagent-app-server.mjs"),
  );
  return harness;
};

const beginTransitionCapture = async (page: Page, prompt: string): Promise<void> => {
  await page.evaluate((expectedPrompt) => {
    const scope = window as typeof window & {
      __newChatTransitionObserver?: MutationObserver;
      __newChatTransitionSamples?: NewChatTransitionSample[];
    };
    scope.__newChatTransitionObserver?.disconnect();
    scope.__newChatTransitionSamples = [];
    const initialComposer = document.querySelector<HTMLElement>("[data-codex-composer='true']");
    const sample = () => {
      const composer = document.querySelector<HTMLElement>("[data-codex-composer='true']");
      const hasNewChatHome = document.querySelector("[data-new-thread-home-main='true']") !== null;
      const hasUserMessage = Array.from(
        document.querySelectorAll<HTMLElement>("[data-user-message-bubble='true']"),
      ).some((bubble) => bubble.textContent?.includes(expectedPrompt) === true);
      const next = {
        atMs: Date.now(),
        composerText: composer?.textContent ?? null,
        hasNewChatHome,
        hasUserMessage,
        initialComposerConnected: initialComposer?.isConnected === true,
      };
      const previous = scope.__newChatTransitionSamples?.at(-1);
      if (
        previous?.composerText === next.composerText &&
        previous.hasNewChatHome === next.hasNewChatHome &&
        previous.hasUserMessage === next.hasUserMessage &&
        previous.initialComposerConnected === next.initialComposerConnected
      ) {
        return;
      }
      scope.__newChatTransitionSamples?.push(next);
    };
    sample();
    scope.__newChatTransitionObserver = new MutationObserver(sample);
    scope.__newChatTransitionObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }, prompt);
};

const readTransitionSamples = async (page: Page): Promise<NewChatTransitionSample[]> =>
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __newChatTransitionObserver?: MutationObserver;
      __newChatTransitionSamples?: NewChatTransitionSample[];
    };
    scope.__newChatTransitionObserver?.disconnect();
    return scope.__newChatTransitionSamples ?? [];
  });

test("Enter atomically moves a New Chat draft into its first user message", async () => {
  test.setTimeout(120_000);
  const harness = await createHarness();
  const promptText = "Trace the first-send lifecycle";

  try {
    const page = await harness.launch();
    await page.evaluate(
      async ({ packageRoot, nodeExecutable, credentialHome }) => {
        await window.api?.invoke("settings:acp-agents:update", {
          instances: [
            {
              id: "new-chat-lifecycle-acp",
              agentDefinitionId: "claude-agent-acp",
              packageRoot,
              nodeExecutable,
              enabled: true,
              credentials: { kind: "isolated-home", home: credentialHome },
              proxy: "isolated",
            },
          ],
        });
      },
      {
        packageRoot: repositoryRoot,
        nodeExecutable: process.execPath,
        credentialHome: harness.profile.runRoot,
      },
    );
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator("[data-new-thread-backend-selector='true']")).toBeVisible();

    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible();
    await composer.fill(promptText);
    await expect(composer).toHaveText(promptText);
    await beginTransitionCapture(page, promptText);

    await composer.press("Enter");

    const userMessage = page.locator("[data-user-message-bubble='true']", {
      hasText: promptText,
    });
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    const activeComposer = page.locator("[data-codex-composer='true']").first();
    await expect(activeComposer).toHaveText("");

    const samples = await readTransitionSamples(page);
    expect(samples.some((sample) => !sample.hasNewChatHome && !sample.hasUserMessage)).toBe(false);
    expect(
      samples.some((sample) => !sample.hasUserMessage && !sample.initialComposerConnected),
    ).toBe(false);
  } finally {
    await harness.close();
  }
});
