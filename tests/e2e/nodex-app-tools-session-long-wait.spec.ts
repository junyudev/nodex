import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
} from "./support/agent-smoke-harness";
import { nativeAppToolCall, nativeCodeTool } from "./support/native-app-tools";

const TARGET_PROMPT = "Hold the isolated target Run open for the long MCP wait.";
const CALLER_PROMPT = "Wait for the isolated target through the application MCP.";
const MINIMUM_WAIT_MS = 190_000;
interface WireFrame {
  at: number;
  type: string;
  id: string;
  tool?: string;
  input?: Record<string, unknown>;
}

test("keeps a real provider MCP wait alive beyond 185 seconds and cancels its exact host request", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const artifacts = process.env.NODEX_SESSION_COMPLETE_ARTIFACT_DIR;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  let targetSessionId = "";
  let failure: string | null = null;
  const measurements: Record<string, unknown> = {};
  const receiptPath = path.resolve(".generated/prepared-electron-build.json");
  const build = {
    source: fs.existsSync(receiptPath)
      ? JSON.parse(fs.readFileSync(receiptPath, "utf8")).source
      : null,
    mainSha256: createHash("sha256")
      .update(fs.readFileSync(path.resolve("out/main/bootstrap.js")))
      .digest("hex"),
    runtimeSha256: createHash("sha256")
      .update(fs.readFileSync(path.resolve("out/agent-runtime/entry.mjs")))
      .digest("hex"),
  };
  let status = "failed";
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "hold target Run",
          match: (request) => request.hasUserInputText(TARGET_PROMPT),
          expectedCalls: 1,
          respond: { ...responses.stream([responses.created("target_held")]), keepOpen: true },
        },
        {
          name: "start actual application wait",
          match: (request) =>
            request.hasUserInputText(CALLER_PROMPT) && !request.hasToolCallOutput("long_wait"),
          expectedCalls: 1,
          respond: (request) => {
            const tool = nativeCodeTool(request);
            return responses.stream([
              responses.created("wait_started"),
              nativeAppToolCall(
                "long_wait",
                tool.name,
                [
                  '// @exec: {"yield_time_ms": 1000, "max_output_tokens": 1000}',
                  `text(await app.wait_sessions({targets:[{sessionId:${JSON.stringify(targetSessionId)}}],timeoutMs:3600000}));`,
                ].join("\n"),
                tool.namespace,
              ),
              responses.completed("wait_started"),
            ]);
          },
        },
        {
          name: "keep caller alive after code-mode yields",
          match: (request) => request.hasToolCallOutput("long_wait"),
          expectedCalls: 1,
          respond: { ...responses.stream([responses.created("caller_held")]), keepOpen: true },
        },
      ],
    },
    async (model) => {
      const wire = testInfo.outputPath("wait-wire.jsonl");
      const launcher = testInfo.outputPath("observed-node");
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(
        launcher,
        `#!/bin/sh\nexport NODEX_TEST_SESSION_MCP_WIRE_LOG=${quote(wire)}\nexec ${quote(process.execPath)} --require ${quote(path.resolve("tests/e2e/fixtures/session-mcp-wire-observer.cjs"))} "$@"\n`,
        { mode: 0o755 },
      );
      const harness = await ElectronScenarioHarness.create({
        label: "session-mcp-long-wait",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
          NODEX_LOG_CONSOLE: "0",
          NODEX_LOG_FILE: "1",
          NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: launcher,
          NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\ncode_mode = true\ncode_mode_only = true\n`,
        { mode: 0o600 },
      );
      const frames = (): WireFrame[] =>
        fs.existsSync(wire)
          ? fs
              .readFileSync(wire, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      try {
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const targetWorkspace = path.join(harness.profile.initialProjectsDirectory, "wait-target");
        const callerWorkspace = path.join(harness.profile.initialProjectsDirectory, "wait-caller");
        fs.mkdirSync(targetWorkspace, { recursive: true });
        fs.mkdirSync(callerWorkspace, { recursive: true });
        const target = await createAgentSmokeDraft(page, targetWorkspace, "Long wait target");
        targetSessionId = target.projectSessionId;
        await sendAgentPrompt(page, targetSessionId, TARGET_PROMPT);
        await model.waitForRequest((request) => request.hasUserInputText(TARGET_PROMPT));
        const caller = await createAgentSmokeDraft(page, callerWorkspace, "Long wait caller");
        await sendAgentPrompt(page, caller.projectSessionId, CALLER_PROMPT);
        await expect
          .poll(
            () =>
              frames().filter(
                (frame) => frame.type === "host.request" && frame.tool === "wait_sessions",
              ),
            { timeout: 30_000 },
          )
          .toHaveLength(1);
        const wait = frames().find(
          (frame) => frame.type === "host.request" && frame.tool === "wait_sessions",
        )!;
        await model.waitForRequest((request) => request.hasToolCallOutput("long_wait"));
        const began = performance.now();
        while (performance.now() - began < MINIMUM_WAIT_MS) {
          await page.waitForTimeout(
            Math.min(10_000, MINIMUM_WAIT_MS - (performance.now() - began)),
          );
          expect(
            frames().some(
              (frame) =>
                frame.id === wait.id && ["host.result", "host.cancel"].includes(frame.type),
            ),
          ).toBe(false);
        }
        measurements.monotonicWaitMs = Math.round(performance.now() - began);
        measurements.hostRequestId = wait.id;
        measurements.beforeCancel = frames().filter((frame) => frame.id === wait.id);
        const cancelledAt = Date.now();
        const callerState = (await invokeIpc(page, "agent-runtime:session:read", {
          sessionId: caller.projectSessionId,
        })) as AgentRuntimeConversation;
        const callerRunId = callerState.snapshot.projection.runs.at(-1)?.id;
        if (!callerRunId) throw new Error("Caller Run identity is unavailable");
        await invokeIpc(page, "agent-runtime:session:stop", {
          sessionId: caller.projectSessionId,
          runId: callerRunId,
        });
        await expect
          .poll(
            () => frames().filter((frame) => frame.type === "host.cancel" && frame.id === wait.id),
            { timeout: 15_000 },
          )
          .toHaveLength(1);
        measurements.cancelLatencyMs =
          frames().find((frame) => frame.type === "host.cancel" && frame.id === wait.id)!.at -
          cancelledAt;
        const targetState = (await invokeIpc(page, "agent-runtime:session:read", {
          sessionId: targetSessionId,
        })) as AgentRuntimeConversation;
        expect(targetState.snapshot.projection.runs.at(-1)?.status).toBe("running");
        measurements.targetRunStillActive = true;
        const cancelled = frames().find(
          (frame) => frame.type === "host.cancel" && frame.id === wait.id,
        )!;
        // The Main subscription normally renews after 20 seconds. Waiting through that
        // boundary proves Stop released it rather than only emitting a cancellation frame.
        await page.waitForTimeout(22_000);
        measurements.afterCancel = frames().filter((frame) => frame.at >= cancelledAt);
        const renewals = frames().filter(
          (frame) => frame.type === "execution.wait" && frame.at > cancelled.at,
        );
        measurements.executionWaitRenewalsAfterCancel = renewals.length;
        expect(renewals).toHaveLength(0);
        expect(frames().some((frame) => frame.type === "host.result" && frame.id === wait.id)).toBe(
          false,
        );
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await testInfo.attach("runtime.log", {
          body: await readBoundedElectronRuntimeLogs(harness.profile),
          contentType: "text/plain",
        });
        if (artifacts) {
          fs.writeFileSync(
            path.join(artifacts, "long-wait-result.json"),
            `${JSON.stringify({ status, fixture: "fresh isolated Electron Profile, pinned real Codex, deterministic loopback model, actual clocks", build, expected: { minimumWaitMs: MINIMUM_WAIT_MS, exactHostCancellation: true, targetRunStillActive: true, executionWaitRenewalsAfterCancel: 0 }, measurements, failure }, null, 2)}\n`,
          );
          if (fs.existsSync(wire))
            fs.copyFileSync(wire, path.join(artifacts, "long-wait-wire.jsonl"));
        }
        await harness.close();
      }
    },
  );
});
