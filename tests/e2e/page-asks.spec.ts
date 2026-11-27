import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscussionCommand } from "../../src/shared/discussions";
import { createInPlaceAskCommand, pageAskAgentFromConfig } from "../../src/shared/page-ask";
import { parsePageDetailResult } from "../../src/shared/page-detail";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { parsePageWork } from "../../src/shared/work-graph";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
  type ScriptedModelExchange,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  requireRecord,
  setAgentExecutionProfile,
} from "./support/agent-smoke-harness";
import { nativeAppToolCall } from "./support/native-app-tools";

test("Asks answer a Discussion without starting Page work", async () => {
  const pageId = createUuidV7();
  const inPlace = createUuidV7();
  const check = createUuidV7();
  const pending = `::pending{intent="Add the finding" discussion="${inPlace}"}`;
  const claim = "There were 42 reports.";
  const finding = "The June report counted 42 submissions.";
  const exchanges = (["insert", "check"] as const).map<ScriptedModelExchange>((kind) => {
    const callId = `page_ask_${kind}`;
    const discussionId = kind === "insert" ? inPlace : check;
    return {
      name: kind,
      match: (request) =>
        request.hasUserInputText(`ASK_FROM_PAGE_${kind}`) ||
        request.toolCallOutput(callId) !== null,
      expectedCalls: 2,
      maximumCalls: 2,
      respond(request, index) {
        if (index === 0) {
          expect(request.hasUserInputText("Ask from Page")).toBe(true);
          const tool = request.toolInvocation("functions", "exec");
          expect(tool).not.toBeNull();
          const script = [
            "const read=r=>{const data=typeof r==='string'?JSON.parse(r):r;if(data.isError)throw new Error(JSON.stringify(data));return data.structuredContent??(data.content?JSON.parse(data.content[0].text):data)};",
            ...(kind === "insert"
              ? [
                  `const page=read(await app.fetch({id:${JSON.stringify(pageId)},prepareFor:[{kind:"body"}]}));`,
                  `text(read(await app.update_page({pageId:${JSON.stringify(pageId)},body:{kind:"patch",ifMatch:page.data.content.etag,patches:[{oldMarkdown:${JSON.stringify(pending)},newMarkdown:${JSON.stringify(finding)}}]}})));`,
                ]
              : []),
            `text(read(await app.discussions_reply(${JSON.stringify({
              discussionId,
              comment:
                kind === "insert"
                  ? { body: finding }
                  : {
                      body: "The June report confirms 42 submissions.",
                      verdict: {
                        result: "true",
                        evidence: [{ title: "June report", url: `nodex://pages/${pageId}` }],
                      },
                    },
            })})));`,
          ].join("\n");
          return responses.stream([
            responses.created(callId),
            nativeAppToolCall(callId, tool!.name, script, tool!.namespace),
            responses.completed(callId),
          ]);
        }
        return responses.stream([
          responses.created(`${callId}_final`),
          responses.assistantMessage(
            `${callId}_message`,
            "I replied in the Discussion.",
            "final_answer",
          ),
          responses.completed(`${callId}_final`, true),
        ]);
      },
    };
  });

  await withScriptedModelServer({ exchanges }, async (model) => {
    const harness = await ElectronScenarioHarness.create({
      label: "page-asks",
      cwd: process.cwd(),
      prepareAgentRuntime: false,
      isolateHostDirectories: true,
      environment: {
        ...model.loopbackEnvironment(),
        OPENAI_API_KEY: "nodex-scripted-model-test-key",
        NODEX_LOG_FILE: "1",
        NODEX_LOG_CONSOLE: "0",
      },
    });
    let askSessionId: string | undefined;
    try {
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      const source = join(harness.profile.projectsDirectory, "ask-fixture");
      mkdirSync(source, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: source, encoding: "utf-8" }).trim();
      git("init", "--quiet", "--initial-branch=main", "--template=");
      git(
        "-c",
        "user.name=Ask fixture",
        "-c",
        "user.email=ask@nodex.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Fixture",
      );
      const initialWorktrees = git("worktree", "list", "--porcelain");
      const page = await harness.launch();
      const { projectId } = await createAgentSmokeDraft(page, source, "Ask fixture");
      const profile = await setAgentExecutionProfile(page);
      const seed = new RendererIpcSeedAdapter(page);
      await seed.createPage({
        key: "ask",
        pageId,
        projectId,
        operationId: createUuidV7(),
        title: "June review",
        status: "plan",
        markdown: `${pending}\n\n${claim}`,
      });
      const [pendingBlock, claimBlock] = await seed.readPageBlockTree(projectId, pageId);
      expect(pendingBlock?.type).toBe("pending");

      const readPageWork = async () => {
        const detail = parsePageDetailResult(
          await invokeIpc(page, "pages:detail:get", projectId, pageId),
        );
        if (!detail.ok || detail.value.dataSourceContext.kind !== "member") {
          throw new Error("Expected a Page in the Project's work database");
        }
        const workspace = requireRecord(
          await invokeIpc(page, "work:workspace", pageId),
          "Page workspace",
        );
        const work = parsePageWork(
          detail.value.intrinsicProperties.find((property) => property.key === "work")?.value,
        );
        return {
          status: detail.value.dataSourceContext.values.status?.value,
          assignee: work?.assignee ?? null,
          linkedChats: (await seed.readPageChats(pageId)).items.map((chat) => chat.sessionId),
          workspace: workspace.workspace ?? null,
        };
      };
      const initialPageWork = await readPageWork();
      expect(initialPageWork).toEqual({
        status: "plan",
        assignee: null,
        linkedChats: [],
        workspace: null,
      });

      const context = { kind: "project", projectId };
      const metadata = requireRecord(
        await invokeIpc(page, "library-module:read", context, { read: { mode: "metadata" } }),
        "Library metadata result",
      );
      const storeEpoch = requireRecord(metadata.value, "Library metadata").storeEpoch;
      const askAgent = pageAskAgentFromConfig({
        provider: "openai",
        model: profile.modelId,
        mode: "",
        reasoning: profile.reasoningEffort ?? "",
        speed: "",
      });
      const apply = async (command: DiscussionCommand) => {
        const result = await invokeIpc(page, "library-module:apply", context, {
          operationId: createUuidV7(),
          storeEpoch,
          operation: { kind: "discussion", command },
        });
        const receipt = requireRecord(result, "Discussion apply result");
        if (receipt.ok !== true)
          throw new Error(`Create Discussion: ${JSON.stringify(receipt.error)}`);
      };
      const read = (discussionId: string) =>
        invokeIpc(page, "library-module:read", context, {
          read: { mode: "discussion", discussionId },
        });
      await apply(
        createInPlaceAskCommand({
          pageId,
          discussionId: inPlace,
          pendingBlockId: pendingBlock!.id,
          request: "ASK_FROM_PAGE_insert Add the finding.",
          askAgent,
        }),
      );
      await expect
        .poll(async () => {
          const result = await read(inPlace);
          const item = result as {
            value?: {
              value?: { value?: { comments?: readonly { ask?: { sessionId?: string } }[] } };
            };
          };
          askSessionId = item.value?.value?.value?.comments?.[0]?.ask?.sessionId;
          return result;
        })
        .toMatchObject({
          ok: true,
          value: {
            value: {
              value: {
                comments: [
                  {
                    ask: {
                      state: "answered",
                      sessionId: expect.any(String),
                      runId: expect.any(String),
                    },
                  },
                  { author: { type: "agent" }, body: finding },
                ],
              },
            },
          },
        });
      const replacement = await seed.readPageBlockTree(projectId, pageId);
      expect(replacement.some((block) => block.type === "pending")).toBe(false);

      await apply({
        kind: "create",
        pageId,
        discussionId: check,
        quote: claim,
        anchor: { kind: "blocks", blockIds: [claimBlock!.id] },
        firstComment: {
          body: "ASK_FROM_PAGE_check Is this true?",
          toNodex: true,
          askKind: "check",
          askAgent,
        },
      });
      await expect
        .poll(() => read(check))
        .toMatchObject({
          ok: true,
          value: {
            value: {
              value: {
                comments: [{ ask: { state: "answered" } }, { verdict: { result: "true" } }],
              },
            },
          },
        });
      expect(await readPageWork()).toEqual(initialPageWork);
      expect(git("for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
      expect(git("worktree", "list", "--porcelain")).toBe(initialWorktrees);
    } catch (error) {
      const session = askSessionId
        ? await invokeIpc(harness.page, "project-sessions:get", askSessionId).catch(() => null)
        : null;
      const control = session
        ? await invokeIpc(harness.page, "agent-runtime:session:control", {
            sessionId: askSessionId,
          }).catch(() => null)
        : null;
      throw new Error(
        `${String(error)}
${JSON.stringify({ session, control }).slice(-12_000)}
${await readBoundedElectronRuntimeLogs(harness.profile)}`,
        { cause: error },
      );
    } finally {
      await harness.close();
    }
  });
});
