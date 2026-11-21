import { mkdir, writeFile, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft } from "./support/agent-smoke-harness";

test("keeps local file search responsive and discovers live skill changes", async ({}, testInfo) => {
  const harness = await ElectronScenarioHarness.create({
    label: "composer-search",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_SKILL_COUNT: "800",
      NODEX_FAKE_CODEX_SKILL_DIRECTORY: ".agents/skills",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(process.cwd(), "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const directory = path.join(harness.profile.runRoot, "fuzzy-directory");
    const ignored = path.join(harness.profile.runRoot, "node_modules");
    const file = path.join(directory, "fuzzy-match.ts");
    await Promise.all([mkdir(directory), mkdir(ignored)]);
    await Promise.all([writeFile(file, ""), writeFile(path.join(ignored, "fuzzy-match.ts"), "")]);

    const page = await harness.launch();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await createAgentSmokeDraft(page, harness.profile.runRoot, "Composer search");
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await composer.fill("@abc");
    await expect(page.getByText("Abc Tool 0", { exact: true })).toBeVisible();
    const elapsed: number[] = [];
    for (const query of ["@a", "@ab", "@abc", "@aaaaaaaaaaaaab", "@abc-tool-799"]) {
      const start = performance.now();
      await composer.fill(query);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      elapsed.push(performance.now() - start);
      await expect(composer).toHaveText(query);
    }
    await expect(page.getByText("Abc Tool 799", { exact: true })).toBeVisible();
    await composer.press("Enter");
    await expect(composer.locator('[data-mention-kind="skill"]')).toHaveAttribute(
      "data-mention-name",
      "abc-tool-799",
    );
    await composer.fill("@fumat");
    await expect(page.getByText("fuzzy-match.ts", { exact: true })).toHaveCount(1);
    await composer.press("Enter");
    await expect(composer.locator('[data-mention-kind="file"]')).toHaveAttribute(
      "data-mention-fs-path",
      file,
    );
    await composer.fill("@fuzdir");
    const folder = page.locator(`[data-add-context-row=${JSON.stringify(`file:${directory}`)}]`);
    await expect(folder).toBeVisible();
    await folder.hover();
    await composer.press("Tab");
    await expect(composer).toHaveText("@fuzzy-directory/");
    await expect(composer.locator('[data-composer-mention="true"]')).toHaveCount(0);
    await expect(page.getByText("fuzzy-match.ts", { exact: true })).toHaveCount(1);
    await composer.press("Enter");
    await expect(composer.locator('[data-mention-kind="file"]')).toHaveAttribute(
      "data-mention-fs-path",
      file,
    );
    await composer.fill("@live-added-skill");
    const skillDirectory = path.join(harness.profile.runRoot, ".agents/skills/live-added-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: live-added-skill\ndescription: Live discovered scenario skill\n---\nA test fixture.\n",
    );
    const liveSkill = page.getByText("Live Added Skill", { exact: true });
    await expect(liveSkill).toBeVisible();
    await liveSkill.hover();
    await composer.press("Enter");
    await expect(composer.locator('[data-mention-kind="skill"]')).toHaveAttribute(
      "data-mention-name",
      "live-added-skill",
    );
    await expect(async () => {
      const requests = (
        await readFile(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.method === "rpc")
        .map((entry) => entry.params);
      expect(requests.some((request) => request.method.startsWith("fuzzyFileSearch/"))).toBe(false);
      expect(requests.filter((request) => request.method === "skills/list").length).toBeGreaterThan(
        1,
      );
    }).toPass();
    expect(errors).toEqual([]);
    await testInfo.attach("query-roundtrip-ms", {
      body: JSON.stringify(elapsed),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("runtime-requests", {
      body: await readFile(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl")),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});
