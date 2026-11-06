import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  startScriptedAnthropicServer,
  anthropicToolResult,
  type AnthropicRequest,
} from "../../scripts/scenarios/runtime/scripted-anthropic-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  sendAgentFollowUp,
  readRuntimeConversation,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import { chooseComposerModel, refreshComposerModels } from "./support/composer-model-picker";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";

const evidenceRoot = process.env.NODEX_CDT_EVIDENCE_DIR;
const saveEvidence = (name: string, value: unknown) => {
  if (!evidenceRoot) return;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, name), JSON.stringify(value, null, 2));
};
const screenshot = async (page: Page, name: string) => {
  const file = test.info().outputPath(name);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: "image/png" });
  if (!evidenceRoot) return;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.copyFileSync(file, path.join(evidenceRoot, name));
};
const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});
const js = (id: string, code: string, title: string, timeout_ms = 30_000) =>
  tool(id, "mcp__node_repl__js", { code, title, timeout_ms });
const text = (value: unknown) => JSON.stringify(value);

const backgroundTitleResponse = (request: AnthropicRequest) => {
  if (
    !request.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("provide a short title for a task"),
    )
  )
    return undefined;
  return anthropicToolResult(request, "background_title")
    ? { type: "text" as const, text: "Title complete" }
    : tool("background_title", "StructuredOutput", {
        title: "Claude Browser test",
        description: "Drive the isolated in-app Browser",
      });
};

const configureClaude = async (
  page: Page,
  harness: ElectronScenarioHarness,
  environment: Record<string, string>,
) => {
  await invokeIpc(page, "settings:claude-agents:update", {
    instances: [
      {
        id: "claude-default",
        displayName: "Claude Code",
        binaryPath: createRequire(
          createRequire(path.join(process.cwd(), "package.json")).resolve(
            "@anthropic-ai/claude-agent-sdk",
          ),
        ).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`),
        configDirectory: harness.profile.claudeConfigHome,
        enabled: true,
        environment: Object.entries(environment).map(([name, value]) => ({
          name,
          value,
          sensitive: false,
        })),
      },
    ],
  });
};
const activeExecs = (
  home: string,
): { kernelPid: number; nodeReplPid: number; codexPid: number }[] => {
  const directory = path.join(home, "node_repl/active_execs");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))];
      } catch {
        return [];
      }
    });
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const mode of ["full-access", "approval-required"] as const) {
  test(`Claude drives the real in-app Browser with ${mode}`, async () => {
    test.setTimeout(240_000);
    const fixture = await startBrowserHttpFixture(`CLAUDE_BROWSER_${mode}`);
    let phase = 0;
    let pluginRoot = "";
    let documentationResult = "";
    let originDeclined = false;
    let releaseFinal: () => void = () => {};
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    let computerUseReady: boolean | undefined;
    const results: Record<string, unknown> = {};
    const server = await startScriptedAnthropicServer(async (request) => {
      const background = backgroundTitleResponse(request);
      if (background) return background;
      const previousPhase = phase;
      try {
        const result = (id: string) => {
          const value = anthropicToolResult(request, id);
          expect(value, `CLI returned ${id}`).toBeDefined();
          results[id] = value;
          return value;
        };
        if (phase++ === 0) {
          saveEvidence(`${mode}-first-request.json`, request);
          const repl = request.tools.find((candidate) => candidate.name === "mcp__node_repl__js");
          expect(repl).toBeDefined();
          expect(repl?.defer_loading).not.toBe(true);
          expect(request.tools.some((candidate) => candidate.name.includes("turn_ended"))).toBe(
            false,
          );
          expect(text(request)).toContain("browser:control-in-app-browser");
          expect(text(request).includes("computer-use:computer-use")).toBe(computerUseReady);
          return tool("skill", "Skill", { skill: "browser:control-in-app-browser" });
        }
        if (phase === 2) {
          result("skill");
          // The CLI sends skill text in a separate user message after its tool-result acknowledgement.
          const content = request.messages
            .flatMap((message) =>
              typeof message.content === "string"
                ? [message.content]
                : message.content.flatMap((block) =>
                    block.type === "text" ? [block.text ?? ""] : [],
                  ),
            )
            .join("\n");
          const base = /Base directory for this skill: ([^\r\n]+)/u.exec(content)?.[1]?.trim();
          expect(base).toBeTruthy();
          pluginRoot = path.resolve(base!, "../..");
          expect(fs.existsSync(path.join(pluginRoot, "scripts/browser-client.mjs"))).toBe(true);
          return js(
            "bootstrap",
            `const { setupBrowserRuntime } = await import(${JSON.stringify(path.join(pluginRoot, "scripts/browser-client.mjs"))}); const agent = await setupBrowserRuntime(); const iab = await agent.browsers.get("iab"); const docs = await iab.documentation(); nodeRepl.write(JSON.stringify({documentationCharacters: docs.length})); nodeRepl.write(docs); const kept = 37;`,
            "Read in-app Browser documentation",
          );
        }
        if (phase === 3) {
          documentationResult = text(result("bootstrap"));
          expect(documentationResult).toContain("documentationCharacters");
          saveEvidence(`${mode}-documentation-result.json`, results.bootstrap);
          return js(
            "navigate",
            `const tab = await iab.tabs.new(); await tab.goto(${JSON.stringify(fixture.url)}); await tab.markDeliverable(); await (await iab.capabilities.get("visibility")).set(true); nodeRepl.write(JSON.stringify({title: await tab.title(), url: await tab.url()})); await nodeRepl.emitImage(await tab.screenshot({fullPage:false}));`,
            "Open the Claude Browser fixture",
          );
        }
        if (phase === 4) {
          const navigation = result("navigate");
          if (mode === "full-access") {
            expect(text(navigation)).toContain(`CLAUDE_BROWSER_${mode}`);
            expect(text(navigation)).toContain('"image"');
          } else if (originDeclined) {
            expect(navigation).toMatchObject({ is_error: true });
          } else {
            expect(text(navigation)).toContain(`CLAUDE_BROWSER_${mode}`);
          }
          if (mode === "full-access") await finalGate;
          return { type: "text", text: "CLAUDE_BROWSER_TURN_ONE_DONE" };
        }
        if (phase === 5)
          return js("memory", "nodeRepl.write({kept});", "Read retained JavaScript binding");
        if (phase === 6) {
          expect(text(result("memory"))).toContain("37");
          return { type: "text", text: "CLAUDE_MEMORY_DONE" };
        }
        if (phase === 7)
          return js(
            "stop",
            "await new Promise(resolve => setTimeout(resolve, 120000));",
            "Wait for Stop",
            150_000,
          );
        // Stop can make one final request before the query is closed.
        if (
          text(request.messages.at(-1)).includes('"tool_use_id":"stop"') &&
          !text(request.messages.at(-1)).includes("Use JavaScript again")
        )
          return { type: "text", text: "Stopped" };
        if (!anthropicToolResult(request, "reset"))
          return js(
            "reset",
            "nodeRepl.write({bindingType:typeof kept});",
            "Read binding after cancelled kernel",
          );
        expect(text(result("reset"))).toContain("undefined");
        return { type: "text", text: "CLAUDE_RESET_DONE" };
      } catch (error) {
        phase = previousPhase;
        throw error;
      }
    });
    const harness = await ElectronScenarioHarness.create({
      label: `cdt-e2e-${mode}`,
      retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
      prepareAgentRuntime: false,
      environment: {
        ...server.environment,
        NODEX_LOG_FILE: "1",
        NODEX_LOG_FILE_LEVEL: "debug",
        NODEX_LOG_CONSOLE: "0",
      },
    });
    let failurePage: Page | undefined;
    try {
      const page = await harness.launch();
      failurePage = page;
      const diagnosticChunks: string[] = [];
      harness.application.process().stderr?.on("data", (chunk) => {
        diagnosticChunks.push(String(chunk));
        saveEvidence(`${mode}-stderr.json`, diagnosticChunks.join(""));
      });
      harness.application.process().stdout?.on("data", (chunk) => {
        diagnosticChunks.push(String(chunk));
        saveEvidence(`${mode}-stderr.json`, diagnosticChunks.join(""));
      });
      await configureClaude(page, harness, server.environment);
      const computer = (await invokeIpc(page, "computer-use-settings-get")) as {
        available: boolean;
      };
      computerUseReady = computer.available;
      saveEvidence(`${mode}-computer-gate.json`, { available: computer.available });
      const draft = await createAgentSmokeDraft(
        page,
        harness.profile.initialProjectsDirectory,
        `Claude Browser ${mode}`,
      );
      await refreshComposerModels(page);
      await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
      await page.keyboard.press("Escape");
      const permissionLabel = mode === "full-access" ? "Full access" : "Ask for approval";
      if (
        (await page
          .getByRole("button", { name: `Permissions: ${permissionLabel}`, exact: true })
          .count()) === 0
      ) {
        await page.getByRole("button", { name: /^Permissions:/ }).click();
        await page.getByRole("menuitem", { name: new RegExp(permissionLabel) }).click();
        if (mode === "full-access")
          await page.getByRole("button", { name: "Turn on", exact: true }).click();
      }
      if (mode === "full-access") {
        await invokeIpc(page, "browser-use-policy-update-origin-rule", {
          action: "add",
          kind: "allowed",
          origin: new URL(fixture.url).origin,
          resource: "origin",
        });
      }
      const threadId = await sendAgentPrompt(
        page,
        draft.projectSessionId,
        "Use the Browser skill to open and show the supplied loopback fixture in the in-app Browser, take a screenshot, and keep the tab as a deliverable.",
      );
      const target = { sessionId: draft.projectSessionId, threadId };
      if (mode === "approval-required") {
        const more = page.getByRole("button", { name: "More approval options", exact: true });
        await expect(more).toBeVisible({ timeout: 30_000 });
        await more.click();
        const allow = page.getByRole("menuitem", {
          name: "Allow JavaScript for this chat",
          exact: true,
        });
        await expect(allow).toBeVisible();
        // A person approves the code itself, not its JSON envelope or the tool's internal name.
        await expect(page.getByText("mcp__node_repl__js")).toHaveCount(0);
        saveEvidence("approval-card.json", {
          aria: await page.locator("body").ariaSnapshot(),
          conversation: await readRuntimeConversation(page, target),
        });
        await screenshot(page, "claude-tool-approval.png");
        await allow.click();
        // Wait for a fresh pending request; the resolved native card remains visible but inert.
        let originPending = false;
        await expect
          .poll(
            async () => {
              if (results.navigate) return "completed";
              const state = await readRuntimeConversation(page, target);
              const pending = state.snapshot.projection.runtimeRequests.filter(
                (request) => request.status === "pending",
              );
              if (pending.some((request) => request.kind === "mcp-elicitation")) {
                originPending = true;
                return "origin";
              }
              expect(
                pending.filter((request) => request.kind === "command"),
                "The next JS call must use the chat grant",
              ).toEqual([]);
              return "waiting";
            },
            { timeout: 30_000 },
          )
          .not.toBe("waiting");
        if (originPending) {
          await expect(page.getByRole("button", { name: "Decline", exact: true })).toBeEnabled();
          saveEvidence("origin-approval-card.json", await page.locator("body").ariaSnapshot());
          await expect(
            page.getByRole("button", { name: /^Approve(?: once)?$/, exact: true }),
          ).toBeEnabled();
          await page.getByRole("button", { name: "More approval options", exact: true }).click();
          // Origin requests in this runtime advertise no session persistence. Do not invent a grant.
          await expect(page.getByRole("menuitem", { name: /for this chat$/ })).toHaveCount(0);
          test.info().annotations.push({
            type: "runtime-gap",
            description:
              "Origin consent does not advertise a for-this-chat option; SDK MCP fixture tests cover session grants when advertised.",
          });
          saveEvidence("origin-request.json", await readRuntimeConversation(page, target));
          await screenshot(page, "claude-origin-approval.png");
          await page.keyboard.press("Escape");
          originDeclined = true;
          await page.getByRole("button", { name: "Decline", exact: true }).click();
        }
      }
      if (mode === "full-access") {
        await expect.poll(() => Boolean(results.navigate), { timeout: 30_000 }).toBe(true);
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await page.keyboard.press("g");
        await page.keyboard.press("p");
        await expect(page.getByTestId("library-primary-surface")).toHaveCount(1);
        await expect(
          page.locator(
            '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="retained"]',
          ),
        ).toHaveCount(1);
        saveEvidence(
          "retained-browser-host.json",
          await invokeIpc(page, "browser-sidebar-runtime-snapshot"),
        );
        releaseFinal();
      }
      await waitForRuntimeCompletedAgentTurn(page, target, 45_000);
      if (mode === "full-access") {
        await page
          .getByRole("navigation", { name: "App navigation" })
          .getByRole("button", { name: "Home", exact: true })
          .click();
        await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
      }
      const conversation = await readRuntimeConversation(page, target);
      saveEvidence(`${mode}-conversation.json`, conversation);
      const mcp = conversation.snapshot.projection.visibleTurnItems
        .map((visible) => visible.item)
        .filter((item) => item.type === "dynamic_tool" && item.mcpToolCall?.server === "node_repl");
      expect(mcp.length).toBeGreaterThanOrEqual(2);
      if (originDeclined)
        expect(mcp.at(-1)).toMatchObject({
          mcpToolCall: { status: "failed", error: { message: expect.any(String) } },
        });
      if (mode === "full-access") {
        expect(fixture.requests).toContain("/browser-smoke");
        await expect
          .poll(async () => {
            const snapshot = (await invokeIpc(
              page,
              "browser-sidebar-runtime-snapshot",
            )) as import("../../src/shared/browser-sidebar").BrowserSidebarRuntimeSnapshot;
            return snapshot.state.tabs.find((tab) => tab.url === fixture.url)
              ?.browserConversationId;
          })
          .toBe(draft.projectSessionId);
        saveEvidence(
          "browser-surface.json",
          await invokeIpc(page, "browser-sidebar-runtime-snapshot"),
        );
        const activity = page.getByRole("button", { name: /^Worked for/u });
        if ((await activity.count()) && (await activity.getAttribute("aria-expanded")) !== "true")
          await activity.click();
        const groupBody = page.getByTestId("agent-activity-group-body");
        if ((await groupBody.count()) && (await groupBody.getAttribute("aria-hidden")) === "true")
          await groupBody.locator("..").getByRole("button").first().click();
        const row = page.getByRole("button", {
          name: "Open the Claude Browser fixture",
          exact: true,
        });
        await expect(row).toBeVisible();
        await row.click();
        const image = page.getByRole("img", { name: "Tool output", exact: true });
        await expect(image).toBeVisible();
        await expect
          .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBeGreaterThan(0);
        const navigation = results.navigate as { content: { type: string }[] };
        const imageIndex = navigation.content.findIndex((block) => block.type === "image");
        expect(imageIndex).toBeGreaterThanOrEqual(0);
        const screenshotItem = mcp.find(
          (item) => item.type === "dynamic_tool" && item.mcpToolCall?.id === "navigate",
        )!;
        const attachment = (await invokeIpc(page, "agent-runtime:session:attachment", {
          ...target,
          itemId: screenshotItem.id,
          attachmentId: `tool-result:${imageIndex}`,
        })) as { dataUrl: string };
        expect(attachment.dataUrl).toBe(await image.getAttribute("src"));
        saveEvidence("screenshot-attachment.json", {
          itemId: screenshotItem.id,
          attachmentId: `tool-result:${imageIndex}`,
          dataUrlCharacters: attachment.dataUrl.length,
        });
        await screenshot(page, "claude-browser-mcp.png");
      }
      if (mode === "approval-required") {
        expect(server.errors).toEqual([]);
        saveEvidence("approval-required-results.json", { results, originDeclined });
        if (originDeclined) expect(fixture.requests).toEqual([]);
        return;
      }
      await sendAgentFollowUp(page, "Read the binding from the previous Turn.");
      await waitForFinalMarker(page, "CLAUDE_MEMORY_DONE");
      await sendAgentFollowUp(page, "Start a long JavaScript call so I can stop it.");
      await expect
        .poll(() => activeExecs(harness.profile.codexHome), { timeout: 30_000 })
        .not.toEqual([]);
      const records = activeExecs(harness.profile.codexHome);
      expect(records[0]!.kernelPid).toBeGreaterThan(0);
      expect(records[0]!.nodeReplPid).toBeGreaterThan(0);
      // Follow only the process ancestry recorded by this isolated Profile's active execution.
      const parentOf = (pid: number) =>
        Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
      const codexPid = parentOf(records[0]!.nodeReplPid);
      const launcherPid = parentOf(codexPid);
      const launcherCommand = execFileSync("ps", ["-p", String(launcherPid), "-o", "command="], {
        encoding: "utf8",
      });
      expect(launcherCommand).toContain(
        path.resolve(".generated/codex-runtime/agent-runtime/browser-runtime"),
      );
      const bridgePids = [records[0]!.nodeReplPid, codexPid, launcherPid];
      const stoppedAt = Date.now();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readRuntimeConversation(page, target)).snapshot.projection.runs.at(-1)?.status,
          { timeout: 10_000 },
        )
        .toBe("interrupted");
      await expect
        .poll(() => activeExecs(harness.profile.codexHome), { timeout: 5_000 })
        .toEqual([]);
      await expect.poll(() => alive(records[0]!.kernelPid), { timeout: 5000 }).toBe(false);
      saveEvidence(`${mode}-stop.json`, { elapsedMs: Date.now() - stoppedAt, records, bridgePids });
      await sendAgentFollowUp(
        page,
        "Use JavaScript again and check whether the old binding exists.",
      );
      await waitForFinalMarker(page, "CLAUDE_RESET_DONE");
      expect(server.errors).toEqual([]);
      saveEvidence(`${mode}-results.json`, {
        results,
        documentationResultCharacters: documentationResult.length,
        originDeclined,
        paths: server.paths,
      });
      // The bridge's detached process group contains its replacement kernel too.
      const ownedPids = execFileSync("ps", ["-g", String(launcherPid), "-o", "pid="], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/u)
        .map(Number);
      expect(ownedPids).toEqual(expect.arrayContaining(bridgePids));
      expect(ownedPids.length).toBeGreaterThan(bridgePids.length);
      await invokeIpc(page, "project-sessions:archive", {
        operationId: createBoundedOperationId("e2e.cdt.archive"),
        payload: { sessionId: draft.projectSessionId },
      });
      await expect
        .poll(() => ownedPids.map(alive), { timeout: 5_000 })
        .toEqual(ownedPids.map(() => false));
      saveEvidence("lifecycle.json", {
        bridgePids,
        ownedPids,
        bridgeAlive: ownedPids.map(alive),
        kernelAlive: alive(records[0]!.kernelPid),
        activeExecs: activeExecs(harness.profile.codexHome),
      });
      // Browsers read this registration from the real home; a scenario must not take it over.
      const realManifest = path.join(
        os.homedir(),
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
      );
      if (fs.existsSync(realManifest))
        expect(fs.readFileSync(realManifest, "utf8")).not.toContain(
          path.basename(harness.profile.runRoot),
        );
    } catch (error) {
      if (failurePage) await screenshot(failurePage, `${mode}-failure.png`).catch(() => {});
      const logDir = path.join(harness.profile.nodexHome, "logs");
      for (const name of fs.readdirSync(logDir).filter((name) => name.startsWith("backend")))
        saveEvidence(`${mode}-${name}.json`, fs.readFileSync(path.join(logDir, name), "utf8"));
      saveEvidence(`${mode}-failure.json`, {
        error: String(error),
        phase,
        results,
        errors: server.errors,
        logs: await readBoundedElectronRuntimeLogs(harness.profile, 90_000),
      });
      throw error;
    } finally {
      releaseFinal();
      saveEvidence(`${mode}-model-requests.json`, server.requests);
      await harness.close();
      await server.close();
      await fixture.close();
    }
  });
}

// The CLI applies its own persistence limit after the SDK server has returned successfully.
// Exercise it separately from Browser execution so large fixtures do not obscure that workflow.
test("measures real Claude CLI SDK MCP output persistence and tool metadata limits", async () => {
  test.setTimeout(60_000);
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const directory = fs.mkdtempSync("/tmp/nodex-cdt-output-");
  const cases = [
    { name: "default", size: 60_000 },
    { name: "raised", size: 60_000, limit: 100_000 },
    { name: "below_cap", size: 490_000, limit: 1_000_000 },
    { name: "above_cap", size: 510_000, limit: 1_000_000 },
  ];
  const results: Record<string, unknown> = {};
  const payload = (size: number) => `START_${"x".repeat(size)}_END`;
  let step = 0;
  const model = await startScriptedAnthropicServer((request) => {
    if (step > 0) {
      const previous = cases[step - 1]!;
      results[previous.name] = anthropicToolResult(request, previous.name);
      const value = text(results[previous.name]);
      if (previous.name === "default" || previous.name === "above_cap") {
        expect(value).toContain("persisted-output");
        expect(value).toContain("Full output saved to:");
      } else {
        expect(value).toContain(payload(previous.size));
        expect(value).not.toContain("persisted-output");
      }
    }
    const current = cases[step++];
    return current
      ? tool(current.name, `mcp__node_repl__js_${current.name}`, {})
      : { type: "text", text: "OUTPUT_PROBE_DONE" };
  });
  const mcp = new McpServer({ name: "node_repl", version: "1" });
  mcp.server.registerCapabilities({ tools: {} });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cases.map((entry) => ({
      name: `js_${entry.name}`,
      description: "Return a test payload",
      inputSchema: { type: "object" as const },
      _meta: {
        "anthropic/alwaysLoad": true,
        ...(entry.limit === undefined ? {} : { "anthropic/maxResultSizeChars": entry.limit }),
      },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const entry = cases.find((entry) => `js_${entry.name}` === params.name)!;
    return { content: [{ type: "text", text: payload(entry.size) }] };
  });
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* prompts() {
    await ready;
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: "Measure the SDK MCP result limits." },
      parent_tool_use_id: null,
      session_id: "",
    };
    await new Promise<void>(() => {});
  }
  const cli = query({
    prompt: prompts(),
    options: {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
        ...model.environment,
      },
      settingSources: [],
      model: "claude-sonnet-5-5",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });
  try {
    expect(
      (await cli.setMcpServers({ node_repl: { type: "sdk", name: "node_repl", instance: mcp } }))
        .errors,
    ).toEqual({});
    release();
    let done = false;
    for await (const message of cli) {
      if (message.type !== "result") continue;
      expect(message.subtype).toBe("success");
      done = true;
      break;
    }
    expect(done).toBe(true);
    expect(model.errors).toEqual([]);
    const persisted = Object.entries(results).flatMap(([name, value]) => {
      const match = /Full output saved to: ([^\\\n]+)/u.exec(text(value));
      if (!match) return [];
      const filePath = match[1]!;
      expect(filePath.startsWith(directory + "/")).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toContain("_END");
      return [{ name, filePath, bytes: fs.statSync(filePath).size }];
    });
    saveEvidence("cli-output-limits.json", { cases, results, persisted });
  } finally {
    cli.close();
    await cli[Symbol.asyncDispose]();
    await model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude completes a Turn when Desktop Tools are unavailable", async () => {
  test.setTimeout(90_000);
  const model = await startScriptedAnthropicServer((request) => {
    const background = backgroundTitleResponse(request);
    if (background) return background;
    expect(request.tools.some((entry) => entry.name.startsWith("mcp__node_repl__"))).toBe(false);
    expect(text(request)).not.toContain("browser:control-in-app-browser");
    return { type: "text", text: "CLAUDE_WITHOUT_DESKTOP_TOOLS_DONE" };
  });
  const harness = await ElectronScenarioHarness.create({
    label: "cdt-e2e-unavailable",
    prepareAgentRuntime: false,
    // Keep the independent Agent Runtime healthy while its optional Desktop Tool bundle is absent.
    environment: {
      ...model.environment,
      NODEX_LOG_FILE: "1",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: process.cwd(),
    },
  });
  // Remove only this worktree's cloned manifest, never the immutable shared runtime.
  const manifest = path.resolve(
    ".generated/codex-runtime/agent-runtime/browser-runtime/browser-runtime-manifest.json",
  );
  const saved = `${manifest}.cdt-e2e-unavailable`;
  fs.renameSync(manifest, saved);
  try {
    const page = await harness.launch();
    await configureClaude(page, harness, model.environment);
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Claude without Desktop Tools",
    );
    await refreshComposerModels(page);
    await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
    await page.keyboard.press("Escape");
    const threadId = await sendAgentPrompt(
      page,
      draft.projectSessionId,
      "Reply with a short message.",
    );
    const target = { sessionId: draft.projectSessionId, threadId };
    await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
    const conversation = await readRuntimeConversation(page, target);
    expect(text(conversation)).toContain("CLAUDE_WITHOUT_DESKTOP_TOOLS_DONE");
    expect(model.requests.filter((request) => !backgroundTitleResponse(request))).toHaveLength(1);
    expect(model.errors).toEqual([]);
    saveEvidence("unavailable-runtime.json", {
      request: model.requests[0],
      conversation,
      logs: await readBoundedElectronRuntimeLogs(harness.profile),
    });
  } finally {
    await harness.close();
    fs.renameSync(saved, manifest);
    await model.close();
  }
});
