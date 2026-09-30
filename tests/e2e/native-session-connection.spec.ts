import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  AGENT_CLI_SCENARIO_ID,
  AGENT_CLI_PROJECT_NAME,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type {
  NativeSessionAttachResult,
  NativeSessionCatalogPage,
} from "../../src/shared/native-session-catalog";
import type { AgentBackendSessionPresentation } from "../../src/shared/agent-conversation";
import type { ProjectSession } from "../../src/shared/types";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/agent-smoke-harness";

test("connects a Claude CLI conversation through the shared chooser and resumes its exact native identity after restart", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "native-session-connection",
      scenarioId: AGENT_CLI_SCENARIO_ID,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
        NODEX_LOG_FILE: "1",
      },
      onFailure: async ({ readRuntimeLogs }) => {
        await testInfo.attach("native-session-runtime.log", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
      },
    },
    async ({ harness, page, manifest }) => {
      if (!manifest) throw new Error("Native connection needs the seeded Project");
      const nativeSessionId = createUuidV7();
      const userId = createUuidV7();
      const cwd = realpathSync(harness.profile.initialProjectsDirectory);
      const nativeHome = path.join(harness.profile.runRoot, "native-claude");
      const projectDirectory = path.join(
        nativeHome,
        "projects",
        cwd.replace(/[^a-zA-Z0-9]/gu, "-"),
      );
      mkdirSync(projectDirectory, { recursive: true });
      const transcriptPath = path.join(projectDirectory, `${nativeSessionId}.jsonl`);
      const history =
        [
          {
            type: "user",
            uuid: userId,
            parentUuid: null,
            sessionId: nativeSessionId,
            cwd,
            timestamp: "2026-09-30T00:00:00.000Z",
            message: { role: "user", content: "Remember my existing CLI context" },
          },
          {
            type: "assistant",
            uuid: createUuidV7(),
            parentUuid: userId,
            sessionId: nativeSessionId,
            cwd,
            timestamp: "2026-09-30T00:00:01.000Z",
            message: {
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: "Existing context retained" }],
            },
          },
          {
            type: "custom-title",
            customTitle: "Existing CLI conversation",
            sessionId: nativeSessionId,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n";
      writeFileSync(transcriptPath, history);
      const executable = path.join(harness.profile.runRoot, "claude");
      const peer = pathToFileURL(
        path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
      ).href;
      writeFileSync(executable, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
        mode: 0o755,
      });
      await invokeIpc(page, "settings:claude-agents:update", {
        instances: [
          {
            id: "native-work",
            displayName: "Work",
            binaryPath: executable,
            configDirectory: nativeHome,
            enabled: true,
            environment: [],
          },
        ],
      });
      const observationsPath = path.join(nativeHome, "observations.jsonl");

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("link", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Conversation agent" }).click();
      await page.getByRole("option", { name: "Claude Code · Work" }).click();
      await page.getByRole("button", { name: "Conversation destination" }).click();
      await page.getByRole("option", { name: AGENT_CLI_PROJECT_NAME, exact: true }).click();
      await page.getByRole("button", { name: "Browse", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Connect Existing CLI conversation" }),
      ).toBeVisible();
      expect(existsSync(observationsPath)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath("native-conversation-chooser.png") });
      await page.getByRole("button", { name: "Connect Existing CLI conversation" }).click();
      await expect(
        page.getByRole("button", { name: "Connected Existing CLI conversation" }),
      ).toBeDisabled();
      expect(existsSync(observationsPath)).toBe(false);
      expect(readFileSync(transcriptPath, "utf8")).toBe(history);

      const attached = (await invokeIpc(page, "native-sessions:list", {
        backendKind: "claude",
        instanceConfigId: "native-work",
      })) as NativeSessionCatalogPage;
      const entry = attached.entries.find((row) => row.nativeSessionId === nativeSessionId);
      if (!entry?.attachedSessionId || !entry.attachedThreadId)
        throw new Error("Connected native conversation has no Nodex chat");
      const session = (await invokeIpc(
        page,
        "project-sessions:get",
        entry.attachedSessionId,
      )) as ProjectSession;
      expect(session.projectId).toBe(manifest.projectId);
      expect(session.thread?.backendBinding).toEqual({
        kind: "claude",
        instanceConfigId: "native-work",
      });
      const repeated = (await invokeIpc(page, "native-sessions:attach", {
        backendKind: "claude",
        instanceConfigId: "native-work",
        nativeSessionId,
        expectedHome: attached.nativeHome,
        projectId: manifest.projectId,
      })) as NativeSessionAttachResult;
      expect(repeated).toEqual({
        sessionId: entry.attachedSessionId,
        threadId: entry.attachedThreadId,
        alreadyAttached: true,
      });

      const reopenedPage = await harness.restart();
      const restored = (await invokeIpc(reopenedPage, "agent-backend:session:open", {
        threadId: entry.attachedThreadId,
      })) as AgentBackendSessionPresentation;
      expect(restored.snapshot.sessionId).toBe(nativeSessionId);
      expect(restored.snapshot.turns[0]?.promptText).toBe("Remember my existing CLI context");
      const observations = readFileSync(observationsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(observations.find((event) => event.type === "launch")).toMatchObject({
        sessionId: nativeSessionId,
        resumed: true,
      });
      expect(observations.filter((event) => event.type === "prompt")).toEqual([]);
      expect(readFileSync(transcriptPath, "utf8")).toBe(history);
    },
  );
});
