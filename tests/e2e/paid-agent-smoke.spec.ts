import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  buildPaidAgentSmokeCodexConfig,
  isPaidChatGptPlan,
  PAID_AGENT_SMOKE_DISABLED_SKILL_NAMES,
  PAID_AGENT_SMOKE_DEFINITIONS,
  type PaidAgentSmokeCase,
} from "../../scripts/paid-agent-smoke-contract";
import { readPaidAgentRolloutEvidence } from "../../scripts/paid-agent-rollout-evidence";
import type { CodexExecutionProfile } from "../../src/shared/codex-execution-profile";
import type { CodexModelOption } from "../../src/shared/types";
import { inboxSuggestionChoice, resolveInboxModel, type InboxItem } from "../../src/shared/inbox";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { invokeIpc as invokeTypedIpc } from "./support/editor-scenario";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  isRecord,
  readCodexModelCatalog,
  requireRecord,
  selectCodexExecutionProfile,
  sendAgentPromptWithEvidence,
  type AgentFirstSubmissionEvidence,
  waitForCompletedAgentTurn,
  waitForFinalMarker as waitForAgentFinalMarker,
} from "./support/agent-smoke-harness";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";

const repositoryRoot = process.cwd();
const profileFor = (model: CodexModelOption, reasoningEffort: string): CodexExecutionProfile => ({
  modelId: model.id,
  reasoningEffort,
  serviceTier: null,
});

const preflightExecutionProfile = async (
  page: Page,
  caseId: PaidAgentSmokeCase,
): Promise<{
  expected: CodexExecutionProfile;
  model: CodexModelOption;
}> => {
  const definition = PAID_AGENT_SMOKE_DEFINITIONS[caseId];
  const models = await readCodexModelCatalog(page);
  const model = models.find(
    (candidate) =>
      !candidate.hidden &&
      (candidate.id === definition.modelId || candidate.model === definition.modelId),
  );
  if (!model) throw new Error(`Required paid smoke model is unavailable: ${definition.modelId}`);
  if (
    !model.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === definition.reasoningEffort,
    )
  ) {
    throw new Error(
      `${definition.modelId} does not advertise ${definition.reasoningEffort} reasoning`,
    );
  }
  if (
    model.serviceTiers.length > 0 &&
    model.defaultServiceTier !== null &&
    !model.serviceTiers.some((option) => option.id === model.defaultServiceTier)
  ) {
    throw new Error(`${definition.modelId} advertises an invalid default service tier`);
  }
  return {
    expected: profileFor(model, definition.reasoningEffort),
    model,
  };
};

const selectExecutionProfile = async (
  page: Page,
  input: Awaited<ReturnType<typeof preflightExecutionProfile>>,
): Promise<CodexExecutionProfile> => {
  await selectCodexExecutionProfile(page, input.model, input.expected);
  const refreshed = await readCodexModelCatalog(page);
  const refreshedModel = refreshed.find((model) => !model.hidden && model.id === input.model.id);
  if (
    !refreshedModel?.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === input.expected.reasoningEffort,
    )
  ) {
    throw new Error("Selected Codex execution profile disappeared during final pre-send preflight");
  }
  return input.expected;
};

const createPaidSmokeDraft = async (
  page: Page,
  workspaceRoot: string,
  caseId: PaidAgentSmokeCase,
): Promise<{ projectId: string; projectSessionId: string }> =>
  await createAgentSmokeDraft(page, workspaceRoot, `Paid Agent ${caseId} smoke`);

const beginEventCapture = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __paidAgentCodexEvents?: unknown[];
      __paidAgentBrowserStates?: unknown[];
      __stopPaidAgentCodexEvents?: () => void;
      __stopPaidAgentBrowserStates?: () => void;
    };
    scope.__stopPaidAgentCodexEvents?.();
    scope.__stopPaidAgentBrowserStates?.();
    scope.__paidAgentCodexEvents = [];
    scope.__paidAgentBrowserStates = [];
    scope.__stopPaidAgentCodexEvents = window.api?.on("codex:event", (event: unknown) => {
      scope.__paidAgentCodexEvents?.push(event);
    });
    scope.__stopPaidAgentBrowserStates = window.api?.on(
      "browser-sidebar-browser-use-state",
      (state: unknown) => scope.__paidAgentBrowserStates?.push(state),
    );
  });
};

const capturedEvents = async (
  page: Page,
): Promise<{ browserStates: unknown[]; codexEvents: unknown[] }> =>
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __paidAgentCodexEvents?: unknown[];
      __paidAgentBrowserStates?: unknown[];
    };
    return {
      browserStates: scope.__paidAgentBrowserStates ?? [],
      codexEvents: scope.__paidAgentCodexEvents ?? [],
    };
  });

const sendPrompt = async (page: Page, projectSessionId: string, prompt: string) =>
  await sendAgentPromptWithEvidence(page, projectSessionId, prompt, async () =>
    beginEventCapture(page),
  );

const summarizeCodexEvent = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return { type: typeof value };
  const turn = isRecord(value.turn)
    ? {
        threadId: value.turn.threadId ?? null,
        turnId: value.turn.turnId ?? value.turn.id ?? null,
        status: value.turn.status ?? null,
      }
    : null;
  return {
    type: value.type ?? null,
    rootThreadId: value.rootThreadId ?? null,
    threadId: value.threadId ?? null,
    statusType: value.statusType ?? null,
    ...(turn ? { turn } : {}),
  };
};

const readRuntimeStateEvidence = async (
  page: Page,
  threadId: string | null,
  codexHome: string,
  caseId: PaidAgentSmokeCase,
): Promise<Record<string, unknown>> => {
  const events = await capturedEvents(page);
  const snapshot = threadId
    ? await invokeIpc(page, "codex:thread:snapshot:request", threadId).catch(() => null)
    : null;
  const snapshotRecord = isRecord(snapshot) ? snapshot : null;
  const turns = Array.isArray(snapshotRecord?.turns) ? snapshotRecord.turns : [];
  return {
    browserStateCount: events.browserStates.length,
    codexEventCount: events.codexEvents.length,
    codexEventTail: events.codexEvents.slice(-200).map(summarizeCodexEvent),
    rollout: threadId
      ? await readPaidAgentRolloutEvidence(codexHome, threadId).catch(() => null)
      : null,
    summary: threadId
      ? await invokeIpc(page, "codex:thread:summary:get", threadId).catch(() => null)
      : null,
    subagentOverview:
      threadId && caseId === "subagent"
        ? await invokeIpc(page, "codex:subagents:overview:read", {
            rootThreadId: threadId,
            mode: "expanded",
          }).catch(() => null)
        : null,
    snapshot: {
      statusType: snapshotRecord?.statusType ?? null,
      turnCount: turns.length,
      turns: turns.map((turn) => {
        const record = isRecord(turn) ? turn : null;
        return {
          id: record?.id ?? record?.turnId ?? null,
          status: record?.status ?? null,
          itemCount: Array.isArray(record?.items) ? record.items.length : 0,
        };
      }),
    },
  };
};

const readCompletedThreadEvidence = async (
  page: Page,
  threadId: string,
  expectedProfile: CodexExecutionProfile,
): Promise<{ snapshot: unknown; summary: Record<string, unknown>; turnId: string }> => {
  await expect
    .poll(
      async () => {
        const value = await invokeIpc(page, "codex:thread:summary:get", threadId);
        return isRecord(value) ? value.statusType : null;
      },
      { timeout: 30_000 },
    )
    .toBe("idle");
  const summary = requireRecord(
    await invokeIpc(page, "codex:thread:summary:get", threadId),
    "Paid smoke durable summary",
  );
  expect(summary.executionProfile).toEqual(expectedProfile);
  const snapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
  const snapshotRecord = requireRecord(snapshot, "Paid smoke thread snapshot");
  const turns = Array.isArray(snapshotRecord.turns) ? snapshotRecord.turns : [];
  expect(turns).toHaveLength(1);
  const turn = requireRecord(turns[0], "Paid smoke completed Turn");
  const turnId = typeof turn.id === "string" ? turn.id : turn.turnId;
  if (typeof turnId !== "string") throw new Error("Paid smoke completed Turn returned no id");
  return { snapshot, summary, turnId };
};

const digest = (contents: Buffer | string): string =>
  createHash("sha256").update(contents).digest("hex");

interface PaidCaseContext {
  readonly codexHome: string;
  readonly page: Page;
  readonly profile: CodexExecutionProfile;
  readonly projectSessionId: string;
  readonly threadId: string;
}

const sanitizeFailure = (failure: unknown): { name: string; message: string } => {
  if (!(failure instanceof Error)) {
    return { name: "Error", message: String(failure).slice(0, 1_000) };
  }
  return {
    name: failure.name || "Error",
    message: failure.message.replaceAll(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").slice(0, 1_000),
  };
};

const preflightPaidAccount = async (page: Page): Promise<{ type: "chatgpt"; planType: string }> => {
  const snapshot = requireRecord(
    await invokeIpc(page, "codex:account:read"),
    "Paid smoke account snapshot",
  );
  const account = requireRecord(snapshot.account, "Paid smoke account");
  if (
    account.type !== "chatgpt" ||
    typeof account.planType !== "string" ||
    !isPaidChatGptPlan(account.planType)
  ) {
    throw new Error("Paid Agent smoke requires a signed-in ChatGPT subscription account");
  }
  return { type: "chatgpt", planType: account.planType };
};

const runPaidCase = async (
  caseId: PaidAgentSmokeCase,
  prompt: string,
  marker: string,
  testInfo: TestInfo,
  verify: (context: PaidCaseContext & { snapshot: unknown }) => Promise<Record<string, unknown>>,
  beforeSend: (context: { readonly page: Page }) => Promise<void> = async () => undefined,
): Promise<void> => {
  const sourceCodexHome = process.env.NODEX_PAID_AGENT_SMOKE_SOURCE_CODEX_HOME;
  if (!sourceCodexHome)
    throw new Error("Use `vp run agent:smoke:paid --case ...` to run this test");
  const harness = await ElectronScenarioHarness.create({
    label: `paid-agent-${caseId}`,
    codex: "copy-auth",
    sourceCodexHome,
    cwd: repositoryRoot,
    prepareAgentRuntime: false,
    environment: { NODEX_LOG_FILE: "1", NODEX_LOG_CONSOLE: "0" },
  });
  const copiedAuthPath = path.join(harness.profile.codexHome, "auth.json");
  const codexConfigPath = path.join(harness.profile.codexHome, "config.toml");
  // These canaries validate one named tool boundary. The ambient QA skill can redirect the model
  // to an unrelated CLI; all other bundled and DesktopToolRuntime plugin skills stay enabled.
  fs.writeFileSync(codexConfigPath, buildPaidAgentSmokeCodexConfig(caseId), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const diagnostics: string[] = [];
  const startedAt = Date.now();
  let page: Page | null = null;
  let threadId: string | null = null;
  let result: Record<string, unknown> = {};
  let runtimePreflight: Record<string, unknown> | null = null;
  let firstSubmissionEvidence: AgentFirstSubmissionEvidence | null = null;
  let failure: unknown;
  try {
    page = await harness.launch();
    page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
    });
    const account = await preflightPaidAccount(page);
    const draft = await createPaidSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      caseId,
    );
    const preflight = await preflightExecutionProfile(page, caseId);
    const selectedProfile = await selectExecutionProfile(page, preflight);
    await beforeSend({ page });
    const submission = await sendPrompt(page, draft.projectSessionId, prompt);
    threadId = submission.threadId;
    firstSubmissionEvidence = submission.firstSubmission;
    if (caseId === "browser") {
      const threadPage = page;
      const skills = (await invokeIpc(page, "codex:composer-skills:list", {
        cwds: [harness.profile.initialProjectsDirectory],
      })) as Array<Record<string, unknown>>;
      if (skills.some((skill) => skill.name === "agent-browser")) {
        throw new Error("Competing Agent Browser skill remained enabled after Thread launch");
      }
      if (!skills.some((skill) => skill.name === "browser:control-in-app-browser")) {
        throw new Error("Browser plugin skill was not available after Thread launch");
      }
      const relevantSkills = skills.filter(
        (skill) =>
          skill.name === "agent-browser" || skill.name === "browser:control-in-app-browser",
      );
      await expect
        .poll(
          async () => {
            const response = requireRecord(
              await invokeIpc(threadPage, "codex:mcp-server-statuses:list", threadId),
              "Thread MCP server statuses",
            );
            const statuses = Array.isArray(response.data) ? response.data.filter(isRecord) : [];
            const nodeReplStatus = statuses.find((status) => status.name === "node_repl") ?? null;
            runtimePreflight = {
              skills: relevantSkills.map((skill) => ({
                name: skill.name ?? null,
                scope: skill.scope ?? null,
              })),
              mcpServers: statuses.map((status) => ({
                name: status.name ?? null,
                runtimeStatus: status.runtimeStatus ?? null,
                tools: isRecord(status.tools) ? Object.keys(status.tools).sort() : [],
              })),
            };
            const hasJavaScriptTool =
              isRecord(nodeReplStatus?.tools) && "js" in nodeReplStatus.tools;
            return `${String(nodeReplStatus?.runtimeStatus ?? "missing")}:${String(hasJavaScriptTool)}`;
          },
          { timeout: 30_000 },
        )
        .toBe("connected:true");
    }
    await waitForCompletedAgentTurn(page, threadId, 150_000);
    await waitForAgentFinalMarker(page, marker, 10_000);
    const completed = await readCompletedThreadEvidence(page, threadId, selectedProfile);
    const rollout = await readPaidAgentRolloutEvidence(harness.profile.codexHome, threadId);
    expect(rollout).not.toBeNull();
    expect(rollout?.modelProvider).toBe("openai");
    // A multi-agent runtime records descendant work in the root session rollout. Anchor the
    // provider cross-check to the root Turn selected by the canonical Thread snapshot.
    expect(rollout?.turnContexts.filter((context) => context.turnId === completed.turnId)).toEqual([
      expect.objectContaining({
        turnId: completed.turnId,
        model: selectedProfile.modelId,
        effort: selectedProfile.reasoningEffort,
      }),
    ]);
    result = {
      schemaVersion: 1,
      case: caseId,
      account,
      disabledSkillNames: PAID_AGENT_SMOKE_DISABLED_SKILL_NAMES,
      expectedLogicalExecutions: PAID_AGENT_SMOKE_DEFINITIONS[caseId].expectedLogicalExecutions,
      executionProfile: selectedProfile,
      projectSessionId: draft.projectSessionId,
      threadId,
      firstSubmission: firstSubmissionEvidence,
      rollout,
      ...(await verify({
        codexHome: harness.profile.codexHome,
        page,
        profile: selectedProfile,
        projectSessionId: draft.projectSessionId,
        snapshot: completed.snapshot,
        threadId,
      })),
    };
    expect(diagnostics).toEqual([]);
  } catch (error) {
    failure = error;
  }

  let evidenceFailure: unknown;
  let credentialScrubFailure: unknown;
  let cleanupFailure: unknown;
  try {
    if (page) {
      await page
        .screenshot({ path: testInfo.outputPath("final.png"), fullPage: true })
        .catch(() => undefined);
      result = {
        ...result,
        runtimeState: await readRuntimeStateEvidence(
          page,
          threadId,
          harness.profile.codexHome,
          caseId,
        ).catch((error) => ({ unavailable: sanitizeFailure(error) })),
      };
    }
    await harness.stopElectron().catch((error) => diagnostics.push(`shutdown: ${String(error)}`));
    const runtimeLogs = await readBoundedElectronRuntimeLogs(harness.profile).catch(
      (error) => `Could not read runtime logs: ${String(error)}\n`,
    );
    const evidence = {
      ...result,
      ...(runtimePreflight ? { runtimePreflight } : {}),
      durationMs: Date.now() - startedAt,
      diagnostics,
      failed: Boolean(failure),
      ...(failure ? { failure: sanitizeFailure(failure) } : {}),
    };
    const runtimeLogPath = testInfo.outputPath("runtime.log");
    fs.writeFileSync(runtimeLogPath, runtimeLogs);
    fs.writeFileSync(
      testInfo.outputPath("evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await testInfo.attach("paid-agent-smoke-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("paid-agent-runtime-logs", {
      path: runtimeLogPath,
      contentType: "text/plain",
    });
  } catch (error) {
    evidenceFailure = error;
  } finally {
    try {
      fs.rmSync(copiedAuthPath, { force: true });
    } catch (error) {
      credentialScrubFailure = error;
    }
    try {
      await harness.close();
    } catch (error) {
      cleanupFailure = error;
    }
  }
  const failures = [failure, evidenceFailure, credentialScrubFailure, cleanupFailure].filter(
    (candidate) => candidate !== undefined,
  );
  if (failures.length > 1) throw new AggregateError(failures, "Paid Agent smoke failed");
  if (failures.length === 1) throw failures[0];
};

test("creates and verifies exact file bytes @paid-agent-file", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const marker = `PAID_FILE_SMOKE_OK_${token}`;
  const fileContents = `NODEX_PAID_FILE_SMOKE_${token}\n`;
  const filePath = path.join("/tmp", `nodex-paid-file-smoke-${token}.txt`);
  try {
    await runPaidCase(
      "file",
      `Use a file-editing or shell tool to create exactly ${filePath} with the exact UTF-8 contents ${JSON.stringify(fileContents)}. Read it back with a tool to verify the exact bytes. Do not modify any other file. Finish with the exact marker ${marker}.`,
      marker,
      testInfo,
      async ({ snapshot }) => {
        const bytes = fs.readFileSync(filePath);
        expect(bytes.equals(Buffer.from(fileContents))).toBe(true);
        const toolTypes = collectRecords(snapshot)
          .map((record) => record.type)
          .filter((type): type is string => typeof type === "string");
        expect(toolTypes.some((type) => type === "commandExecution" || type === "fileChange")).toBe(
          true,
        );
        return { file: { byteLength: bytes.length, sha256: digest(bytes) }, marker };
      },
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("opens a local fixture through Browser Use @paid-agent-browser", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const pageMarker = `NODEX_BROWSER_FIXTURE_${token}`;
  const finalMarker = `PAID_BROWSER_SMOKE_OK_${token}`;
  const fixture = await startBrowserHttpFixture(pageMarker);
  try {
    await runPaidCase(
      "browser",
      `Use the in-app Browser tool to open ${fixture.url}, read the visible page token, and report it. Do not use shell, curl, web search, or a direct fetch. Finish with the exact marker ${finalMarker}.`,
      finalMarker,
      testInfo,
      async ({ page, projectSessionId, snapshot, threadId }) => {
        expect(fixture.requests).toContain("/browser-smoke");
        const events = await capturedEvents(page);
        const browserTabs = events.browserStates.flatMap((state) =>
          isRecord(state) && Array.isArray(state.tabs) ? state.tabs : [],
        );
        expect(
          browserTabs.some(
            (tab) =>
              isRecord(tab) &&
              tab.url === fixture.url &&
              (tab.codexSessionId === threadId || tab.codexSessionId === projectSessionId),
          ),
        ).toBe(true);
        const browserMcpItems = collectRecords(snapshot).filter((record) => {
          if (record.type !== "mcpToolCall" || !isRecord(record.mcpToolCall)) return false;
          const source = record.mcpToolCall.source;
          return isRecord(source) && source.kind === "browserUse" && source.backend === "iab";
        });
        expect(browserMcpItems.length).toBeGreaterThan(0);
        return {
          browser: {
            targetOrigin: new URL(fixture.url).origin,
            targetPathObserved: true,
            browserUseStateObserved: true,
            completedMcpItemCount: browserMcpItems.length,
          },
          finalMarker,
          pageMarker,
        };
      },
      async ({ page }) => {
        await invokeIpc(page, "browser-use-policy-update-origin-rule", {
          action: "add",
          kind: "allowed",
          origin: new URL(fixture.url).origin,
          resource: "origin",
        });
      },
    );
  } finally {
    await fixture.close();
  }
});

test("spawns exactly one child and converges to Done @paid-agent-subagent", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const token = randomUUID();
  const childContents = `NODEX_PAID_SUBAGENT_${token}\n`;
  const childPath = path.join("/tmp", `nodex-paid-subagent-smoke-${token}.txt`);
  const finalMarker = `PAID_SUBAGENT_SMOKE_OK_${token}`;
  try {
    await runPaidCase(
      "subagent",
      `Spawn exactly one subagent. Ask that child to create ${childPath} with exact UTF-8 contents ${JSON.stringify(childContents)}, verify the file with a tool, and report CHILD_DONE_${token}. Wait for that child to finish. Do not spawn any other subagent. Then finish with the exact marker ${finalMarker}.`,
      finalMarker,
      testInfo,
      async ({ codexHome, page, threadId }) => {
        const bytes = fs.readFileSync(childPath);
        expect(bytes.equals(Buffer.from(childContents))).toBe(true);

        await expect
          .poll(
            async () => {
              const value = await invokeIpc(page, "codex:subagents:overview:read", {
                rootThreadId: threadId,
                mode: "expanded",
              });
              if (!isRecord(value) || !isRecord(value.active) || !isRecord(value.done)) return null;
              return {
                active: value.active.knownCount,
                completeness: value.completeness,
                done: value.done.knownCount,
                rowCount:
                  (Array.isArray(value.active.rows) ? value.active.rows.length : 0) +
                  (Array.isArray(value.done.rows) ? value.done.rows.length : 0),
              };
            },
            { timeout: 30_000 },
          )
          .toEqual({ active: 0, completeness: "complete", done: 1, rowCount: 1 });
        const overview = await invokeIpc(page, "codex:subagents:overview:read", {
          rootThreadId: threadId,
          mode: "expanded",
        });
        const activeRows =
          isRecord(overview) && isRecord(overview.active) ? overview.active.rows : null;
        const doneRows = isRecord(overview) && isRecord(overview.done) ? overview.done.rows : null;
        expect(activeRows).toEqual([]);
        expect(doneRows).toHaveLength(
          PAID_AGENT_SMOKE_DEFINITIONS.subagent.expectedLogicalExecutions - 1,
        );
        const childThreadId =
          Array.isArray(doneRows) && isRecord(doneRows[0]) ? doneRows[0].threadId : null;
        if (typeof childThreadId !== "string") {
          throw new Error("Canonical Subagent overview returned no child Thread id");
        }
        expect(doneRows).toEqual([
          expect.objectContaining({
            threadId: childThreadId,
            parentThreadId: threadId,
            status: "done",
          }),
        ]);
        const events = await capturedEvents(page);
        expect(
          events.codexEvents.some(
            (event) =>
              isRecord(event) &&
              event.type === "subagentOverviewInvalidated" &&
              event.rootThreadId === threadId,
          ),
        ).toBe(true);
        const childRollout = await readPaidAgentRolloutEvidence(codexHome, childThreadId);
        return {
          child: {
            threadId: childThreadId,
            byteLength: bytes.length,
            sha256: digest(bytes),
            rolloutObserved: childRollout !== null,
          },
          finalMarker,
          topology: overview,
        };
      },
    );
  } finally {
    fs.rmSync(childPath, { force: true });
  }
});

// Run explicitly: vp run agent:smoke:paid --case inbox-image
test("reads the image in an explicit Inbox suggestion @paid-agent-inbox-image", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const caseId = "inbox-image";
  const definition = PAID_AGENT_SMOKE_DEFINITIONS[caseId];
  const sourceCodexHome = process.env.NODEX_PAID_AGENT_SMOKE_SOURCE_CODEX_HOME;
  if (!sourceCodexHome) throw new Error("Use `vp run agent:smoke:paid --case inbox-image`");
  const artifacts =
    process.env.NODEX_PAID_INBOX_IMAGE_ARTIFACT_DIR ?? testInfo.outputPath("review");
  fs.mkdirSync(artifacts, { recursive: true });
  const wirePath = path.join(artifacts, "wire.jsonl");
  fs.writeFileSync(wirePath, "");
  const harness = await ElectronScenarioHarness.create({
    label: "paid-agent-inbox-image",
    codex: "copy-auth",
    sourceCodexHome,
    cwd: repositoryRoot,
    prepareAgentRuntime: false,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_CONSOLE: "0",
      NODEX_PAID_INBOX_WIRE_LOG: wirePath,
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: repositoryRoot,
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: path.join(artifacts, "node-runtime"),
    },
  });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const observer = path.join(repositoryRoot, "tests/e2e/fixtures/paid-inbox-wire-observer.cjs");
  const copiedAuthPath = path.join(harness.profile.codexHome, "auth.json");
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  const wireRecords = (): Record<string, unknown>[] =>
    fs
      .readFileSync(wirePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const fixturePath = path.join(repositoryRoot, "tests/e2e/fixtures/inbox-image.png");
  let status = "failed";
  let failure: ReturnType<typeof sanitizeFailure> | null = null;
  let page: Page | null = null;
  let recording = false;
  let explicitlyRequested = false;
  let item: InboxItem | undefined;
  let account: unknown;
  let selection: unknown;
  let providerPreflight: unknown;
  const diagnostics: string[] = [];
  try {
    fs.writeFileSync(
      path.join(artifacts, "node-runtime"),
      `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(observer)} "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(harness.profile.codexHome, "config.toml"),
      buildPaidAgentSmokeCodexConfig(caseId),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    page = await harness.launch();
    page.on("pageerror", (error) => diagnostics.push(error.message));
    account = await preflightPaidAccount(page);
    await preflightExecutionProfile(page, caseId);
    const seed = new RendererIpcSeedAdapter(page);
    const project = await seed.createProject({
      name: "Image smoke",
      sources: [harness.profile.initialProjectsDirectory],
    });
    const settings = await invokeTypedIpc(page, "settings:inbox:update", {
      suggestions: "on_request",
      suggestionAgent: { instanceId: "codex" },
      suggestionModel: definition.modelId,
      suggestionsChooseModels: false,
    });
    const readProviders = async () => {
      const providers = await invokeTypedIpc(harness.page, "agent-runtime:providers:read", {
        refresh: true,
      });
      const resolution = resolveInboxModel(
        providers,
        inboxSuggestionChoice(settings),
        "suggestion",
      );
      providerPreflight = {
        resolution: resolution.kind,
        reason: resolution.kind === "unavailable" ? resolution.message : null,
        providers: providers.map((provider) => ({
          instanceId: provider.instanceId,
          enabled: provider.enabled,
          status: provider.status,
          availability: provider.availability,
          installed: provider.installed,
          models: provider.models.map((model) => model.slug),
        })),
      };
      return providers;
    };
    let providers = await readProviders();
    await expect
      .poll(() => wireRecords().some((record) => record.type === "observer.started"))
      .toBe(true);
    // A cold catalog may not be ready with the window; refresh readiness before asking for work.
    await expect
      .poll(
        async () => {
          const resolution = resolveInboxModel(
            providers,
            inboxSuggestionChoice(settings),
            "suggestion",
          );
          if (resolution.kind === "ready") return resolution.kind;
          providers = await readProviders();
          return resolveInboxModel(providers, inboxSuggestionChoice(settings), "suggestion").kind;
        },
        { timeout: 45_000 },
      )
      .toBe("ready");
    const resolved = resolveInboxModel(providers, inboxSuggestionChoice(settings), "suggestion");
    if (resolved.kind !== "ready") throw new Error(`Inbox model is ${resolved.kind}`);
    selection = resolved.selection;
    expect(resolved.selection.model).toBe(definition.modelId);
    await harness.application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    });
    await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
    const inbox = page.locator('[data-inbox-scope="library"]');
    await expect(inbox).toBeVisible();
    const composer = inbox.getByTestId("inbox-composer");
    await composer.getByTestId("message-image-picker").setInputFiles(fixturePath);
    const text = "Can you take care of this?";
    await composer.getByRole("textbox", { name: "Message your Inbox" }).fill(text);
    await expect(
      composer.getByRole("button", { name: "Send to Inbox", exact: true }),
    ).toBeEnabled();
    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1280, height: 800 },
    });
    recording = true;
    await page.screencast.showActions({ position: "bottom" });
    await composer.getByRole("button", { name: "Send to Inbox", exact: true }).click();
    await expect(inbox.getByTestId("inbox-message").filter({ hasText: text })).toBeVisible();
    item = (await seed.readInbox("inbox")).items[0];
    if (!item) throw new Error("The sent Inbox message is missing");
    const row = inbox.locator(`[data-inbox-page-id="${item.pageId}"]`);
    claim(
      "The Page body begins with the image",
      true,
      /^!\[.*?\]\(nodex:\/\/files\//u.test(item.body),
    );
    claim(
      "The canonical Page begins with an image Block",
      "image",
      (await seed.readPageBlockTree(project.id, item.pageId))[0]?.type,
    );
    claim(
      "The message text does not reveal the task",
      text,
      item.body.replace(/^!\[.*?\]\([^\n]+\)\s*/u, "").trim(),
    );
    const message = row.getByTestId("inbox-message-unit");
    const image = message.locator("img");
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
      )
      .toBe(true);
    const imageBox = await image.boundingBox();
    const textBox = await message.getByText(text, { exact: true }).boundingBox();
    claim(
      "The Inbox shows the image above the message text",
      true,
      Boolean(imageBox && textBox && imageBox.y + imageBox.height <= textBox.y),
    );
    claim(
      "No model ran before the explicit request",
      0,
      wireRecords().filter((record) => record.type === "runtime.request").length,
    );
    // A send may still be waiting for the background drain; the offered action is readiness.
    const suggest = row.getByRole("button", { name: "Suggest", exact: true });
    await expect(suggest).toBeVisible();
    await suggest.click();
    explicitlyRequested = true;
    await expect
      .poll(
        async () => {
          const items = (await seed.readInbox("inbox")).items;
          item = items[0];
          if (item?.suggestionState === "failed")
            throw new Error(item.suggestionError ?? "Inbox suggestion failed");
          return item?.suggestionState;
        },
        { timeout: 120_000 },
      )
      .toBe("settled");
    if (!item?.proposal) throw new Error("The settled message has no suggestion");
    const suggestion = row.getByTestId("inbox-suggestion");
    await expect(suggestion).toBeVisible();
    await expect(suggestion).toContainText(/Billing|Payments/i);
    const action = item.proposal.action;
    const prompt =
      action.type === "new_chat" || action.type === "send_to_chat" ? action.prompt : null;
    claim(
      "The real suggestion describes the image-only instruction",
      true,
      /Billing|Payments/i.test(`${item.proposal.summary} ${prompt ?? ""}`),
    );
    const wire = wireRecords();
    const requests = wire.filter((record) => record.type === "runtime.request");
    claim(
      "Exactly one suggestion execution ran",
      definition.expectedLogicalExecutions,
      requests.length,
    );
    const request = requests[0]!;
    claim(
      "The dispatched model matches Inbox settings",
      resolved.selection,
      request.modelSelection,
    );
    claim(
      "The model's text input does not reveal the image instruction",
      false,
      /Billing|Payments/i.test(String(request.prompt)),
    );
    claim("The model receives an image marker", true, String(request.prompt).includes("[Image 1]"));
    const executions = wire.filter((record) => record.type === "codex.exec");
    claim("One production codex exec process ran", 1, executions.length);
    const execution = requireRecord(executions[0], "Codex exec evidence");
    claim("Codex exec uses the authorized model", definition.modelId, execution.model);
    claim("Codex exec uses the Inbox's fixed effort", definition.reasoningEffort, execution.effort);
    claim("Codex exec receives one --image argument", 1, execution.imageArgumentCount);
    const fixture = fs.readFileSync(fixturePath);
    claim(
      "The --image file contains the exact fixture bytes",
      [{ byteLength: fixture.length, sha256: digest(fixture) }],
      execution.images,
    );
    claim(
      "The image bytes reach Codex unchanged",
      [{ mediaType: "image/png", byteLength: fixture.length, sha256: digest(fixture) }],
      request.images,
    );
    claim(
      "Codex exec completed successfully",
      [{ code: 0, signal: null }],
      wire
        .filter(
          (record) => record.type === "codex.exec.exit" && record.childPid === execution.childPid,
        )
        .map((record) => ({ code: record.code, signal: record.signal })),
    );
    // Clear hover chrome before capturing the settled suggestion.
    await page.mouse.move(600, 140);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, "final.png") });
    const decision = row
      .getByTestId("inbox-actions")
      .getByRole("button", { name: /New (?:projectless )?chat|Send to/ })
      .first();
    if (await decision.count()) {
      await decision.hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, "decision-tooltip.png") });
    }
    claim("No renderer errors occurred", [], diagnostics);
    status = "passed";
  } catch (error) {
    failure = sanitizeFailure(error);
    await page?.screenshot({ path: path.join(artifacts, "final.png") }).catch(() => undefined);
    throw error;
  } finally {
    try {
      if (recording) await page?.screencast.stop();
      await harness.stopElectron();
      fs.writeFileSync(
        path.join(artifacts, "runtime.log"),
        await readBoundedElectronRuntimeLogs(harness.profile),
      );
      const action = item?.proposal?.action;
      const execution = wireRecords();
      const nativeExec = execution.find((record) => record.type === "codex.exec");
      const verification = {
        status,
        failure,
        case: caseId,
        request: {
          mode: "explicit",
          suggestions: "on_request",
          trigger: "Suggest",
          clicked: explicitlyRequested,
        },
        account,
        selection,
        providerPreflight,
        actualModel: nativeExec?.model ?? null,
        actualEffort: nativeExec?.effort ?? null,
        claims,
        diagnostics,
        fixture: { path: fixturePath, sha256: digest(fs.readFileSync(fixturePath)) },
        suggestion: item?.proposal
          ? {
              summary: item.proposal.summary,
              prompt:
                action && (action.type === "new_chat" || action.type === "send_to_chat")
                  ? action.prompt
                  : null,
              producedBy: item.proposal.producedBy,
            }
          : null,
        message: item
          ? {
              pageId: item.pageId,
              body: item.body,
              suggestionState: item.suggestionState,
              suggestionError: item.suggestionError,
            }
          : null,
        execution: execution.filter(
          (record) => record.type === "codex.exec" || record.type === "codex.exec.exit",
        ),
      };
      fs.writeFileSync(
        path.join(artifacts, "verification.json"),
        `${JSON.stringify(verification, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(artifacts, "README.md"),
        `# Inbox image suggestion\n\nStatus: ${status}.\n\nWith suggestions set to on_request, the Inbox composer imports the image and sends it before “Can you take care of this?”, then the user explicitly asks with the message row's Suggest button.\n\nObserved codex exec model: ${String(verification.actualModel)}. Effort: ${String(verification.actualEffort)}. The observer hashes the --image file before cleanup; verification.json checks its exact fixture bytes, the image-first Page and UI, and the returned suggestion. Only allowlisted execution fields are recorded; raw arguments, environment and native output are excluded.\n\nSummary: ${verification.suggestion?.summary ?? "No suggestion produced."}\n\nPrompt: ${verification.suggestion?.prompt ?? "No chat prompt produced."}\n\nRun: vp run agent:smoke:paid --case inbox-image\n`,
      );
      await testInfo.attach("inbox-image-verification", {
        path: path.join(artifacts, "verification.json"),
        contentType: "application/json",
      });
    } finally {
      fs.rmSync(copiedAuthPath, { force: true });
      await harness.close();
    }
  }
});
