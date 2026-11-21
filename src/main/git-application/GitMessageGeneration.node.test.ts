import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../shared/agent-runtime-settings";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { GitMessageGeneration } from "./GitMessageGeneration";

type Generate = AgentRuntimeApplication["Service"]["generateStructured"];
const writingModel = { instanceId: "claude", model: "haiku" };
const workspace = { cwd: "/workspace", chatThreadId: "chat-thread" };
const evidence = { changes: "+const limit = 5;", recentSubjects: ["fix: cap retries"] };

const provide = (generateStructured: Generate) =>
  GitMessageGeneration.live.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(AgentRuntimeApplication, {
          generateStructured,
        } as AgentRuntimeApplication["Service"]),
        Layer.succeed(ApplicationSettings, {
          snapshot: () =>
            Effect.succeed({
              agentRuntime: { ...DEFAULT_AGENT_RUNTIME_SETTINGS, writingModel },
              git: {
                commitInstructions: "Use Conventional Commits.",
                pullRequestInstructions: "Use Markdown.",
              },
            }),
        } as unknown as ApplicationSettings["Service"]),
      ),
    ),
  );

it.effect("routes both drafts through Agent Runtime with the Profile and chat context", () => {
  const calls: Parameters<Generate>[0][] = [];
  const live = provide((input) =>
    Effect.sync(() => {
      calls.push(input);
      return "gitDraft" in input && input.gitDraft.kind === "commit"
        ? { subject: "fix: cap retries", body: "Keep failures bounded." }
        : { title: "Cap retries", body: "Keep failures bounded." };
    }),
  );
  return Effect.gen(function* () {
    const service = yield* GitMessageGeneration;
    const commit = { ...evidence, draftMessage: "" };
    const pr = { ...evidence, title: "", body: "", headBranch: "fix-retries", baseBranch: "main" };
    assert.equal(
      yield* service.generateCommitMessage(workspace, commit),
      "fix: cap retries\n\nKeep failures bounded.",
    );
    assert.deepEqual(yield* service.generatePullRequestMessage(workspace, pr), {
      title: "Cap retries",
      body: "Keep failures bounded.",
    });
    assert.deepEqual(calls, [
      {
        ...workspace,
        writingModel,
        gitDraft: { ...commit, kind: "commit", instructions: "Use Conventional Commits." },
      },
      {
        ...workspace,
        writingModel,
        gitDraft: { ...pr, kind: "pull-request", instructions: "Use Markdown." },
      },
    ]);
  }).pipe(Effect.provide(live));
});

it.effect("preserves the Runtime's no-Agent failure for Git draft callers", () =>
  Effect.gen(function* () {
    const service = yield* GitMessageGeneration;
    const error = yield* service
      .generateCommitMessage(workspace, { ...evidence, draftMessage: "" })
      .pipe(Effect.flip);
    assert.equal(error.code, "no_writing_agent");
  }).pipe(
    Effect.provide(
      provide(() =>
        Effect.fail(
          new AgentRuntimeApplicationError({
            operation: "structured-generation",
            message: "Agent operation could not be completed",
            cause: new AgentRuntimeProcessError({
              code: "no_writing_agent",
              reason: "rejected",
              message: "No Agent available to write this.",
            }),
          }),
        ),
      ),
    ),
  ),
);
