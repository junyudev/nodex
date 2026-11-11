import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { RemoteHostedPipTaskStateSnapshot } from "../../src/shared/remote-hosted-pip";
import { openSummaryPanel } from "./support/subagents-panel";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
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
import { monitorRuntimeLease } from "./support/desktop-tools-smoke";

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
        environment: Object.entries({ ...environment, ENABLE_TOOL_SEARCH: "true" }).map(
          ([name, value]) => ({
            name,
            value,
            sensitive: false,
          }),
        ),
      },
    ],
  });
};
const selectPermissions = async (page: Page, label: "Full access" | "Ask for approval") => {
  const selected = page.getByRole("button", { name: `Permissions: ${label}`, exact: true });
  if (await selected.isVisible()) return;
  await page.getByRole("button", { name: /^Permissions:/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(label) }).click();
  if (label === "Full access") {
    await page
      .getByRole("dialog", { name: "Turn on Full access?" })
      .getByRole("button", { name: "Turn on", exact: true })
      .click();
  }
  await expect(selected).toBeVisible();
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

test("measures native Claude Plan mode with an allowed HTTP MCP tool", async () => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-cdt-plan-"));
  let calls = 0;
  const permissionCallbacks: string[] = [];
  const toolName = "mcp__node_repl__js";
  const resultId = "plan_probe";
  let result: ReturnType<typeof anthropicToolResult>;
  const model = await startScriptedAnthropicServer((request) => {
    result = anthropicToolResult(request, resultId);
    if (result) return { type: "text", text: "PLAN_PROBE_DONE" };
    expect(request.tools.find((entry) => entry.name === toolName)?.defer_loading).not.toBe(true);
    expect(request.tools.some((entry) => entry.name === toolName)).toBe(true);
    return tool(resultId, toolName, { code: "1 + 1" });
  });

  // Match the tool metadata the Runtime sends. The probe has no executable code path.
  const endpoint = http.createServer(async (request, response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = new Server({ name: "node_repl", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "js",
          description: "A JavaScript tool with no read-only annotation",
          inputSchema: { type: "object", properties: { code: { type: "string" } } },
          _meta: { "anthropic/alwaysLoad": true },
        },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      return { content: [{ type: "text", text: "PLAN_PROBE_REACHED_ENDPOINT" }] };
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      await mcp.close();
    }
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("Missing Plan probe MCP port");

  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* prompts() {
    await ready;
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: "Probe native Plan mode permissions." },
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
        ENABLE_TOOL_SEARCH: "true",
        ...model.environment,
      },
      settingSources: [],
      model: "claude-sonnet-5-5",
      permissionMode: "plan",
      allowedTools: ["mcp__node_repl__*"],
      canUseTool: async (name) => {
        permissionCallbacks.push(name);
        return { behavior: "deny", message: "Plan probe denied the native permission request" };
      },
    },
  });
  try {
    const registration = await cli.setMcpServers({
      node_repl: {
        type: "http",
        url: `http://127.0.0.1:${address.port}/mcp/node_repl`,
        timeout: 65 * 60_000,
      },
    });
    expect(registration.errors).toEqual({});
    release();
    let cliVersion: string | undefined;
    for await (const message of cli) {
      if (message.type === "system" && message.subtype === "init")
        cliVersion = message.claude_code_version;
      if (message.type !== "result") continue;
      expect(message.subtype).toBe("success");
      break;
    }
    expect(model.errors).toEqual([]);
    expect(result).toBeDefined();
    saveEvidence("cli-plan-mode.json", {
      cliVersion,
      endpointCalls: calls,
      permissionCallbacks,
      result,
    });
    expect(permissionCallbacks).toEqual([toolName]);
    expect(calls).toBe(0);
    expect(result).toMatchObject({ is_error: true });
  } finally {
    cli.close();
    await cli[Symbol.asyncDispose]();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude loads the Browser skill picked in the composer", async () => {
  const marker = "CLAUDE_COMPOSER_BROWSER_SKILL";
  const model = await startScriptedAnthropicServer(
    (request) =>
      backgroundTitleResponse(request) ?? { type: "text", text: "Browser skill received." },
  );
  const harness = await ElectronScenarioHarness.create({
    label: "claude-composer-browser-skill",
    prepareAgentRuntime: false,
    environment: model.environment,
  });
  const lease = monitorRuntimeLease();
  try {
    const page = await harness.launch(lease.launchOptions);
    await configureClaude(page, harness, model.environment);
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.projectsDirectory,
      "Claude Browser skill",
    );
    await refreshComposerModels(page);
    await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
    await page.keyboard.press("Escape");
    const threadId = await sendAgentPrompt(page, draft.projectSessionId, marker, async () => {
      const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
      await composer.press("End");
      await page.keyboard.insertText(" $");
      const picker = page.getByLabel("Skills and apps");
      const browser = picker.getByRole("button", { name: /^Browser\b/u });
      await expect(browser).toBeVisible();
      await screenshot(page, "claude-desktop-skill-picker.png");
      await browser.click();
      await expect(picker).toBeHidden();
      await screenshot(page, "claude-desktop-skill-selected.png");
    });
    await waitForRuntimeCompletedAgentTurn(
      page,
      { sessionId: draft.projectSessionId, threadId },
      30_000,
    );
    const turn = model.requests.find(
      (request) =>
        !backgroundTitleResponse(request) &&
        request.messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(marker),
        ),
    );
    expect(turn).toBeDefined();
    expect(JSON.stringify(turn?.messages)).toContain(
      "choose the right surface before any browser action",
    );
    expect(model.errors).toEqual([]);
    lease.verify(1);
  } finally {
    await harness.close();
    await model.close();
  }
});

for (const mode of ["full-access", "approval-required"] as const) {
  test(`Claude drives the real in-app Browser with ${mode}`, async () => {
    test.setTimeout(240_000);
    const fixture = await startBrowserHttpFixture(`CLAUDE_BROWSER_${mode}`);
    let phase = 0;
    let pluginRoot = "";
    let documentationResult = "";
    let idleStopReady = false;
    let releaseIdleStop: () => void = () => {};
    const idleStopGate = new Promise<void>((resolve) => {
      releaseIdleStop = resolve;
    });
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
        const lastMessage = text(request.messages.at(-1));
        if (
          lastMessage.includes("CDT_STOP_WITHOUT_RUNNING_CODE") ||
          lastMessage.includes('"tool_use_id":"before_idle_stop"')
        ) {
          if (!anthropicToolResult(request, "before_idle_stop"))
            return js("before_idle_stop", "nodeRepl.write({kept});", "Read binding before Stop");
          expect(text(result("before_idle_stop"))).toContain("37");
          idleStopReady = true;
          await idleStopGate;
          return { type: "text", text: "Stopped" };
        }
        if (
          lastMessage.includes("CDT_CHECK_MEMORY_AFTER_IDLE_STOP") ||
          lastMessage.includes('"tool_use_id":"idle_stop_memory"')
        ) {
          const memory = anthropicToolResult(request, "idle_stop_memory");
          if (!memory)
            return js("idle_stop_memory", "nodeRepl.write({kept});", "Read binding after Stop");
          expect(text(result("idle_stop_memory"))).toContain("37");
          return { type: "text", text: "CLAUDE_IDLE_STOP_MEMORY_DONE" };
        }
        if (phase++ === 0) {
          const repl = request.tools.find((candidate) => candidate.name === "mcp__node_repl__js");
          expect(repl).toBeDefined();
          expect(repl?.defer_loading).not.toBe(true);
          expect(request.tools.some((candidate) => candidate.name === "ToolSearch")).toBe(true);
          expect(request.tools.some((candidate) => candidate.name.includes("turn_ended"))).toBe(
            false,
          );
          expect(text(request)).toContain("browser:control-in-app-browser");
          expect(text(request).includes("computer-use:computer-use")).toBe(computerUseReady);
          saveEvidence(`${mode}-discovery.json`, {
            model: request.model,
            tools: request.tools.map(({ name, defer_loading }) => ({ name, defer_loading })),
            browserSkill: true,
            computerUseSkill: computerUseReady,
          });
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
          } else {
            expect(navigation).toMatchObject({ is_error: true });
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
    const lease = monitorRuntimeLease();
    try {
      const page = await harness.launch(lease.launchOptions);
      failurePage = page;
      await configureClaude(page, harness, server.environment);
      const computer = (await invokeIpc(page, "computer-use-settings-get")) as {
        available: boolean;
      };
      computerUseReady = computer.available;
      saveEvidence(`${mode}-computer-gate.json`, { available: computer.available });
      const draft = await createAgentSmokeDraft(
        page,
        harness.profile.projectsDirectory,
        `Claude Browser ${mode}`,
      );
      await refreshComposerModels(page);
      await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
      await page.keyboard.press("Escape");
      await selectPermissions(page, mode === "full-access" ? "Full access" : "Ask for approval");
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
        const snapshot = (await readRuntimeConversation(page, target)).snapshot.projection;
        const pending = snapshot.runtimeRequests.filter((request) => request.status === "pending");
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          kind: "command",
          responseCapability: { type: "runtime" },
        });
        const card = snapshot.visibleTurnItems
          .map(({ item }) => item)
          .find((item) => item.type === "approval_request" && item.requestId === pending[0]?.id);
        expect(card).toMatchObject({
          prompt: expect.stringMatching(/^const \{ setupBrowserRuntime \} = await import/u),
        });
        expect(activeExecs(harness.profile.codexHome)).toEqual([]);
        await screenshot(page, "claude-tool-approval.png");
        await allow.click();

        await expect
          .poll(async () => {
            const state = (await readRuntimeConversation(page, target)).snapshot.projection;
            return state.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => request.kind);
          })
          .toEqual(["mcp-elicitation"]);
        const consent = (await readRuntimeConversation(page, target)).snapshot.projection;
        expect(consent.thread.runtimeChatGrants?.grants).toEqual(["desktop-tools-javascript"]);
        expect(consent.providerThreads.at(-1)?.chatGrants).toBeUndefined();
        expect(
          consent.runtimeRequests.filter((request) => request.kind === "command"),
        ).toHaveLength(1);
        await page.getByRole("button", { name: "Decline", exact: true }).click();
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
      const mcp = conversation.snapshot.projection.visibleTurnItems
        .map((visible) => visible.item)
        .filter((item) => item.type === "dynamic_tool" && item.mcpToolCall?.server === "node_repl");
      expect(mcp.length).toBeGreaterThanOrEqual(2);
      if (mode === "approval-required")
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
          // The title bar can cover this row after the reply scrolls; the keyboard does not care.
          await activity.press("Enter");
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
        await expect(
          page.locator(
            '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="panel"] webview',
          ),
        ).toBeVisible();
        await screenshot(page, "claude-browser-mcp.png");
      }
      if (mode === "approval-required") {
        expect(server.errors).toEqual([]);
        expect(fixture.requests).toEqual([]);
        saveEvidence("approval-required-results.json", {
          javaScriptApprovalCount: conversation.snapshot.projection.runtimeRequests.filter(
            (request) => request.kind === "command",
          ).length,
          grant: conversation.snapshot.projection.thread.runtimeChatGrants,
          siteAccessDeclined: true,
          navigationIsError: (results.navigate as { is_error?: boolean }).is_error === true,
          turnStatus: conversation.snapshot.projection.runs.at(-1)?.status,
        });
        return;
      }
      await sendAgentFollowUp(page, "Read the binding from the previous Turn.");
      await waitForFinalMarker(page, "CLAUDE_MEMORY_DONE");
      await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
      await sendAgentFollowUp(page, "CDT_STOP_WITHOUT_RUNNING_CODE");
      await expect.poll(() => idleStopReady).toBe(true);
      expect(activeExecs(harness.profile.codexHome)).toEqual([]);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readRuntimeConversation(page, target)).snapshot.projection.runs.at(-1)?.status,
        )
        .toBe("interrupted");
      releaseIdleStop();
      await sendAgentFollowUp(page, "CDT_CHECK_MEMORY_AFTER_IDLE_STOP");
      await waitForFinalMarker(page, "CLAUDE_IDLE_STOP_MEMORY_DONE");
      await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
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
      const replPids = [records[0]!.nodeReplPid, codexPid, launcherPid];
      const stoppedAt = Date.now();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readRuntimeConversation(page, target)).snapshot.projection.runs.at(-1)?.status,
        )
        .toBe("interrupted");
      await expect.poll(() => activeExecs(harness.profile.codexHome)).toEqual([]);
      await expect.poll(() => alive(records[0]!.kernelPid)).toBe(false);
      saveEvidence(`${mode}-stop.json`, { elapsedMs: Date.now() - stoppedAt, records, replPids });
      await sendAgentFollowUp(
        page,
        "Use JavaScript again and check whether the old binding exists.",
      );
      await waitForFinalMarker(page, "CLAUDE_RESET_DONE");
      expect(server.errors).toEqual([]);
      saveEvidence(`${mode}-results.json`, {
        documentationResultCharacters: documentationResult.length,
        memoryAfterNextTurn: text(results.memory).includes("37"),
        memoryAfterStopWithoutRunningCode: text(results.idle_stop_memory).includes("37"),
        cleanAfterStopWithRunningCode: text(results.reset).includes("undefined"),
        modelPaths: server.paths,
      });
      // The REPL's detached process group contains its replacement kernel too.
      const group = execFileSync("ps", ["-p", String(launcherPid), "-o", "pgid="], {
        encoding: "utf8",
      }).trim();
      const ownedPids = execFileSync("ps", ["-g", group, "-o", "pid="], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/u)
        .map(Number);
      expect(ownedPids).toEqual(expect.arrayContaining(replPids));
      expect(ownedPids.length).toBeGreaterThan(replPids.length);
      await invokeIpc(page, "project-sessions:archive", {
        operationId: createBoundedOperationId("e2e.cdt.archive"),
        payload: { sessionId: draft.projectSessionId },
      });
      await expect.poll(() => ownedPids.map(alive)).toEqual(ownedPids.map(() => false));
      saveEvidence("lifecycle.json", {
        replPids,
        ownedPids,
        replAlive: ownedPids.map(alive),
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
      lease.verify(1);
    } catch (error) {
      if (failurePage) await screenshot(failurePage, `${mode}-failure.png`).catch(() => {});
      saveEvidence(`${mode}-failure.json`, {
        error: String(error),
        phase,
        toolResults: Object.fromEntries(
          Object.entries(results).map(([id, value]) => [
            id,
            { error: (value as { is_error?: boolean } | undefined)?.is_error ?? false },
          ]),
        ),
        modelErrorCount: server.errors.length,
      });
      throw error;
    } finally {
      releaseFinal();
      releaseIdleStop();
      await harness.close();
      await server.close();
      await fixture.close();
      saveEvidence(`${mode}-lease.json`, lease.snapshot());
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
    saveEvidence("cli-output-limits.json", { cases, persisted });
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
  const lease = monitorRuntimeLease();
  try {
    const page = await harness.launch(lease.launchOptions);
    await configureClaude(page, harness, model.environment);
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.projectsDirectory,
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
      toolNames: model.requests[0]?.tools.map(({ name }) => name),
      turnStatus: conversation.snapshot.projection.runs.at(-1)?.status,
    });
    lease.verify(1);
  } finally {
    await harness.close();
    saveEvidence("unavailable-lease.json", lease.snapshot());
    fs.renameSync(saved, manifest);
    await model.close();
  }
});

test("Claude and Runtime grants survive Stop and restart and end on a permission mode change", async () => {
  // Multiple native lifetimes include their bounded shutdown budgets.
  test.setTimeout(360_000);
  const results: Record<string, unknown> = {};
  const measurements: Record<string, unknown> = {};
  const server = await startScriptedAnthropicServer((request) => {
    const background = backgroundTitleResponse(request);
    if (background) return background;
    const prompt = request.messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])),
      )
      .findLast((content) => content.includes("CHAT_GRANTS_"));
    const phase = prompt ? /CHAT_GRANTS_(\w+)/u.exec(prompt)?.[1] : undefined;
    if (!phase) throw new Error("Missing chat-grant prompt marker");
    const id = `grant_${phase}`;
    const result = anthropicToolResult(request, id);
    if (result) {
      results[id] = result;
      return { type: "text", text: `CHAT_GRANTS_DONE_${phase}` };
    }
    if (phase.startsWith("bash"))
      return tool(id, "Bash", { command: bashCommand, description: "Run the punctuation fixture" });
    return js(
      id,
      `${phase === "initial" ? 'nodeRepl.write("TOOL_STARTED_AT=" + Date.now());' : ""} await new Promise(resolve => setTimeout(resolve, ${phase.startsWith("stop") ? 120_000 : 2500})); nodeRepl.write(${JSON.stringify(id)});`,
      `Chat grant ${phase}`,
      phase.startsWith("stop") ? 150_000 : 30_000,
    );
  });
  const harness = await ElectronScenarioHarness.create({
    label: "cdt-chat-grants",
    prepareAgentRuntime: false,
    environment: {
      ...server.environment,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_LOG_CONSOLE: "0",
    },
  });
  // A real executable prefix forces the CLI to suggest a rule containing punctuation.
  const executable = path.join(harness.profile.projectsDirectory, "say (a, b)");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nprintf 'CHAT_GRANTS_BASH_OK\\n'\n", { mode: 0o755 });
  const bashCommand = `${JSON.stringify(executable)} hello`;
  let page: Page | undefined;
  const lease = monitorRuntimeLease();
  let target: { sessionId: string; threadId: string } | undefined;
  const state = () => readRuntimeConversation(page!, target!);
  const cliPid = async () => {
    const nativeId = (await state()).snapshot.projection.providerThreads.at(-1)?.nativeThreadRef
      ?.nativeId;
    expect(nativeId).toBeTruthy();
    // Select only the CLI belonging to this disposable conversation, never another Nodex window.
    const processes = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(nativeId!) && /\/claude(?:\s|$)/u.test(line));
    expect(processes).toHaveLength(1);
    const pid = Number(processes[0]!.trim().split(/\s+/u)[0]);
    expect(alive(pid)).toBe(true);
    return pid;
  };
  const assertNoCommand = async () => {
    const conversation = await state();
    expect(
      conversation.snapshot.projection.runtimeRequests.filter(
        (request) => request.kind === "command" && request.status === "pending",
      ),
    ).toEqual([]);
    return conversation;
  };
  const awaitExecution = async () => {
    await expect
      .poll(
        async () => {
          await assertNoCommand();
          return activeExecs(harness.profile.codexHome).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  };
  const stop = async () => {
    await page!.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(async () => (await state()).snapshot.projection.runs.at(-1)?.status)
      .toBe("interrupted");
    await expect.poll(() => activeExecs(harness.profile.codexHome)).toEqual([]);
  };
  const answerApproval = async (choose: () => Promise<void>) => {
    const pending = (await state()).snapshot.projection.runtimeRequests.find(
      (request) => request.kind === "command" && request.status === "pending",
    );
    expect(pending).toBeDefined();
    const clickedAt = Date.now();
    await choose();
    await expect
      .poll(
        async () =>
          (await state()).snapshot.projection.runtimeRequests.find(
            (request) => request.id === pending!.id,
          )?.status,
      )
      .toBe("resolved");
    return clickedAt;
  };
  const allowForChat = async (name: RegExp) => {
    await page!
      .getByRole("button", { name: "More approval options", exact: true })
      .click({ timeout: 30_000 });
    await expect(page!.getByRole("menuitem", { name })).toBeVisible();
    return answerApproval(() => page!.getByRole("menuitem", { name }).click());
  };
  const followUp = async (phase: string) => sendAgentFollowUp(page!, `CHAT_GRANTS_${phase}`);
  const finish = async (phase: string) => {
    await expect
      .poll(
        async () => {
          await assertNoCommand();
          return results[`grant_${phase}`];
        },
        { timeout: 30_000 },
      )
      .toBeDefined();
    expect(text(results[`grant_${phase}`])).toContain(
      phase.startsWith("bash") ? "CHAT_GRANTS_BASH_OK" : `grant_${phase}`,
    );
    expect(results[`grant_${phase}`]).not.toMatchObject({ is_error: true });
    await waitForRuntimeCompletedAgentTurn(page!, target!, 30_000);
  };
  try {
    page = await harness.launch(lease.launchOptions);
    await configureClaude(page, harness, server.environment);
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.projectsDirectory,
      "Claude chat grants",
    );
    await refreshComposerModels(page);
    await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
    await page.keyboard.press("Escape");
    await selectPermissions(page, "Ask for approval");
    const threadId = await sendAgentPrompt(page, draft.projectSessionId, "CHAT_GRANTS_initial");
    target = { sessionId: draft.projectSessionId, threadId };
    const clickedAt = await allowForChat(/^Allow JavaScript for this chat$/u);
    await awaitExecution();
    await finish("initial");
    const toolStartedAt = Number(/TOOL_STARTED_AT=(\d+)/u.exec(text(results.grant_initial))?.[1]);
    measurements.liveGrant = { clickedAt, toolStartedAt, clickToToolMs: toolStartedAt - clickedAt };
    saveEvidence("chat-grants-measurements.json", measurements);
    expect(toolStartedAt - clickedAt).toBeGreaterThanOrEqual(0);
    expect((await state()).snapshot.projection.thread.runtimeChatGrants?.grants).toEqual([
      "desktop-tools-javascript",
    ]);
    expect((await state()).snapshot.projection.providerThreads.at(-1)?.chatGrants).toBeUndefined();
    await followUp("bash");
    await allowForChat(/for this chat$/u);
    await finish("bash");
    const withBoth = await state();
    const grants = withBoth.snapshot.projection.providerThreads.at(-1)?.chatGrants;
    expect(grants?.rules).not.toContain("mcp__node_repl__js");
    expect(
      grants?.rules.some(
        (rule) =>
          rule.startsWith("Bash(") && rule.includes("a, b") && rule.includes(String.raw`\(`),
      ),
    ).toBe(true);
    await followUp("stop_again");
    await awaitExecution();
    await stop();
    await followUp("both");
    await awaitExecution();
    await finish("both");
    await followUp("bash_again");
    await finish("bash_again");

    page = await harness.restart(lease.launchOptions);
    await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await followUp("restarted");
    await awaitExecution();
    await finish("restarted");
    await followUp("bash_restarted");
    await finish("bash_restarted");
    const pidBeforeModeChange = await cliPid();
    await selectPermissions(page, "Full access");
    await followUp("modechanged");
    await finish("modechanged");
    const fullAccess = (await state()).snapshot.projection.thread;
    expect(fullAccess.runtimeMode).toBe("full-access");
    expect(fullAccess.runtimeChatGrants?.grants).toEqual([]);
    expect((await state()).snapshot.projection.providerThreads.at(-1)?.chatGrants).toBeUndefined();
    const pidInFullAccess = await cliPid();
    measurements.modeChange = { pidBeforeModeChange, pidInFullAccess };
    saveEvidence("chat-grants-measurements.json", measurements);
    expect(pidInFullAccess).toBe(pidBeforeModeChange);
    await selectPermissions(page, "Ask for approval");
    await followUp("revoked");
    await expect(
      page.getByRole("button", { name: "More approval options", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await state()).snapshot.projection.runtimeRequests.filter(
            (request) => request.kind === "command" && request.status === "pending",
          ).length,
      )
      .toBe(1);
    const pidBackInAsk = await cliPid();
    measurements.modeChange = { pidBeforeModeChange, pidInFullAccess, pidBackInAsk };
    saveEvidence("chat-grants-measurements.json", measurements);
    expect(pidBackInAsk).toBe(pidBeforeModeChange);
    expect((await state()).snapshot.projection.thread.runtimeChatGrants?.grants).toEqual([]);
    expect((await state()).snapshot.projection.providerThreads.at(-1)?.chatGrants).toBeUndefined();
    // Approve once must still produce an ordinary completed transcript tool row.
    await answerApproval(() => page!.getByRole("button", { name: "Approve", exact: true }).click());
    await finish("revoked");
    const once = await state();
    const row = once.snapshot.projection.visibleTurnItems
      .map(({ item }) => item)
      .find((item) => item.type === "dynamic_tool" && item.mcpToolCall?.id === "grant_revoked");
    expect(row).toMatchObject({ type: "dynamic_tool", mcpToolCall: { status: "completed" } });
    expect(once.snapshot.projection.providerThreads.at(-1)?.chatGrants).toBeUndefined();
    const activity = page.getByRole("button", { name: /^Worked for/u }).last();
    if ((await activity.count()) && (await activity.getAttribute("aria-expanded")) !== "true")
      await activity.click();
    const groupBody = page.getByTestId("agent-activity-group-body").last();
    if ((await groupBody.count()) && (await groupBody.getAttribute("aria-hidden")) === "true")
      await groupBody.locator("..").getByRole("button").first().click();
    await expect(
      page.getByRole("button", { name: "Chat grant revoked", exact: true }),
    ).toBeVisible();
    expect(server.errors).toEqual([]);
    saveEvidence("chat-grants-success.json", {
      measurements,
      passedPhases: Object.keys(results),
      modeAfterRevocation: once.snapshot.projection.thread.runtimeMode,
      grantsAfterRevocation: once.snapshot.projection.thread.runtimeChatGrants?.grants,
      approvedOnceToolStatus: row?.type === "dynamic_tool" ? row.mcpToolCall?.status : undefined,
    });
    lease.verify(2);
  } catch (error) {
    if (page) await screenshot(page, "chat-grants-failure.png").catch(() => {});
    saveEvidence("chat-grants-failure.json", {
      error: String(error),
      completedPhases: Object.keys(results),
      measurements,
      modelErrorCount: server.errors.length,
    });
    throw error;
  } finally {
    await server.close();
    await harness.close();
    saveEvidence("chat-grants-lease.json", lease.snapshot());
  }
});

test("Claude Browser PiP retires on turn end, archive, and Runtime exit", async () => {
  test.skip(process.platform !== "darwin", "Native PiP requires macOS");
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Covers three real Claude Turns and two signed REPL launches in one lifecycle.
  test.setTimeout(180_000);
  const fixture = await startBrowserHttpFixture("CLAUDE_BROWSER_PIP");
  let finishTurn: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const server = await startScriptedAnthropicServer(async (request) => {
    const background = backgroundTitleResponse(request);
    if (background) return background;
    const turn = request.messages.findLast((message) => text(message).includes("CLAUDE_PIP_"));
    const marker = /CLAUDE_PIP_(complete|archive|kill)/u.exec(text(turn) ?? "")?.[1];
    if (!marker) throw new Error("Missing PiP prompt");
    const callId = `pip_${marker}`;
    const result = anthropicToolResult(request, callId);
    if (result) {
      expect(result).not.toMatchObject({ is_error: true });
      expect(text(result)).toContain("CLAUDE_BROWSER_PIP");
      await gate;
      return { type: "text", text: "Browser PiP test complete" };
    }
    const skillId = `skill_${marker}`;
    if (!anthropicToolResult(request, skillId))
      return tool(skillId, "Skill", { skill: "browser:control-in-app-browser" });
    const content = request.messages
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])),
      )
      .join("\n");
    const base = /Base directory for this skill: ([^\r\n]+)/u.exec(content)?.[1]?.trim();
    if (!base) throw new Error("Missing Browser skill directory");
    const client = path.resolve(base, "../../scripts/browser-client.mjs");
    return js(
      callId,
      `var { setupBrowserRuntime } = await import(${JSON.stringify(client)}); var browser = await (await setupBrowserRuntime()).browsers.get("iab"); var tab = await browser.tabs.new(); await tab.goto(${JSON.stringify(fixture.url)}); nodeRepl.write(await tab.title()); await nodeRepl.emitImage(await tab.screenshot({fullPage:false}));`,
      "Open the Browser PiP fixture",
    );
  });
  const harness = await ElectronScenarioHarness.create({
    label: "claude-browser-pip",
    prepareAgentRuntime: false,
    environment: server.environment,
  });
  try {
    const page = await harness.launch();
    await configureClaude(page, harness, server.environment);
    await invokeIpc(page, "browser-use-policy-update-origin-rule", {
      action: "add",
      kind: "allowed",
      origin: new URL(fixture.url).origin,
      resource: "origin",
    });
    const snapshot = async () =>
      (await invokeIpc(page, "remote-hosted-pip:snapshot")) as RemoteHostedPipTaskStateSnapshot;
    const newSession = async (projectName: string) => {
      gate = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      // Each Runtime Project owns its workspace path for the life of the Profile.
      const directory = fs.mkdtempSync(path.join(harness.profile.projectsDirectory, "pip-"));
      const draft = await createAgentSmokeDraft(page, directory, projectName);
      await refreshComposerModels(page);
      await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
      await page.keyboard.press("Escape");
      await selectPermissions(page, "Full access");
      return draft.projectSessionId;
    };
    const waitForPiP = async (sessionId: string, threadId: string, marker: string) => {
      try {
        await expect.poll(snapshot, { message: marker }).toMatchObject({
          activeTaskIds: [threadId],
          retainedPresentationCount: 1,
          taskVisibilityActionAvailable: true,
        });
      } catch (error) {
        const conversation = await readRuntimeConversation(page, { sessionId, threadId }).catch(
          () => null,
        );
        const requests = server.requests.filter((request) =>
          request.messages.some((message) => text(message).includes("CLAUDE_PIP_" + marker)),
        );
        const toolResult = requests
          .map((request) => anthropicToolResult(request, "pip_" + marker))
          .find((result) => result !== undefined);
        await test.info().attach("pip-activity", {
          contentType: "application/json",
          body: JSON.stringify({
            marker,
            runStatus: conversation?.snapshot.projection.runs.at(-1)?.status,
            requests: requests.length,
            serverErrors: server.errors.length,
            hasSkillResult: requests.some((request) =>
              anthropicToolResult(request, "skill_" + marker),
            ),
            hasBrowserResult: toolResult !== undefined,
            browserResultError: toolResult?.is_error,
            reachedFixture: text(toolResult)?.includes("CLAUDE_BROWSER_PIP"),
          }),
        });
        throw error;
      }
    };
    const waitForRetirement = () =>
      expect.poll(snapshot).toMatchObject({ activeTaskIds: [], retainedPresentationCount: 0 });

    const sessionId = await newSession("Claude PiP lifecycle");
    const threadId = await sendAgentPrompt(page, sessionId, "CLAUDE_PIP_complete");
    await waitForPiP(sessionId, threadId, "complete");
    const summary = await openSummaryPanel(page);
    await summary.getByRole("button", { name: "Hide PiP", exact: true }).click();
    await expect(summary.getByRole("button", { name: "Show PiP", exact: true })).toBeVisible();
    expect((await snapshot()).taskVisibilities).toEqual({ [threadId]: "hidden" });
    await summary.getByRole("button", { name: "Show PiP", exact: true }).click();
    finishTurn();
    await waitForRuntimeCompletedAgentTurn(page, { sessionId, threadId }, 45_000);
    await waitForRetirement();
    await expect(summary.getByRole("button", { name: "Hide PiP", exact: true })).toHaveCount(0);

    gate = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    await sendAgentFollowUp(page, "CLAUDE_PIP_archive");
    await waitForPiP(sessionId, threadId, "archive");
    await invokeIpc(page, "project-sessions:archive", {
      operationId: createBoundedOperationId("e2e.claude.pip.archive"),
      payload: { sessionId },
    });
    await waitForRetirement();
    finishTurn();

    const nextSessionId = await newSession("Claude PiP Runtime exit");
    const nextThreadId = await sendAgentPrompt(page, nextSessionId, "CLAUDE_PIP_kill");
    await waitForPiP(nextSessionId, nextThreadId, "kill");
    const runtimeHome = path.join(harness.profile.nodexHome, "agent-runtime");
    const { pid: runtimePid } = JSON.parse(
      fs.readFileSync(path.join(runtimeHome, ".writer.lock", "owner.json"), "utf8"),
    ) as { readonly pid: number };
    expect(Number.isSafeInteger(runtimePid) && runtimePid > 0).toBe(true);
    const runtimeCommand = execFileSync("ps", ["-ww", "-p", String(runtimePid), "-o", "command="], {
      encoding: "utf8",
    });
    expect(runtimeCommand).toContain(` --home ${runtimeHome} --cwd `);
    process.kill(runtimePid, "SIGKILL");
    await waitForRetirement();
    expect(server.errors).toEqual([]);
  } finally {
    finishTurn();
    await harness.close();
    await server.close();
    await fixture.close();
  }
});
