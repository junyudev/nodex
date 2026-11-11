import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronScenarioHarness } from "../../../scripts/scenarios/harness/electron-e2e-harness";
import { readBoundedElectronRuntimeLogs } from "../../../scripts/scenarios/harness/electron-e2e-harness";
import type { BrowserSidebarRuntimeSnapshot } from "../../../src/shared/browser-sidebar";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import {
  isRecord,
  requireRecord,
  invokeIpc,
  readRuntimeConversation,
  sendAgentFollowUp,
  sendAgentPrompt,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
  type AgentRuntimeTarget,
} from "./agent-smoke-harness";
import { startBrowserHttpFixture } from "./browser-http-fixture";

const browserPlugin = path.resolve(
  ".generated/codex-runtime/agent-runtime/browser-runtime/marketplace/plugins/browser",
);
export const browserSkillName = "control-in-app-browser";
const browserSkill = path.join(browserPlugin, "skills", browserSkillName, "SKILL.md");
const browserClient = path.join(browserPlugin, "scripts/browser-client.mjs");

export type DesktopCall = { code: string; title: string; timeout_ms: number };
const js = (title: string, code: string, timeout_ms = 30_000): DesktopCall => ({
  code,
  title,
  timeout_ms,
});

export function desktopSmokeScript(url: string, unapprovedUrl: string) {
  return {
    browser: [
      js(
        "Connect to the in-app Browser",
        `const { setupBrowserRuntime } = await import(${JSON.stringify(browserClient)}); const agent = await setupBrowserRuntime(); const iab = await agent.browsers.get("iab"); nodeRepl.write(await iab.documentation()); const kept = "DESKTOP_MEMORY_RETAINED";`,
      ),
      js(
        "Open the Browser fixture",
        `const tab = await iab.tabs.new(); await tab.goto(${JSON.stringify(url)}); await tab.markDeliverable(); await (await iab.capabilities.get("visibility")).set(true); nodeRepl.write(await tab.title()); await nodeRepl.emitImage(await tab.screenshot({fullPage:false}));`,
      ),
    ],
    memory: [js("Read the Browser binding from the previous Turn", "nodeRepl.write(kept);")],
    grant: [
      js(
        "Set the chat grant fixture binding",
        'const grant = "DESKTOP_CHAT_GRANT"; nodeRepl.write(grant);',
      ),
      js("Reuse the chat grant", "nodeRepl.write(grant);"),
    ],
    origin: [
      js(
        "Open an origin without a saved rule",
        `const consentTab = await iab.tabs.new(); await consentTab.goto(${JSON.stringify(unapprovedUrl)}); nodeRepl.write(await consentTab.title());`,
      ),
    ],
    stop: [
      js("Wait for Stop", "await new Promise(resolve => setTimeout(resolve, 120000));", 150_000),
    ],
    reset: [js("Read the binding after Stop", "nodeRepl.write(typeof grant);")],
    restart: [
      js(
        "Reuse the chat grant after restart",
        'await new Promise(resolve => setTimeout(resolve, 3000)); nodeRepl.write("DESKTOP_RESTARTED");',
      ),
    ],
    decline: [js("Decline this JavaScript", 'nodeRepl.write("DESKTOP_UNEXPECTED_EXECUTION");')],
    unavailable: [],
  } satisfies Record<string, DesktopCall[]>;
}

export type DesktopSmokeStep = keyof ReturnType<typeof desktopSmokeScript>;
const prompts: Record<DesktopSmokeStep, string> = {
  browser: "Use the in-app Browser to open the loopback fixture, show it and take a screenshot.",
  memory: "Read the Browser binding from the previous Turn.",
  grant: "Run two JavaScript calls to exercise the chat grant.",
  origin: "Navigate to another loopback origin through the in-app Browser.",
  stop: "Run a long JavaScript call so I can stop it.",
  reset: "Read the binding again after stopping the long call.",
  restart: "Run JavaScript again after the app restart.",
  decline: "Request approval for JavaScript again.",
  unavailable: "Complete this chat without Desktop Tools.",
};
export const smokePrompt = (step: DesktopSmokeStep) => `${prompts[step]} [desktop-smoke:${step}]`;
export const smokeMarker = (step: DesktopSmokeStep) => `DESKTOP_SMOKE_DONE_${step.toUpperCase()}`;

/**
 * Browsers read this registration from the real home, so a scenario must never take it over.
 * Other apps and development instances rewrite it at any time; only this run's Profile matters.
 */
export const realChromeHostPointsInto = (runRoot: string) => {
  const manifest = path.join(
    os.homedir(),
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
  );
  return (
    fs.existsSync(manifest) && fs.readFileSync(manifest, "utf8").includes(path.basename(runRoot))
  );
};

export function desktopEvidence(provider: string, name: string, value: unknown) {
  const root = process.env.NODEX_DTAA_EVIDENCE_DIR;
  if (!root) return;
  const dir = path.join(root, provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

async function screenshot(page: Page, provider: string, name: string) {
  const file = test.info().outputPath(name);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: "image/png" });
  const root = process.env.NODEX_DTAA_EVIDENCE_DIR;
  if (!root) return;
  const dir = path.join(root, provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, name));
}

type ActiveExec = { kernelPid: number; nodeReplPid: number };
function activeExecs(home: string): ActiveExec[] {
  const dir = path.join(home, "node_repl/active_execs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ActiveExec];
      } catch {
        return []; // The native writer may be replacing the record as the call ends.
      }
    });
}

function processTable() {
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              command: match[4]!,
            },
          ]
        : [];
    });
}

function replProcesses(active: ActiveExec) {
  const owned = processTable();
  const repl = owned.find(({ pid }) => pid === active.nodeReplPid);
  const codex = owned.find(({ pid }) => pid === repl?.parent);
  const launcher = owned.find(({ pid }) => pid === codex?.parent);
  if (!repl || !codex || !launcher) throw new Error("The signed REPL process ancestry is missing");
  const bundle = path.resolve(browserPlugin, "../../..");
  expect(launcher.command.startsWith(`${bundle}/bin/node `)).toBe(true);
  expect(codex.command.startsWith(`${bundle}/codex-cli/`)).toBe(true);
  expect(repl.command.startsWith(`${bundle}/bin/node_repl`)).toBe(true);
  expect(repl.group).toBe(launcher.group);
  expect(codex.group).toBe(launcher.group);
  return { repl: repl.pid, codex: codex.pid, launcher: launcher.pid, group: launcher.group };
}

async function setMode(page: Page, label: "Full access" | "Ask for approval") {
  const selected = page.getByRole("button", { name: `Permissions: ${label}`, exact: true });
  if (await selected.count()) return;
  await page.getByRole("button", { name: /^Permissions:/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(label) }).click();
  if (label === "Full access") {
    const confirm = page
      .getByRole("dialog", { name: "Turn on Full access?" })
      .getByRole("button", { name: "Turn on", exact: true });
    await expect(selected.or(confirm).first()).toBeVisible();
    if (await confirm.isVisible()) await confirm.click();
  }
  await expect(selected).toBeVisible();
}

type Configure = (input: {
  page: Page;
  harness: ElectronScenarioHarness;
  script: ReturnType<typeof desktopSmokeScript>;
  title: string;
}) => Promise<{
  select: () => Promise<void>;
  verify: (step: DesktopSmokeStep) => void | Promise<void>;
}>;

export function monitorRuntimeLease() {
  let startupErrors = "";
  let leaseFailure = false;
  let observedLaunches = 0;
  const launchOptions: NonNullable<Parameters<ElectronScenarioHarness["launch"]>[0]> = {
    onStderr(stderr) {
      observedLaunches += 1;
      let partial = "";
      stderr.on("data", (chunk) => {
        const lines = (partial + String(chunk)).split("\n");
        partial = lines.pop()!.slice(-8_000);
        leaseFailure ||= [...lines, partial].some((line) =>
          line.includes("RuntimeHomeLeaseError:"),
        );
        const failures = lines.filter((line) =>
          /(?:RuntimeHomeLeaseError:|ERR_MODULE_NOT_FOUND|FATAL ERROR|Agent Runtime process exited)/u.test(
            line,
          ),
        );
        if (failures.length > 0)
          startupErrors = (startupErrors + failures.join("\n") + "\n").slice(-8_000);
      });
    },
  };
  return {
    launchOptions,
    startupErrors: () => startupErrors,
    snapshot: () => ({ observedLaunches, leaseFailure }),
    verify(expectedLaunches: number) {
      expect(observedLaunches).toBe(expectedLaunches);
      expect(leaseFailure, startupErrors).toBe(false);
    },
  };
}

export async function runDesktopSmoke(
  provider: string,
  harness: ElectronScenarioHarness,
  configure: Configure,
  scenario: "browser" | "approval" | "unavailable",
) {
  const title = `DESKTOP_BROWSER_${provider.toUpperCase()}`;
  const fixture = await startBrowserHttpFixture(title);
  const unapproved = await startBrowserHttpFixture("DESKTOP_UNAPPROVED_ORIGIN");
  const script = desktopSmokeScript(fixture.url, unapproved.url);
  let page: Page | undefined;
  let target: AgentRuntimeTarget | undefined;
  const lease = monitorRuntimeLease();
  let succeeded = false;
  try {
    page = await harness.launch(lease.launchOptions);
    const agent = await configure({ page, harness, script, title });
    // The harness already opened a new chat in its seeded local Project. Keep the
    // submitting Workbench mounted while the Runtime's provider catalog starts.
    const projects = requireRecord(await invokeIpc(page, "projects:list"), "Scenario Projects");
    const project =
      Array.isArray(projects.items) &&
      projects.items.find((item) => isRecord(item) && item.name === "My Project");
    if (!isRecord(project) || typeof project.id !== "string")
      throw new Error("Missing scenario Project");
    const projectId = project.id;
    let sessionId: string | undefined;
    await expect
      .poll(async () => {
        const tasks = requireRecord(
          await invokeIpc(page!, "workspace:tasks:list", projectId, { first: 20 }),
          "Scenario tasks",
        );
        const draft =
          Array.isArray(tasks.items) &&
          tasks.items.find(
            (item) => isRecord(item) && item.thread === null && item.executionRef == null,
          );
        sessionId = isRecord(draft) && typeof draft.id === "string" ? draft.id : undefined;
        return sessionId;
      })
      .toBeDefined();
    if (!sessionId) throw new Error("Missing scenario draft Session");
    await agent.select();
    if (scenario === "browser") {
      expect(fs.readFileSync(browserSkill, "utf8")).toContain("setupBrowserRuntime()");
      await setMode(page, "Full access");
      await invokeIpc(page, "browser-use-policy-update-origin-rule", {
        action: "add",
        kind: "allowed",
        origin: new URL(fixture.url).origin,
        resource: "origin",
      });
    }
    if (scenario === "approval") await setMode(page, "Ask for approval");
    const first = scenario === "approval" ? "grant" : scenario;
    const threadId = await sendAgentPrompt(page, sessionId, smokePrompt(first));
    target = { sessionId, threadId };
    const state = () => readRuntimeConversation(page!, target!);
    const finish = async (step: DesktopSmokeStep) => {
      await waitForFinalMarker(page!, smokeMarker(step));
      await waitForRuntimeCompletedAgentTurn(page!, target!, 45_000);
      await agent.verify(step);
    };
    const followUp = (step: DesktopSmokeStep) => sendAgentFollowUp(page!, smokePrompt(step));
    const pending = async () =>
      (await state()).snapshot.projection.runtimeRequests.filter(
        ({ status }) => status === "pending",
      );
    if (scenario === "unavailable") {
      await finish("unavailable");
      succeeded = true;
      return;
    }
    if (scenario === "browser") {
      await finish("browser");
      expect(fixture.requests).toContain("/browser-smoke");
      const browser = (await invokeIpc(
        page,
        "browser-sidebar-runtime-snapshot",
      )) as BrowserSidebarRuntimeSnapshot;
      expect(browser.state.tabs.find(({ url }) => url === fixture.url)).toMatchObject({
        browserConversationId: target.sessionId,
        title,
      });
      const panel = page.locator('[data-browser-sidebar-webview-host-kind="panel"]:visible');
      await expect(panel.locator("webview")).toBeVisible();
      const items = (await state()).snapshot.projection.visibleTurnItems.map(({ item }) => item);
      const calls = items.filter((item) => item.type === "dynamic_tool");
      // Preserve exact provider names and argument shapes even if enrichment fails.
      desktopEvidence(provider, "browser-tool-items.json", calls);
      desktopEvidence(provider, "browser-panel.json", browser);
      const captured = calls.filter(({ mcpToolCall }) => mcpToolCall?.server === "node_repl");
      expect(captured).toHaveLength(2);
      const navigation = captured.find(({ mcpToolCall }) =>
        JSON.stringify(mcpToolCall?.arguments).includes("Open the Browser fixture"),
      );
      expect(navigation?.mcpToolCall).toMatchObject({ tool: "js", status: "completed" });
      expect(navigation?.resultImages).toHaveLength(1);
      const attachmentId = navigation!.resultImages![0]!.attachmentId;
      const activity = page.getByRole("button", { name: /^Worked for/u });
      if ((await activity.count()) && (await activity.getAttribute("aria-expanded")) !== "true")
        await activity.click();
      const body = page.getByTestId("agent-activity-group-body");
      if ((await body.count()) && (await body.getAttribute("aria-hidden")) === "true")
        await body.locator("..").getByRole("button").first().click();
      const row = page.getByRole("button", { name: script.browser[1]!.title, exact: true });
      await expect(row).toBeVisible();
      await row.click();
      const image = page.getByRole("img", { name: "Tool output", exact: true });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      const attachment = (await invokeIpc(page, "agent-runtime:session:attachment", {
        ...target,
        itemId: navigation!.id,
        attachmentId,
      })) as { dataUrl: string };
      expect(attachment.dataUrl).toBe(await image.getAttribute("src"));
      desktopEvidence(provider, "screenshot-attachment.json", {
        itemId: navigation!.id,
        attachmentId,
        size: attachment.dataUrl.length,
      });
      await screenshot(page, provider, "browser-mcp.png");

      await followUp("memory");
      await finish("memory");

      await setMode(page, "Ask for approval");
      await followUp("origin");
      await expect.poll(pending).toMatchObject([{ kind: "command" }]);
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      const originMarker = page.getByText(smokeMarker("origin"), { exact: true });
      await expect
        .poll(
          async () =>
            (await pending()).some(({ kind }) => kind === "mcp-elicitation") ||
            (await originMarker.isVisible()),
        )
        .toBe(true);
      const originRequests = await pending();
      if (originRequests.length > 0) {
        expect(originRequests).toMatchObject([{ kind: "mcp-elicitation" }]);
        await screenshot(page, provider, "site-access-approval.png");
        await page.getByRole("button", { name: /^Approve(?: once)?$/, exact: true }).click();
      }
      await finish("origin");
      expect(unapproved.requests).toContain("/browser-smoke");
      desktopEvidence(provider, "site-access.json", { elicited: originRequests.length > 0 });
      succeeded = true;
      return;
    }
    const more = page.getByRole("button", { name: "More approval options", exact: true });
    await expect(more).toHaveCount(1);
    const requests = await pending();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "command" });
    const approval = (await state()).snapshot.projection.visibleTurnItems
      .map(({ item }) => item)
      .find((item) => item.type === "approval_request" && item.requestId === requests[0]!.id);
    expect(approval).toMatchObject({ prompt: script.grant[0]!.code });
    await more.click();
    const allow = page.getByRole("menuitem", {
      name: "Allow JavaScript for this chat",
      exact: true,
    });
    await expect(allow).toBeVisible();
    desktopEvidence(provider, "approval-card.json", requests);
    await screenshot(page, provider, "javascript-approval.png");
    await allow.click();
    await finish("grant");
    expect(await pending()).toEqual([]);

    await followUp("stop");
    await expect.poll(() => activeExecs(harness.profile.codexHome)).toHaveLength(1);
    const [active] = activeExecs(harness.profile.codexHome);
    const owned = replProcesses(active!);
    const started = Date.now();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(async () => (await state()).snapshot.projection.runs.at(-1)?.status)
      .toBe("interrupted");
    await expect.poll(() => activeExecs(harness.profile.codexHome)).toEqual([]);
    await expect
      .poll(() => processTable().some(({ pid }) => pid === active!.kernelPid))
      .toBe(false);
    await agent.verify("stop");
    desktopEvidence(provider, "stop.json", {
      elapsedMs: Date.now() - started,
      active,
      ...owned,
    });
    await followUp("reset");
    await finish("reset");

    // Archive the exact process group captured from the disposable Profile's active-exec record.
    // Exercise restart/grant first and separately collect the fresh launcher before archiving.
    page = await harness.restart(lease.launchOptions);
    await expect
      .poll(() => processTable().filter(({ group }) => group === owned.group))
      .toEqual([]);
    await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
    await invokeIpc(page, "agent-runtime:session:message", {
      ...target,
      message: { messageId: createUuidV7(), text: smokePrompt("restart") },
    });
    await expect.poll(() => activeExecs(harness.profile.codexHome)).toHaveLength(1);
    const [restartExec] = activeExecs(harness.profile.codexHome);
    const restarted = replProcesses(restartExec!);
    await finish("restart");
    expect(await pending()).toEqual([]);
    await setMode(page, "Full access");
    await expect
      .poll(async () => (await state()).snapshot.projection.thread.runtimeMode)
      .toBe("full-access");
    await setMode(page, "Ask for approval");
    await expect
      .poll(async () => (await state()).snapshot.projection.thread.runtimeMode)
      .toBe("approval-required");
    await followUp("decline");
    await expect.poll(pending).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    await finish("decline");
    const declined = (await state()).snapshot.projection.visibleTurnItems
      .map(({ item }) => item)
      .find(
        (item) =>
          item.type === "dynamic_tool" &&
          JSON.stringify(item.mcpToolCall?.arguments)?.includes(script.decline[0]!.title),
      );
    expect(declined).toMatchObject({ mcpToolCall: { server: "node_repl", status: "failed" } });
    const groups = new Set([owned.group, restarted.group]);
    const sessionProcesses = () => processTable().filter(({ group }) => groups.has(group));
    const beforeArchive = sessionProcesses().map(({ pid }) => pid);
    expect(beforeArchive).toEqual(
      expect.arrayContaining([
        restarted.launcher,
        restarted.codex,
        restarted.repl,
        restartExec!.kernelPid,
      ]),
    );
    await invokeIpc(page, "project-sessions:archive", {
      operationId: createBoundedOperationId("e2e.desktop.archive"),
      payload: { sessionId: target.sessionId },
    });
    await expect.poll(() => sessionProcesses().map(({ pid }) => pid)).toEqual([]);
    expect(activeExecs(harness.profile.codexHome)).toEqual([]);
    desktopEvidence(provider, "archive.json", {
      beforeArchive,
      remaining: sessionProcesses().length,
    });
    succeeded = true;
  } catch (error) {
    if (page) await screenshot(page, provider, `${scenario}-failure.png`).catch(() => {});
    desktopEvidence(provider, `${scenario}-failure.json`, {
      error: String(error),
      startupErrors: lease.startupErrors(),
      conversation:
        page && target ? await readRuntimeConversation(page, target).catch(() => null) : null,
      logs: await readBoundedElectronRuntimeLogs(harness.profile, 60_000),
    });
    throw error;
  } finally {
    await Promise.all([fixture.close(), unapproved.close()]);
    desktopEvidence(provider, `${scenario}-lease.json`, lease.snapshot());
    if (succeeded) lease.verify(scenario === "approval" ? 2 : 1);
  }
}
