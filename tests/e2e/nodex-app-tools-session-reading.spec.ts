import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  type ScriptedModelRequest,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  requireRecord,
  readRuntimeConversation,
  sendAgentFollowUp,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import { nativeAppToolCall, nativeCodeTool } from "./support/native-app-tools";

const INITIAL_PROMPT = "Create the older synthetic Session.";
const SEED_PROMPT = "Prepare the synthetic Session reading fixture.";
const CONTROL_PROMPT = "Keep this newer Session as the recency control.";
const REVIEW_PROMPT =
  "Read the synthetic history through native MCP and verify every continuation.";
const REVIEW_DONE = "Session history verification complete";
const INCREMENTAL_PROMPT = "Append the exact incremental Session fixture message.";
const INCREMENTAL_REPLY = "Incremental reply: 新消息完整到达 ✓";
const ATTACHMENT_NAME = "mcp-resource-proof.txt";
const ATTACHMENT_BYTES = new TextEncoder().encode("Authorized resource: 附件完整 ✓\n");
const FORWARD_PROMPT = "Verify the forwarded canonical Session attachment.";
const SELF_PROMPT = "Finish the queued self-send verification.";
const CHILD_PROMPT = "Produce the long canonical delegated result for Session acknowledgement.";
const CHILD_TITLE = "Long result acknowledgement";
const CHILD_REPLY = [
  "# Delegated canonical result",
  ...Array.from(
    { length: 900 },
    (_, index) => `Child ${String(index + 1).padStart(3, "0")}: ${"连续结果确认 🌿 ".repeat(2)}`,
  ),
  "END_CHILD_FINAL",
].join("\n");
const COMMAND_COUNT = 3;
const COMMAND_OUTPUT = "Native command output: 完整 ✓\n";
const LONG_REPLY = [
  "# Synthetic history",
  "Parity beacon.",
  ...Array.from(
    { length: 240 },
    (_, index) =>
      `Record ${String(index + 1).padStart(3, "0")}: ${"长对话完整续读 🌱 ".repeat(10)}`,
  ),
  "END_SYNTHETIC_HISTORY",
].join("\n");
const PATCH = [
  "*** Begin Patch",
  "*** Update File: example.ts",
  "@@",
  "-export const version = 1;",
  "+export const version = 2;",
  "+export const verified = true;",
  "*** End Patch",
].join("\n");

const compileNativeCell = (code: string) =>
  new Script(`(async () => {\n${code}\n})`, { filename: "session-mcp-native-cell.js" });

interface Claim {
  readonly name: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const toolOutputRecords = (output: unknown): Record<string, unknown>[] =>
  collectRecords(output).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });

/** Runs native operations so the fixture crosses the provider and persisted-history boundary. */
const seedResponse = (request: ScriptedModelRequest) => {
  const tool = nativeCodeTool(request);
  const code = [
    '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}',
    'text(await tools.update_plan({plan:[{step:"Verify complete Session history",status:"in_progress"}]}));',
    `text(await tools.apply_patch(${JSON.stringify(PATCH)}));`,
    `for (let index = 0; index < ${COMMAND_COUNT}; index++) {`,
    `const cmd = "printf '%s\\n' 'Native command output: 完整 ✓'; # native history record " + String(index + 1).padStart(3, "0") + " ${"x".repeat(260)}";`,
    "const result = await tools.exec_command({cmd,shell:'/bin/sh',login:false,yield_time_ms:10000,max_output_tokens:100});",
    "if (result.exit_code !== 0) throw new Error('Synthetic command failed');",
    "}",
    'text(await tools.update_plan({plan:[{step:"Verify complete Session history",status:"completed"}]}));',
  ].join("\n");
  return responses.stream([
    responses.created("seed_operations"),
    responses.customToolCall("seed_operations", tool.name, code, tool.namespace),
    responses.completed("seed_operations"),
  ]);
};

const visibleClaimReport = (claims: readonly Claim[]): string =>
  [
    `## ${REVIEW_DONE}`,
    "",
    ...claims.map((claim) => {
      const verdict =
        JSON.stringify(claim.actual) === JSON.stringify(claim.expected) ? "PASS" : "FAIL";
      return `- **${verdict}** · ${claim.name}`;
    }),
  ].join("\n");

test("reads a long Session exactly through native MCP without losing typed activity", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // Compile every generated native cell before paying for Electron/Profile setup.
  for (const code of [
    reviewScript("session", "project", "control", "draft", "file", "reviewer", "operation"),
    delegateChildScript("reviewer", "operation"),
    waitChildScript("reviewer", {}),
    partialChildScript("reviewer", {}),
    completeChildScript("reviewer", {}),
  ])
    compileNativeCell(code);
  const artifacts = process.env.NODEX_SESSION_READING_ARTIFACT_DIR;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
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
  const claims: Claim[] = [];
  let releaseChildResponse = () => {};
  const childResponseGate = new Promise<void>((resolve) => {
    releaseChildResponse = resolve;
  });
  const childReadReceipts: Array<{ stage: string; receipts: readonly Record<string, unknown>[] }> =
    [];
  let acknowledgementWire = "";
  let reviewerRunId = "";
  let childWaitResumeCount = 0;
  const childWaitOutput = (request: ScriptedModelRequest) =>
    request.toolCallOutput(
      childWaitResumeCount ? `wait_long_child_resume_${childWaitResumeCount}` : "wait_long_child",
    );
  let sessionId = "";
  let projectId = "";
  let controlSessionId = "";
  let attachmentDraftId = "";
  let reviewerSessionId = "";
  const attachmentFileId = createUuidV7();
  const retryOperationId = createBoundedOperationId("session-mcp-review");
  let recording: Page | null = null;
  let activePage: Page | null = null;
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  let measurements: Record<string, unknown> | null = null;
  const childCheckpoint = (output: unknown, stage: string) => {
    fs.writeFileSync(testInfo.outputPath(`${stage}.json`), JSON.stringify(output, null, 2));
    return requireRecord(
      toolOutputRecords(output).find((record) => record.stage === stage),
      stage,
    );
  };
  const childAcknowledgements = (checkpoint: Record<string, unknown>) =>
    (fs.existsSync(acknowledgementWire)
      ? fs.readFileSync(acknowledgementWire, "utf8").trim().split("\n").filter(Boolean)
      : []
    )
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => {
        const input = frame.input as Record<string, unknown> | undefined;
        return (
          frame.type === "history.acknowledge.result" &&
          frame.success === true &&
          input?.callerThreadId === checkpoint.parentThreadId &&
          input?.callerRunId === reviewerRunId &&
          input?.threadId === checkpoint.childThreadId
        );
      });
  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "finish the long delegated result through its real provider",
            match: (request) => request.hasUserInputText(CHILD_PROMPT),
            expectedCalls: 1,
            respond: async () => {
              await childResponseGate;
              return responses.stream([
                responses.created("long_child_answer"),
                responses.assistantMessage("long_child_answer", CHILD_REPLY, "final_answer"),
                responses.completed("long_child_answer", true),
              ]);
            },
          },
          {
            name: "finish the attachment-only draft started through MCP",
            match: (request) =>
              request.hasUserInputText(ATTACHMENT_NAME) &&
              !request.hasUserInputText(REVIEW_PROMPT) &&
              !request.hasUserInputText(FORWARD_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("attachment_draft_answer"),
              responses.assistantMessage(
                "attachment_draft_answer",
                "Authorized attachment received.",
                "final_answer",
              ),
              responses.completed("attachment_draft_answer", true),
            ]),
          },
          {
            name: "finish the forwarded Session attachment",
            match: (request) => request.hasUserInputText(FORWARD_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("forwarded_attachment_answer"),
              responses.assistantMessage(
                "forwarded_attachment_answer",
                "Forwarded attachment received.",
                "final_answer",
              ),
              responses.completed("forwarded_attachment_answer", true),
            ]),
          },
          {
            name: "finish the queued message to the calling Session",
            match: (request) => request.hasUserInputText(SELF_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("self_queue_answer"),
              responses.assistantMessage(
                "self_queue_answer",
                "Queued self-send completed exactly once.",
                "final_answer",
              ),
              responses.completed("self_queue_answer", true),
            ]),
          },
          {
            name: "establish the older Session",
            match: (request) => request.hasUserInputText(INITIAL_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("initial_answer"),
              responses.assistantMessage(
                "initial_answer",
                "Older synthetic Session is ready.",
                "final_answer",
              ),
              responses.completed("initial_answer", true),
            ]),
          },
          {
            name: "create native file, plan and command activity",
            match: (request) => request.hasUserInputText(SEED_PROMPT),
            expectedCalls: 1,
            respond: seedResponse,
          },
          {
            name: "persist the long multilingual assistant reply",
            match: (request) => request.hasToolCallOutput("seed_operations"),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("seed_answer"),
              responses.assistantMessage("seed_answer", LONG_REPLY, "final_answer"),
              responses.completed("seed_answer", true),
            ]),
          },
          {
            name: "finish the newer recency-control Session",
            match: (request) => request.hasUserInputText(CONTROL_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("control_answer"),
              responses.assistantMessage(
                "control_answer",
                "Parity beacons: the newer recency control is ready.",
                "final_answer",
              ),
              responses.completed("control_answer", true),
            ]),
          },
          {
            name: "append a new Run after a stable forward tail",
            match: (request) => request.hasUserInputText(INCREMENTAL_PROMPT),
            expectedCalls: 1,
            respond: responses.stream([
              responses.created("incremental_answer"),
              responses.assistantMessage("incremental_answer", INCREMENTAL_REPLY, "final_answer"),
              responses.completed("incremental_answer", true),
            ]),
          },
          {
            name: "read the full Session through the native application MCP",
            match: (request) => request.hasUserInputText(REVIEW_PROMPT),
            expectedCalls: 1,
            respond: (request) => {
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created("review_read"),
                nativeAppToolCall(
                  "review_read",
                  tool.name,
                  reviewScript(
                    sessionId,
                    projectId,
                    controlSessionId,
                    attachmentDraftId,
                    attachmentFileId,
                    reviewerSessionId,
                    retryOperationId,
                  ),
                  tool.namespace,
                ),
                responses.completed("review_read"),
              ]);
            },
          },
          {
            name: "report the machine-verified native MCP results",
            match: (request) => request.hasToolCallOutput("review_read"),
            expectedCalls: 1,
            respond: (request) => {
              const output = request.toolCallOutput("review_read");
              fs.writeFileSync(
                testInfo.outputPath("native-mcp-output.json"),
                JSON.stringify(output, null, 2),
              );
              const records = toolOutputRecords(output);
              const result = requireRecord(
                records.find((record) => Array.isArray(record.claims)),
                "Session reading evidence",
              );
              measurements = requireRecord(result.measurements, "Session reading measurements");
              claims.push(...(result.claims as Claim[]));
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created("delegate_long_child"),
                nativeAppToolCall(
                  "delegate_long_child",
                  tool.name,
                  delegateChildScript(reviewerSessionId, retryOperationId),
                  tool.namespace,
                ),
                responses.completed("delegate_long_child"),
              ]);
            },
          },
          {
            name: "release the child only after async delegation has returned without a result",
            match: (request) => request.hasToolCallOutput("delegate_long_child"),
            expectedCalls: 1,
            respond: async (request) => {
              const checkpoint = childCheckpoint(
                request.toolCallOutput("delegate_long_child"),
                "child-started",
              );
              releaseChildResponse();
              if (!activePage || typeof checkpoint.childThreadId !== "string")
                throw new Error("Missing delegated child execution");
              const parent = await readRuntimeConversation(activePage, {
                sessionId: reviewerSessionId,
                threadId: String(checkpoint.parentThreadId),
              });
              const callerRun = parent.snapshot.projection.runs.find(
                (run) => run.status === "running",
              );
              if (!callerRun) throw new Error("Delegated child's calling Run is unavailable");
              reviewerRunId = callerRun.id;
              await waitForRuntimeCompletedAgentTurn(
                activePage,
                { sessionId: reviewerSessionId, threadId: checkpoint.childThreadId },
                20_000,
              );
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created("wait_long_child"),
                nativeAppToolCall(
                  "wait_long_child",
                  tool.name,
                  waitChildScript(reviewerSessionId, checkpoint),
                  tool.namespace,
                ),
                responses.completed("wait_long_child"),
              ]);
            },
          },
          {
            name: "resume a yielded native child-wait cell",
            match: (request) => {
              const output = childWaitOutput(request);
              return /Script running with cell ID ([^\s]+)/.test(JSON.stringify(output));
            },
            expectedCalls: 0,
            maximumCalls: 3,
            respond: (request) => {
              const output = childWaitOutput(request);
              const cellId = /Script running with cell ID ([^\s\\]+)/.exec(
                JSON.stringify(output),
              )?.[1];
              const wait =
                request.toolInvocation("functions", "wait") ??
                (request.namedTool("wait") ? { name: "wait", namespace: undefined } : null);
              if (!cellId || !wait)
                throw new Error(`Missing native cell continuation: ${request.diagnosticSummary()}`);
              const callId = `wait_long_child_resume_${++childWaitResumeCount}`;
              return responses.stream([
                responses.created(callId),
                responses.functionCall(
                  callId,
                  wait.name,
                  { cell_id: cellId, yield_time_ms: 10000, max_tokens: 3000 },
                  wait.namespace,
                ),
                responses.completed(callId),
              ]);
            },
          },
          {
            name: "observe pending delivery before a partial Session read",
            match: (request) => childWaitOutput(request) !== null,
            expectedCalls: 1,
            respond: async (request) => {
              const checkpoint = childCheckpoint(childWaitOutput(request), "child-ready");
              const receipts = childAcknowledgements(checkpoint);
              childReadReceipts.push({ stage: "before-final-read", receipts });
              claims.push({
                name: "A completed delegated result has no read acknowledgement before reading",
                expected: { complete: true, acknowledgements: 0 },
                actual: {
                  complete: checkpoint.complete,
                  acknowledgements: receipts.length,
                },
              });
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created("read_partial_child"),
                nativeAppToolCall(
                  "read_partial_child",
                  tool.name,
                  partialChildScript(reviewerSessionId, checkpoint),
                  tool.namespace,
                ),
                responses.completed("read_partial_child"),
              ]);
            },
          },
          {
            name: "observe partial delivery and recover the exact child final through content cursors",
            match: (request) => request.hasToolCallOutput("read_partial_child"),
            expectedCalls: 1,
            respond: async (request) => {
              const checkpoint = childCheckpoint(
                request.toolCallOutput("read_partial_child"),
                "child-partial",
              );
              const receipts = childAcknowledgements(checkpoint);
              childReadReceipts.push({ stage: "after-partial-read", receipts });
              claims.push({
                name: "A partial child final read returns zero canonical acknowledgements",
                expected: {
                  characters: 200,
                  continued: true,
                  exact: true,
                  observed: true,
                  acknowledged: 0,
                },
                actual: {
                  characters: checkpoint.characters,
                  continued: Boolean(checkpoint.nextCursor),
                  exact: checkpoint.text === CHILD_REPLY.slice(0, 200),
                  observed: receipts.length === 1,
                  acknowledged: receipts.reduce(
                    (total, receipt) =>
                      total + Number((receipt.output as { acknowledged: number }).acknowledged),
                    0,
                  ),
                },
              });
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created("read_complete_child"),
                nativeAppToolCall(
                  "read_complete_child",
                  tool.name,
                  completeChildScript(reviewerSessionId, checkpoint),
                  tool.namespace,
                ),
                responses.completed("read_complete_child"),
              ]);
            },
          },
          {
            name: "report the complete child text and canonical delivery acknowledgement",
            match: (request) => request.hasToolCallOutput("read_complete_child"),
            expectedCalls: 1,
            respond: async (request) => {
              const checkpoint = childCheckpoint(
                request.toolCallOutput("read_complete_child"),
                "child-complete",
              );
              const receipts = childAcknowledgements(checkpoint);
              claims.push({
                name: "Session continuations recover a delegated final larger than one envelope",
                expected: {
                  exact: true,
                  utf8Bytes: Buffer.byteLength(CHILD_REPLY),
                  continued: true,
                  withinBudget: true,
                },
                actual: {
                  exact: checkpoint.exact,
                  utf8Bytes: checkpoint.utf8Bytes,
                  continued: Number(checkpoint.continuations) > 0,
                  withinBudget: Number(checkpoint.maxEnvelopeBytes) <= 24576,
                },
              });
              claims.push({
                name: "Complete continuous child reads acknowledge once for the exact parent Run and child",
                expected: {
                  completeResponses: Number(checkpoint.continuations) + 1,
                  acknowledged: 1,
                },
                actual: {
                  completeResponses: receipts.length,
                  acknowledged: receipts.reduce(
                    (total, receipt) =>
                      total + Number((receipt.output as { acknowledged: number }).acknowledged),
                    0,
                  ),
                },
              });
              childReadReceipts.push({
                stage: "after-complete-read",
                receipts,
              });
              if (measurements) {
                measurements.childRead = checkpoint;
                measurements.childReadReceipts = childReadReceipts;
              }
              return responses.stream([
                responses.created("review_answer"),
                responses.assistantMessage(
                  "review_answer",
                  visibleClaimReport(claims),
                  "final_answer",
                ),
                responses.completed("review_answer", true),
              ]);
            },
          },
        ],
      },
      async (model) => {
        const faultLog = testInfo.outputPath("source-fault.jsonl");
        acknowledgementWire = testInfo.outputPath("reading-wire.jsonl");
        const launcher = testInfo.outputPath("source-fault-node");
        fs.mkdirSync(testInfo.outputDir, { recursive: true });
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        fs.writeFileSync(
          launcher,
          `#!/bin/sh\nexport NODEX_TEST_SESSION_MCP_SOURCE_FAULT_LOG=${quote(faultLog)}\nexport NODEX_TEST_SESSION_MCP_WIRE_LOG=${quote(acknowledgementWire)}\nexec ${quote(process.execPath)} --require ${quote(path.resolve("tests/e2e/fixtures/session-mcp-wire-observer.cjs"))} --require ${quote(path.resolve("tests/e2e/fixtures/session-mcp-source-fault.cjs"))} "$@"\n`,
          { mode: 0o755 },
        );
        const harness = await ElectronScenarioHarness.create({
          label: "session-mcp-reading",
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
        const workspace = path.join(harness.profile.initialProjectsDirectory, "session-reading");
        const controlWorkspace = path.join(
          harness.profile.initialProjectsDirectory,
          "recency-control",
        );
        const reviewerWorkspace = path.join(
          harness.profile.initialProjectsDirectory,
          "history-review",
        );
        const attachmentWorkspace = path.join(
          harness.profile.initialProjectsDirectory,
          "attachment-intake",
        );
        for (const directory of [
          workspace,
          controlWorkspace,
          reviewerWorkspace,
          attachmentWorkspace,
        ])
          fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(workspace, "example.ts"), "export const version = 1;\n");
        try {
          const page = await harness.launch();
          activePage = page;
          await page.setViewportSize({ width: 1440, height: 960 });
          await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
          const draft = await createAgentSmokeDraft(page, workspace, "Synthetic Session history");
          sessionId = draft.projectSessionId;
          projectId = draft.projectId;
          const threadId = await sendAgentPrompt(page, sessionId, INITIAL_PROMPT);
          await waitForRuntimeCompletedAgentTurn(page, { sessionId, threadId });
          const control = await createAgentSmokeDraft(page, controlWorkspace, "Recency control");
          controlSessionId = control.projectSessionId;
          const controlThreadId = await sendAgentPrompt(page, controlSessionId, CONTROL_PROMPT);
          await waitForRuntimeCompletedAgentTurn(page, {
            sessionId: controlSessionId,
            threadId: controlThreadId,
          });
          await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
          await sendAgentFollowUp(page, SEED_PROMPT);
          await waitForRuntimeCompletedAgentTurn(page, { sessionId, threadId }, 120_000);
          const resourceDraft = await createAgentSmokeDraft(
            page,
            attachmentWorkspace,
            "Attachment intake draft",
          );
          attachmentDraftId = resourceDraft.projectSessionId;
          await new RendererIpcSeedAdapter(page).createLibraryFile({
            operationId: createUuidV7(),
            projectId,
            fileId: attachmentFileId,
            defaultName: ATTACHMENT_NAME,
            mimeType: "text/plain",
            bytes: ATTACHMENT_BYTES,
          });
          const reviewer = await createAgentSmokeDraft(
            page,
            reviewerWorkspace,
            "MCP history review",
          );
          reviewerSessionId = reviewer.projectSessionId;
          if (artifacts) {
            await page.screencast.start({
              path: path.join(artifacts, "review.webm"),
              size: { width: 1440, height: 960 },
              annotate: { position: "bottom", fontSize: 14 },
            });
            recording = page;
          }
          const reviewThreadId = await sendAgentPrompt(
            page,
            reviewer.projectSessionId,
            REVIEW_PROMPT,
          );
          await waitForFinalMarker(page, REVIEW_DONE, 120_000);
          await waitForRuntimeCompletedAgentTurn(
            page,
            { sessionId: reviewer.projectSessionId, threadId: reviewThreadId },
            120_000,
          );
          expect(claims).toHaveLength(37);
          const injected = fs
            .readFileSync(faultLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(injected).toHaveLength(1);
          for (const claim of claims) expect(claim.actual, claim.name).toEqual(claim.expected);
          if (artifacts) {
            fs.copyFileSync(faultLog, path.join(artifacts, "source-fault.jsonl"));
            fs.copyFileSync(acknowledgementWire, path.join(artifacts, "reading-wire.jsonl"));
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(artifacts, "final.png") });
            await page.waitForTimeout(1_200);
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          await testInfo.attach("runtime.log", {
            body: await readBoundedElectronRuntimeLogs(harness.profile),
            contentType: "text/plain",
          });
          if (artifacts && activePage)
            await activePage
              .screenshot({ path: path.join(artifacts, "failure.png") })
              .catch(() => undefined);
          throw error;
        } finally {
          releaseChildResponse();
          try {
            if (recording) await recording.screencast.stop();
          } finally {
            await harness.close();
          }
        }
      },
    );
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    releaseChildResponse();
    if (artifacts) writeEvidence(artifacts, { status, claims, measurements, failure, build });
  }
});

/** Publish a passing evidence pack only after native shutdown and model verification succeed. */
const writeEvidence = (
  artifacts: string,
  result: {
    readonly status: "passed" | "failed";
    readonly claims: readonly Claim[];
    readonly measurements: Record<string, unknown> | null;
    readonly failure: string | null;
    readonly build: {
      readonly source: unknown;
      readonly mainSha256: string;
      readonly runtimeSha256: string;
    };
  },
): void => {
  fs.writeFileSync(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ ...result, fixture: "fresh isolated Electron Profile; pinned Codex with deterministic loopback model", commandCount: COMMAND_COUNT, reply: { characters: LONG_REPLY.length, utf8Bytes: Buffer.byteLength(LONG_REPLY), sha256: createHash("sha256").update(LONG_REPLY).digest("hex") }, childReply: { characters: CHILD_REPLY.length, utf8Bytes: Buffer.byteLength(CHILD_REPLY), sha256: createHash("sha256").update(CHILD_REPLY).digest("hex") } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(artifacts, "README.md"),
    `# Session history review\n\nStatus: **${result.status}**\n\nThe fixture crosses the real Codex provider, persisted Agent Runtime history, and native application MCP. It creates ${COMMAND_COUNT} command records, a file patch, a plan, and a ${Buffer.byteLength(LONG_REPLY)}-byte multilingual reply. The recording starts after setup and follows an Agent reading the history through bounded pages and exact text continuations. The compact report contains only machine-verified claims.\n\n- review.webm: native recording.\n- final.png: settled report in Nodex.\n- result.json: exact expected and actual values for every visible claim.\n\nRun: \`NODEX_SESSION_READING_ARTIFACT_DIR=<absolute-directory> vp run test:e2e tests/e2e/nodex-app-tools-session-reading.spec.ts\`\n\nNo production Profile or user content was accessed.\n${result.failure ? `\nFailure: ${result.failure}\n` : ""}`,
  );
};

const reviewScript = (
  sessionId: string,
  projectId: string,
  controlSessionId: string,
  attachmentDraftId: string,
  attachmentFileId: string,
  reviewerSessionId: string,
  retryOperationId: string,
): string =>
  [
    '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 4000}',
    `const sessionId = ${JSON.stringify(sessionId)};`,
    `const projectId = ${JSON.stringify(projectId)};`,
    `const controlSessionId = ${JSON.stringify(controlSessionId)};`,
    `const attachmentDraftId = ${JSON.stringify(attachmentDraftId)};`,
    `const attachmentFileId = ${JSON.stringify(attachmentFileId)};`,
    `const reviewerSessionId = ${JSON.stringify(reviewerSessionId)};`,
    `const retryOperationId = ${JSON.stringify(retryOperationId)};`,
    `const expectedReply = ${JSON.stringify(LONG_REPLY)};`,
    `const expectedCommandOutput = ${JSON.stringify(COMMAND_OUTPUT)};`,
    "const claims = [];",
    "const claim = (name, expected, actual) => claims.push({name, expected, actual});",
    "const bytes = text => [...text].reduce((size, char) => size + (char.codePointAt(0) <= 127 ? 1 : char.codePointAt(0) <= 2047 ? 2 : char.codePointAt(0) <= 65535 ? 3 : 4), 0);",
    "let maxReadBytes = 0;",
    "const call = async (name, args, allowError = false) => {",
    "const output = await app[name](args); const raw = typeof output === 'string' ? JSON.parse(output) : output;",
    "if (name === 'read_session') maxReadBytes = Math.max(maxReadBytes, bytes(JSON.stringify(raw)));",
    "if (raw.isError && !allowError) throw new Error(JSON.stringify(raw));",
    "return {raw, value: raw.structuredContent ?? JSON.parse(raw.content[0].text)};",
    "};",
    "let textContinuations = 0; let jsonContinuations = 0; let pageCount = 0;",
    "const readPage = async args => (await call('read_session', {sessionId,...args})).value.history;",
    "const recover = async (entry, maxCharsPerItem, selectedSessionId = sessionId) => {",
    "let content = entry.content; if (content.format === 'json') return content.value;",
    "const format = content.format; let text = content.text; const cursors = new Set();",
    "while (content.nextCursor) {",
    "if (cursors.has(content.nextCursor)) throw new Error('Item cursor repeated'); cursors.add(content.nextCursor);",
    "const next = await readPage({sessionId:selectedSessionId,cursor:content.nextCursor,maxCharsPerItem});",
    "if (next.availability !== 'available' || next.items.length !== 1 || next.items[0].id !== entry.id) throw new Error('Continuation changed item identity');",
    "content = next.items[0].content; if (content.offset !== text.length || content.format !== format) throw new Error('Continuation skipped or repeated text');",
    "text += content.text; if (format === 'text') textContinuations++; else jsonContinuations++;",
    "if (cursors.size > 200) throw new Error('Item continuation did not terminate');",
    "}",
    "if (text.length !== content.totalChars) throw new Error('Item content is incomplete');",
    "return format === 'json_fragment' ? JSON.parse(text) : text;",
    "};",
    "const walk = async (view, maxCharsPerItem) => {",
    "const entries = []; const cursors = new Set(); let cursor;",
    "for (let page = 0; page < 100; page++) {",
    "const history = await readPage({...(view ? {view} : {}),limit:2,maxCharsPerItem,...(cursor ? {cursor} : {})});",
    "if (history.availability !== 'available') throw new Error('Synthetic history is unavailable');",
    "entries.push(...history.items); pageCount++; cursor = history.page.nextCursor; if (!cursor) return entries;",
    "if (cursors.has(cursor)) throw new Error('History page cursor repeated'); cursors.add(cursor);",
    "}",
    "throw new Error('History pages did not terminate');",
    "};",
    "const messages = await walk(undefined, 8000); const messageTexts = [];",
    "for (const entry of messages) messageTexts.push(await recover(entry, 8000));",
    "const reply = messageTexts.find(text => typeof text === 'string' && text.startsWith('# Synthetic history'));",
    "claim('Long multilingual text is recovered exactly through continuations', {exact:true,characters:expectedReply.length}, {exact:reply === expectedReply,characters:reply?.length ?? 0});",
    `const expectedOrder = ['long assistant reply', ${JSON.stringify(SEED_PROMPT)}, 'Older synthetic Session is ready.', ${JSON.stringify(INITIAL_PROMPT)}];`,
    "const messageOrder = messages.flatMap((entry,index) => ['user_message','assistant_message'].includes(entry.type) ? [messageTexts[index] === expectedReply ? 'long assistant reply' : messageTexts[index]] : []);",
    "claim('Pages recover every message once in newest-first order', {order:expectedOrder,unique:true,textContinued:true,multiplePages:true}, {order:messageOrder,unique:new Set(messages.map(item => item.sourceThreadId + ':' + item.id)).size === messages.length,textContinued:textContinuations > 0,multiplePages:pageCount > 1});",
    "const activity = await walk('activity', 512); const typed = [];",
    "for (const entry of activity) { if (['user_message','assistant_message','reasoning'].includes(entry.type)) continue; const value = await recover(entry, 512); if (value?.source === 'runtime') typed.push(value.item); }",
    "const changes = typed.flatMap(item => item.type === 'file_change' ? item.changes ?? [] : []);",
    "const changed = changes.find(change => change.path.endsWith('example.ts'));",
    "const changedLines = changed?.diff?.split('\\n').filter(line => /^[+-](?![+-])/.test(line));",
    "claim('File activity retains the path, counts and every changed line', {path:'example.ts',additions:2,deletions:1,lines:['-export const version = 1;','+export const version = 2;','+export const verified = true;']}, {path:changed?.path.split('/').at(-1),additions:changed?.additions,deletions:changed?.deletions,lines:changedLines});",
    "claim('Plan activity preserves its completed checklist', true, typed.some(item => item.type === 'todo_list' && item.steps.some(step => step.text === 'Verify complete Session history' && step.status === 'completed')));",
    "const commands = typed.filter(item => item.type === 'command_execution');",
    `claim('Every native command retains its input, exit status and lazy output', {indices:['001','002','003'],uniqueItems:${COMMAND_COUNT},complete:${COMMAND_COUNT}}, {indices:commands.map(item => /native history record ([0-9]{3})/.exec(item.input)?.[1]).sort(),uniqueItems:new Set(commands.map(item => item.id)).size,complete:commands.filter(item => item.exitCode === 0 && item.output === expectedCommandOutput).length});`,
    "claim('Typed JSON fragments recover without losing structure', true, jsonContinuations > 0);",
    "const tiny = await readPage({view:'activity',limit:1,maxCharsPerItem:1}); const tinyItem = tiny.items[0];",
    "const normalItem = activity.find(item => item.id === tinyItem.id && item.sourceThreadId === tinyItem.sourceThreadId); const identity = item => item && [item.id,item.sourceThreadId,item.runId,item.type,item.status];",
    "claim('Tiny content budgets preserve the complete identity and status', {identityUnchanged:true,sliceChars:1,continued:true}, {identityUnchanged:Boolean(normalItem) && JSON.stringify(identity(tinyItem)) === JSON.stringify(identity(normalItem)),sliceChars:tinyItem?.content?.text?.length,continued:Boolean(tinyItem?.content?.nextCursor)});",
    "const listing = []; const listCursors = new Set(); let listCursor;",
    "for (let page = 0; page < 30; page++) {",
    "const {value} = await call('list_sessions', {scope:'profile',limit:1, ...(listCursor ? {cursor:listCursor} : {})});",
    "listing.push(...value.sessions); listCursor = value.nextCursor; if (!listCursor) break;",
    "if (listCursors.has(listCursor)) throw new Error('Discovery cursor repeated'); listCursors.add(listCursor);",
    "}",
    "const recovered = listing.find(item => item.sessionId === sessionId);",
    "claim('Recent activity orders an older Session before the newer control', true, listing.findIndex(item => item.sessionId === sessionId) >= 0 && listing.findIndex(item => item.sessionId === sessionId) < listing.findIndex(item => item.sessionId === controlSessionId));",
    "claim('Discovery supplies a bounded conversation preview', true, typeof recovered?.preview === 'string' && recovered.preview.length > 0);",
    `const searched = (await call('list_sessions', {query:${JSON.stringify(INITIAL_PROMPT)},projectId,limit:10})).value;`,
    "claim('Project and keyword filters select the intended Session', [sessionId], searched.sessions.map(item => item.sessionId));",
    "const waited = await call('wait_sessions', {targets:[{sessionId}],timeoutMs:0}); const target = waited.value.targets[0];",
    "claim('Waiting on a long completed turn returns compact progress', true, target?.disposition === 'complete' && !Object.hasOwn(target, 'history') && target.progress?.latestMessage?.content.totalChars === expectedReply.length && Boolean(target.progress?.latestMessage?.content.nextCursor) && Boolean(target.progress?.latestTool?.id) && bytes(JSON.stringify(waited.raw)) <= 32768);",
    "let bodyHit; let searchCursor; for (let page = 0; page < 50; page++) { const found = (await call('search_sessions', {query:'Record 173:',projectId,limit:10,...(searchCursor ? {cursor:searchCursor} : {})})).value; bodyHit = found.matches.find(match => match.session.sessionId === sessionId && match.source === 'assistant'); searchCursor = found.nextCursor; if (bodyHit || !searchCursor) break; }",
    "claim('Historical assistant-only text is searchable with exact source and snippet', {found:true,source:'assistant',snippet:true}, {found:Boolean(bodyHit),source:bodyHit?.source,snippet:bodyHit?.snippet?.includes('Record 173:') ?? false});",
    "const exactHit = await readPage({itemId:bodyHit.itemId,sourceThreadId:bodyHit.sourceThreadId,maxCharsPerItem:8000}); const exactEntry=exactHit.items[0]; const exactText=await recover(exactEntry,8000); claim('A search locator reads the exact full matched message', {id:bodyHit.itemId,exact:true}, {id:exactEntry.id,exact:exactText === expectedReply});",
    "const offset = expectedReply.indexOf('Record 173:'); const offsetHit = await readPage({itemId:bodyHit.itemId,sourceThreadId:bodyHit.sourceThreadId,textOffset:offset,maxCharsPerItem:137}); claim('Exact search reads accept a UTF-16 offset without scanning prior pages', {offset,text:expectedReply.slice(offset,offset+137)}, {offset:offsetHit.items[0].content.offset,text:offsetHit.items[0].content.text});",
    "const ownScope = (await call('search_sessions',{query:'Parity beacon',limit:10})).value; claim('Search defaults to the calling Project instead of leaking other Projects', [], ownScope.matches.map(match=>match.session.sessionId));",
    "await call('set_session_title',{sessionId,title:'Synthetic Session'}); let faultCursor;let unavailable=false;let healthyTitle=false;let sourceRecovered=false;for(let page=0;page<50;page++){const found=(await call('search_sessions',{scope:'profile',query:'Synthetic Session',limit:10,...(faultCursor?{cursor:faultCursor}:{})})).value;unavailable ||= found.sources.some(source=>source.availability==='unavailable');healthyTitle ||= found.matches.some(match=>match.source==='title' && match.session.sessionId===sessionId);faultCursor=found.nextCursor;if(!faultCursor){sourceRecovered=found.coverage==='complete' && found.state==='ready';break;}} claim('A failed Runtime search source preserves healthy metadata and recovers through its continuation',{unavailable:true,healthyTitle:true,recovered:true},{unavailable,healthyTitle,recovered:sourceRecovered});",
    "let tokenHit; let tokenCursor; for (let page = 0; page < 50; page++) { const found = (await call('search_sessions', {query:'173: Record',projectId,limit:10,...(tokenCursor ? {cursor:tokenCursor} : {})})).value; tokenHit = found.matches.find(match => match.session.sessionId === sessionId && match.source === 'assistant'); tokenCursor = found.nextCursor; if (tokenHit || !tokenCursor) break; }",
    "claim('Search matches all words regardless of their order and centers the snippet', {sameItem:true,snippet:true}, {sameItem:Boolean(bodyHit?.itemId) && tokenHit?.itemId === bodyHit.itemId,snippet:tokenHit?.snippet?.includes('Record 173:') ?? false});",
    "const searchAll = async args => { const matches = []; let cursor; const cursors = new Set(); for (let page = 0; page < 100; page++) { const result = (await call('search_sessions', {...args,limit:1,...(cursor ? {cursor} : {})})).value; matches.push(...result.matches); cursor = result.nextCursor; if (!cursor) return matches; if (cursors.has(cursor)) throw new Error('Search cursor repeated'); cursors.add(cursor); } throw new Error('Search did not terminate'); };",
    "const ranked = await searchAll({scope:'profile',query:'Parity beacon'}); claim('Global body relevance puts an older whole-word match ahead of a newer prefix', [sessionId,controlSessionId], ranked.map(match => match.session.sessionId));",
    "await call('set_session_title', {sessionId,title:'Synthetic Session'}); const distinct = await searchAll({query:'synthetic Session',projectId}); claim('A metadata and body match occupies exactly one slot across all pages', [{sessionId,source:'title'}], distinct.map(match => ({sessionId:match.session.sessionId,source:match.source})));",
    "const details = (await call('read_session', {sessionId,limit:1000,runLimit:1000,maxCharsPerItem:100000})).value;",
    "claim('Read exposes execution provenance and counted recent Runs with normalized limits', {source:'runtime',creator:'user',runs:2,limit:50}, {source:details.execution?.source,creator:details.execution?.metadata?.createdBy,runs:details.execution?.runCount,limit:details.history.page.limit});",
    "const priorRunId = details.execution.recentRuns.at(-1).runId;",
    "const pinned = (await call('wait_sessions', {targets:[{sessionId,runId:priorRunId}],timeoutMs:0})).value.targets[0];",
    "claim('An explicit older Run keeps its own completion and reply', {selected:true,resolved:true,text:'Older synthetic Session is ready.'}, {selected:pinned.selectedRunId === priorRunId,resolved:pinned.runId === priorRunId,text:pinned.progress?.latestMessage?.content.text});",
    "const ascending = []; let forwardCursor; let tailCursor;",
    "for (let page = 0; page < 100; page++) { const history = await readPage({order:'oldest_first',limit:2,maxCharsPerItem:1,...(forwardCursor ? {cursor:forwardCursor} : {})}); ascending.push(...history.items); tailCursor = history.page.tailCursor; forwardCursor = history.page.nextCursor; if (!forwardCursor) break; }",
    "claim('Stable ascending pages cover exactly the same item identities', messages.map(item => item.id).toReversed(), ascending.map(item => item.id));",
    "const emptyTail = await readPage({cursor:tailCursor,limit:20});",
    "claim('A settled forward tail does not repeat old messages', 0, emptyTail.items.length);",
    `const sent = (await call('send_message_to_session', {sessionId,prompt:${JSON.stringify(INCREMENTAL_PROMPT)}})).value;`,
    "const appendedWait = (await call('wait_sessions', {targets:[{sessionId,runId:sent.runId}],timeoutMs:10000})).value.targets[0];",
    "const appended = await readPage({cursor:tailCursor,limit:20,maxCharsPerItem:8000});",
    `claim('The same tail receives only newly appended messages', [${JSON.stringify(INCREMENTAL_PROMPT)},${JSON.stringify(INCREMENTAL_REPLY)}], appended.items.filter(item => ['user_message','assistant_message'].includes(item.type)).map(item => item.content.text));`,
    "const forwarded = appended.items.find(item => item.type === 'user_message'); claim('Agent-sent user-role messages retain their actual author and entry source', {author:'agent',source:'mcp',messageId:true}, {author:forwarded?.createdBy,source:forwarded?.creationSource,messageId:forwarded?.messageId === sent.messageId});",
    "claim('Send returns an exact Run identity that wait resolves', true, typeof sent.runId === 'string' && appendedWait?.selectedRunId === sent.runId && appendedWait?.runId === sent.runId && appendedWait?.disposition === 'complete');",
    "const draftSent=(await call('send_message_to_session',{sessionId:attachmentDraftId,attachments:[{type:'library_file',fileId:attachmentFileId}]})).value; const draftWait=(await call('wait_sessions',{targets:[{sessionId:attachmentDraftId,runId:draftSent.runId}],timeoutMs:10000})).value.targets[0]; claim('An attachment-only draft starts in place and exposes its exact Run', {sessionId:attachmentDraftId,delivery:'started',complete:true}, {sessionId:draftSent.sessionId,delivery:draftSent.deliveryState,complete:typeof draftSent.runId === 'string' && draftWait.disposition === 'complete'});",
    "const draftHistory=await readPage({sessionId:attachmentDraftId,view:'activity',limit:20,maxCharsPerItem:8000}); const resourceEntry=draftHistory.items.find(item=>item.type==='user_message'); const resourceMessage=(await recover(resourceEntry,8000,attachmentDraftId)).item; const resource=resourceMessage.attachments[0];",
    `claim('The authorized Library File becomes a durable canonical message attachment', {text:'',name:${JSON.stringify(ATTACHMENT_NAME)},mimeType:'text/plain',sizeBytes:${ATTACHMENT_BYTES.byteLength}}, {text:resourceMessage.text,name:resource.name,mimeType:resource.mimeType,sizeBytes:resource.sizeBytes});`,
    `const forwardArgs={sessionId,prompt:${JSON.stringify(FORWARD_PROMPT)},operationId:retryOperationId,attachments:[{type:'session_attachment',sessionId:attachmentDraftId,sourceThreadId:resourceEntry.sourceThreadId,itemId:resourceEntry.id,attachmentId:resource.id}]}; const forwardedSend=(await call('send_message_to_session',forwardArgs)).value; const replayedSend=(await call('send_message_to_session',forwardArgs)).value; await call('wait_sessions',{targets:[{sessionId,runId:forwardedSend.runId}],timeoutMs:10000});`,
    "const forwardHistory=await readPage({view:'activity',limit:20,maxCharsPerItem:8000}); const forwardedEntries=forwardHistory.items.filter(item=>item.type==='user_message' && item.messageId===forwardedSend.messageId); const forwardedMessage=(await recover(forwardedEntries[0],8000)).item; claim('Session attachment references forward through their resource owner with correct author', {author:'agent',name:resource.name,sizeBytes:resource.sizeBytes}, {author:forwardedEntries[0].createdBy,name:forwardedMessage.attachments[0].name,sizeBytes:forwardedMessage.attachments[0].sizeBytes});",
    "claim('Retrying an identical attachment send creates exactly one canonical message and Run', {sameMessage:true,sameRun:true,count:1}, {sameMessage:replayedSend.messageId===forwardedSend.messageId,sameRun:replayedSend.runId===forwardedSend.runId,count:forwardedEntries.length});",
    `const selfArgs={sessionId:reviewerSessionId,prompt:${JSON.stringify(SELF_PROMPT)},mode:'queue',operationId:retryOperationId.replace('session-mcp-review','session-mcp-self')}; const selfSent=(await call('send_message_to_session',selfArgs)).value; const selfRetry=(await call('send_message_to_session',selfArgs)).value; claim('The calling Session can queue a message with stable retry and exact execution identity', {delivery:'queued',message:true,run:true}, {delivery:selfSent.deliveryState,message:typeof selfSent.messageId==='string' && selfSent.messageId===selfRetry.messageId,run:typeof selfSent.runId==='string' && selfSent.runId===selfRetry.runId});`,
    "const invalid = await call('read_session', {sessionId,cursor:'invalid-cursor'}, true);",
    "claim('Invalid history cursors have an actionable error', 'session_invalid_cursor', invalid.value.error?.code);",
    "claim('Every history envelope stays inside the unchanged 24 KiB budget', true, maxReadBytes <= 24576);",
    "text({claims,measurements:{maxReadBytes,textContinuations,jsonContinuations,pageCount,commands:commands.map(item => ({id:item.id,exitCode:item.exitCode,output:item.output,outputOmitted:item.outputOmitted}))}});",
  ].join("\n");

const taskScriptPrelude = [
  '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 3000}',
  "let maximumReadBytes=0; const call = async (name, args) => { const output = await app[name](args); const raw = typeof output === 'string' ? JSON.parse(output) : output; if(name==='read_session') maximumReadBytes=Math.max(maximumReadBytes,bytes(JSON.stringify(raw))); if(raw.isError) throw new Error(JSON.stringify(raw)); return raw.structuredContent ?? JSON.parse(raw.content[0].text); };",
  "const bytes = text => [...text].reduce((size, char) => size + (char.codePointAt(0) <= 127 ? 1 : char.codePointAt(0) <= 2047 ? 2 : char.codePointAt(0) <= 65535 ? 3 : 4), 0);",
];

const delegateChildScript = (sessionId: string, operationId: string) =>
  [
    ...taskScriptPrelude,
    `const sessionId=${JSON.stringify(sessionId)};`,
    `const delegated=await call('delegate_task',{task:${JSON.stringify(CHILD_PROMPT)},title:${JSON.stringify(CHILD_TITLE)},mode:'async',clientRequestId:${JSON.stringify(operationId + ":long-child")}});`,
    "const listed=await call('list_sessions',{includeSubagents:true,limit:50}); const children=listed.sessions.filter(item=>item.sessionId===sessionId && item.relationshipToParent==='subagent' && item.execution); if(children.length!==1) throw new Error('Expected one canonical delegated child: '+JSON.stringify(children)); const child=children[0];",
    "text({stage:'child-started',taskId:delegated.taskId,parentThreadId:child.parentThreadId,childThreadId:child.execution.threadId,runId:child.latestRunId});",
  ].join("\n");

const waitChildScript = (sessionId: string, checkpoint: Record<string, unknown>) =>
  [
    ...taskScriptPrelude,
    `const sessionId=${JSON.stringify(sessionId)}; const checkpoint=${JSON.stringify(checkpoint)};`,
    "const waited=(await call('wait_sessions',{targets:[{sessionId,execution:{threadId:checkpoint.childThreadId},...(checkpoint.runId?{runId:checkpoint.runId}:{})}],timeoutMs:10000})).targets[0]; const item=waited.progress?.latestMessage; if(!item || waited.disposition!=='complete') throw new Error('Delegated final did not settle: '+JSON.stringify(waited));",
    "text({...checkpoint,stage:'child-ready',runId:waited.runId,finalItemId:item.id,sourceThreadId:item.sourceThreadId,complete:waited.disposition==='complete'});",
  ].join("\n");

const partialChildScript = (sessionId: string, checkpoint: Record<string, unknown>) =>
  [
    ...taskScriptPrelude,
    `const checkpoint=${JSON.stringify(checkpoint)};`,
    `const found=await call('read_session',{sessionId:${JSON.stringify(sessionId)},execution:{threadId:checkpoint.childThreadId},itemId:checkpoint.finalItemId,sourceThreadId:checkpoint.sourceThreadId,maxCharsPerItem:200}); const item=found.history.items[0]; if(!item || item.id!==checkpoint.finalItemId || item.content.format!=='text' || item.content.offset!==0) throw new Error('Invalid partial delegated final: '+JSON.stringify(item));`,
    "text({...checkpoint,stage:'child-partial',text:item.content.text,characters:item.content.text.length,nextCursor:item.content.nextCursor,totalChars:item.content.totalChars,maxEnvelopeBytes:maximumReadBytes});",
  ].join("\n");

const completeChildScript = (sessionId: string, checkpoint: Record<string, unknown>) =>
  [
    ...taskScriptPrelude,
    `const checkpoint=${JSON.stringify(checkpoint)}; const expected=${JSON.stringify(CHILD_REPLY)};`,
    "let recovered=checkpoint.text; let cursor=checkpoint.nextCursor; let continuations=0; let maxEnvelopeBytes=checkpoint.maxEnvelopeBytes;",
    `while(cursor && continuations<100){const output=await app.read_session({sessionId:${JSON.stringify(sessionId)},execution:{threadId:checkpoint.childThreadId},cursor,maxCharsPerItem:2000});const raw=typeof output==='string'?JSON.parse(output):output;if(raw.isError)throw new Error(JSON.stringify(raw));const found=raw.structuredContent??JSON.parse(raw.content[0].text);const item=found.history.items[0];if(!item || item.id!==checkpoint.finalItemId || item.sourceThreadId!==checkpoint.sourceThreadId || item.content.format!=='text' || item.content.offset!==recovered.length)throw new Error('Delegated final continuation lost identity/offset');recovered+=item.content.text;cursor=item.content.nextCursor;continuations++;maxEnvelopeBytes=Math.max(maxEnvelopeBytes,bytes(JSON.stringify(raw)));}`,
    "if(cursor)throw new Error('Delegated final did not finish within its fixture bound'); text({stage:'child-complete',taskId:checkpoint.taskId,parentThreadId:checkpoint.parentThreadId,childThreadId:checkpoint.childThreadId,runId:checkpoint.runId,finalItemId:checkpoint.finalItemId,exact:recovered===expected,utf8Bytes:bytes(recovered),characters:recovered.length,continuations,maxEnvelopeBytes});",
  ].join("\n");
