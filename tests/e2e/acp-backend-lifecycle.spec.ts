import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";

const repositoryRoot = process.cwd();
const instanceConfigId = "claude-e2e";
const protocolSessionId = "acp-electron-e2e-session";
const liveMessage = "ACP_ELECTRON_LIVE_MESSAGE";
const restoredMessage = "ACP_ELECTRON_RESTORED_MESSAGE";

type AcpObservation =
  | { readonly method: "initialize" }
  | { readonly method: "session/new"; readonly cwd: string }
  | { readonly method: "session/load"; readonly sessionId: string }
  | { readonly method: "session/prompt"; readonly sessionId: string };

const readObservations = (observationPath: string): readonly AcpObservation[] => {
  try {
    return JSON.parse(fs.readFileSync(observationPath, "utf8")) as AcpObservation[];
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
};

const prepareScriptedAcpPackage = (input: {
  readonly packageRoot: string;
  readonly observationPath: string;
}): void => {
  const entryDirectory = path.join(input.packageRoot, "dist");
  fs.mkdirSync(entryDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(input.packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@agentclientprotocol/claude-agent-acp",
      version: "0.73.0",
      type: "module",
    })}\n`,
  );
  const scriptedAgentUrl = pathToFileURL(
    path.join(repositoryRoot, "scripts/scenarios/runtime/scripted-acp-agent.ts"),
  ).href;
  const scenario = {
    sessionId: protocolSessionId,
    sessionLifecycle: {
      load: true,
      list: false,
      delete: false,
      fork: false,
      resume: false,
      close: false,
      loadReplay: [restoredMessage],
    },
    beforePrompt: [liveMessage],
  };
  fs.writeFileSync(
    path.join(entryDirectory, "index.js"),
    [
      'if (process.argv.includes("--version")) { console.log("0.73.0"); process.exit(0); }',
      `process.env.NODEX_SCRIPTED_ACP_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))};`,
      `process.env.NODEX_SCRIPTED_ACP_OBSERVATION = ${JSON.stringify(input.observationPath)};`,
      `await import(${JSON.stringify(scriptedAgentUrl)});`,
    ].join("\n"),
  );
};

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  (await page.evaluate(
    async ({ targetChannel, targetArgs }) => {
      if (!window.api) throw new Error("Nodex preload API is unavailable");
      const api = window.api as unknown as {
        invoke(target: string, ...input: unknown[]): Promise<unknown>;
      };
      return await api.invoke(targetChannel, ...targetArgs);
    },
    { targetChannel: channel, targetArgs: args },
  )) as Result;

const beginAcpDeltaCapture = async (page: Page, threadId: string): Promise<void> => {
  await page.evaluate(async (targetThreadId) => {
    if (!window.api) throw new Error("Nodex preload API is unavailable");
    const scope = window as typeof window & {
      __acpLifecycleDeltas?: unknown[];
      __releaseAcpLifecycleDeltas?: () => void;
    };
    scope.__releaseAcpLifecycleDeltas?.();
    scope.__acpLifecycleDeltas = [];
    scope.__releaseAcpLifecycleDeltas = window.api.on(
      "agent-backend:acp:session-changed",
      (event: unknown) => scope.__acpLifecycleDeltas?.push(event),
    );
    await window.api.invoke("agent-backend:acp:session:observe", targetThreadId);
  }, threadId);
};

const capturedAcpDeltas = async (page: Page): Promise<readonly unknown[]> =>
  await page.evaluate(() => {
    const scope = window as typeof window & { __acpLifecycleDeltas?: unknown[] };
    return scope.__acpLifecycleDeltas ?? [];
  });

const containsText = (value: unknown, expected: string): boolean => {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsText(entry, expected));
};

test("persists an ACP backend and resumes its protocol session after restart", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "acp-backend-lifecycle" });
  const packageRoot = path.join(harness.profile.runRoot, "scripted-acp-package");
  const observationPath = path.join(harness.profile.runRoot, "scripted-acp-observations.json");
  prepareScriptedAcpPackage({ packageRoot, observationPath });

  try {
    let page = await harness.launch();
    await invoke(page, "settings:acp-agents:update", {
      instances: [
        {
          id: instanceConfigId,
          agentDefinitionId: "claude-agent-acp",
          packageRoot,
          nodeExecutable: process.execPath,
          enabled: true,
          credentials: { kind: "isolated-home", home: harness.profile.runRoot },
          proxy: "isolated",
        },
      ],
    });

    const projects = await invoke<{
      readonly items: readonly {
        readonly id: string;
        readonly primaryWorkspaceRoot: string | null;
      }[];
    }>(page, "projects:list");
    const project = projects.items.find(
      ({ primaryWorkspaceRoot }) => primaryWorkspaceRoot !== null,
    );
    if (!project) throw new Error("ACP Electron scenario requires one local Project");
    const sessionId = createUuidV7();
    const created = await invoke<{
      readonly ok: boolean;
      readonly value?: { readonly id: string };
      readonly error?: { readonly message: string };
    }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.acp.session.create"),
      payload: {
        sessionId,
        input: {
          projectId: project.id,
          noThreadFallbackTitle: "ACP lifecycle E2E",
          initialPageIds: [],
        },
      },
    });
    if (!created.ok || created.value?.id !== sessionId) {
      throw new Error(created.error?.message ?? "Could not create ACP scenario Session");
    }

    const started = await invoke<{
      readonly thread: {
        readonly threadId: string;
        readonly backendBinding: unknown;
      };
      readonly presentation: {
        readonly snapshot: {
          readonly sessionId: string;
          readonly turns: readonly unknown[];
        };
      };
    }>(page, "agent-backend:acp:thread:start", {
      sessionId,
      instanceConfigId,
      prompt: "Start the ACP lifecycle scenario",
    });
    const threadId = started.thread.threadId;
    expect(started.thread.backendBinding).toEqual({
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId,
    });
    expect(started.presentation.snapshot.sessionId).toBe(protocolSessionId);
    await expect
      .poll(async () => {
        const current = await invoke<{
          readonly snapshot: { readonly turns: readonly unknown[] };
        } | null>(page, "agent-backend:acp:session:read", threadId);
        return containsText(current?.snapshot.turns, liveMessage);
      })
      .toBe(true);

    const durableBeforeRestart = await invoke<{
      readonly thread: { readonly backendBinding: unknown } | null;
    } | null>(page, "project-sessions:get", sessionId);
    expect(durableBeforeRestart?.thread?.backendBinding).toEqual(started.thread.backendBinding);
    await expect
      .poll(() => readObservations(observationPath))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "session/new" }),
          expect.objectContaining({ method: "session/prompt", sessionId: protocolSessionId }),
        ]),
      );

    await beginAcpDeltaCapture(page, threadId);
    await invoke(page, "agent-backend:acp:session:prompt", {
      threadId,
      prompt: "Emit a live delta through Main and preload",
    });
    await expect
      .poll(async () => containsText(await capturedAcpDeltas(page), liveMessage))
      .toBe(true);

    page = await harness.restart();
    const reopened = await invoke<{
      readonly snapshot: {
        readonly sessionId: string;
        readonly turns: readonly unknown[];
      };
    }>(page, "agent-backend:acp:session:open", { threadId });
    expect(reopened.snapshot.sessionId).toBe(protocolSessionId);
    expect(containsText(reopened.snapshot.turns, restoredMessage)).toBe(true);
    await expect
      .poll(() => readObservations(observationPath))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "session/load", sessionId: protocolSessionId }),
        ]),
      );

    const durableAfterRestart = await invoke<{
      readonly thread: { readonly backendBinding: unknown } | null;
    } | null>(page, "project-sessions:get", sessionId);
    expect(durableAfterRestart?.thread?.backendBinding).toEqual(started.thread.backendBinding);
  } finally {
    await harness.close();
  }
});
