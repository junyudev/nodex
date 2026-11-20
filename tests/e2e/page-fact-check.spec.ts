import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { materializeDevelopmentSeed } from "../../scripts/scenarios/harness/development-seed";
import {
  responses,
  withScriptedModelServer,
  type ScriptedModelExchange,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  LAUNCH_REVIEW_INTERPRETATION,
  LAUNCH_REVIEW_PAGE_KEY,
} from "../../scripts/scenarios/scenarios/page-asks-and-comments";
import { invokeIpc } from "./support/editor-scenario";
import { nativeAppToolCall } from "./support/native-app-tools";
import {
  launchReviewSeed,
  openLaunchReview,
  reviewCard,
  reviewParagraph,
  selectReviewText,
} from "./support/page-launch-review";

/** A JSON value as a JavaScript literal the scripted tool code can embed safely. */
const scriptLiteral = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

test("Fact-check returns cited evidence and an accepted correction updates the Page", async ({}, testInfo) => {
  const claim = "Every entry point doubled after launch.";
  const correction = "In-place Ask drove most of the increase.";
  const revised = LAUNCH_REVIEW_INTERPRETATION.replace(claim, correction);
  const finding = "The chart shows different growth rates by entry point.";
  const callId = "page_fact_check_reply";
  let pageId: string | undefined;
  const exchange: ScriptedModelExchange = {
    name: "launch review Fact-check",
    match: (request) =>
      request.hasUserInputText("Ask from Page") || request.toolCallOutput(callId) !== null,
    expectedCalls: 2,
    maximumCalls: 2,
    respond(request, index) {
      if (index === 0) {
        expect(request.hasUserInputText("Is this true?")).toBe(true);
        const tool = request.toolInvocation("functions", "exec");
        if (!tool || !pageId)
          throw new Error("Fact-check requires the managed tools and fixture Page");
        const script = [
          "const read = (r) => { const data = typeof r === 'string' ? JSON.parse(r) : r; if (data.isError) throw new Error(JSON.stringify(data)); return data.structuredContent ?? (data.content ? JSON.parse(data.content[0].text) : data); };",
          `const result = read(await app.discussions_list({ pageId: ${scriptLiteral(pageId)} }));`,
          `const check = result.items.find((item) => item.quote === ${scriptLiteral(claim)});`,
          "if (check?.anchor.kind !== 'text') throw new Error('Missing text Check');",
          `text(read(await app.discussions_reply({ discussionId: check.id, comment: { ...${scriptLiteral(
            {
              body: finding,
              verdict: {
                result: "false",
                evidence: [{ title: "Weekly adoption chart", url: `nodex://pages/${pageId}` }],
              },
            },
          )}, suggestedEdit: { blockIds: [check.anchor.blockId], newMarkdown: ${scriptLiteral(revised)}, expectedOldMarkdown: ${scriptLiteral(LAUNCH_REVIEW_INTERPRETATION)} } } })));`,
        ].join("\n");
        return responses.stream([
          responses.created(callId),
          nativeAppToolCall(callId, tool.name, script, tool.namespace),
          responses.completed(callId),
        ]);
      }
      return responses.stream([
        responses.created(`${callId}_final`),
        responses.assistantMessage(`${callId}_message`, "I posted the verdict.", "final_answer"),
        responses.completed(`${callId}_final`, true),
      ]);
    },
  };

  await withScriptedModelServer({ exchanges: [exchange] }, async (model) => {
    const harness = await ElectronScenarioHarness.create({
      label: "page-fact-check",
      cwd: process.cwd(),
      prepareAgentRuntime: false,
      isolateHostDirectories: true,
      environment: {
        ...model.loopbackEnvironment(),
        OPENAI_API_KEY: "nodex-scripted-model-test-key",
        NODEX_LOG_FILE: "1",
      },
    });
    try {
      const manifest = await materializeDevelopmentSeed({
        scenarioId: launchReviewSeed.scenarioId,
        nodexHome: harness.profile.nodexHome,
      });
      pageId = manifest.pageIdsByKey[LAUNCH_REVIEW_PAGE_KEY];
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      const page = await harness.launch();
      const providers = await invokeIpc(page, "agent-runtime:providers:read", {
        refresh: true,
        instanceIds: ["codex"],
      });
      const modelSlug = providers.find(({ instanceId }) => instanceId === "codex")?.models[0]?.slug;
      if (!modelSlug) throw new Error("The scripted Codex runtime did not advertise a model");
      await invokeIpc(page, "settings:inbox:update", {
        suggestionAgent: {
          instanceId: "codex",
          model: modelSlug,
          reasoningEffort: null,
          serviceTier: null,
        },
      });
      const stage = await openLaunchReview(page, manifest);
      const paragraph = reviewParagraph(stage, "In-place Ask accounts for about a third");

      await selectReviewText(page, paragraph, claim);
      await page.getByRole("button", { name: "Fact-check", exact: true }).click();
      const card = reviewCard(page, finding);
      await expect(card.locator('[data-verdict="false"]')).toBeVisible();
      await expect(card.getByRole("link", { name: "Weekly adoption chart" })).toBeVisible();
      const edit = card.locator('[data-suggested-edit="open"]');
      await expect(edit).toBeVisible();
      await expect(paragraph).toHaveText(LAUNCH_REVIEW_INTERPRETATION);
      await edit.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(paragraph).toHaveText(revised);
      await expect(card.locator('[data-suggested-edit="accepted"]')).toBeVisible();
    } catch (error) {
      await testInfo.attach("fact-check-runtime", {
        body: await readBoundedElectronRuntimeLogs(harness.profile),
        contentType: "text/plain",
      });
      throw error;
    } finally {
      await harness.close();
    }
  });
});
