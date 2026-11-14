import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, TextGenerationError } from "@nodex/runtime-contracts";
import { writeFakeCli } from "@nodex/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const output = { title: "A suggestion" };
const success = { subtype: "success", is_error: false };
const modelError =
  "There's an issue with the selected model. It may not exist or you may not have access to it.";
const apiFailure = {
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 404,
  result: modelError,
};

const generateFrom = (
  transport: "CLI" | "SDK",
  result: Record<string, unknown>,
  cli?: { readonly exitCode: number; readonly stderr?: string },
  models: { init: string; response: string } = {
    init: "claude-sonnet-5-5",
    response: "claude-sonnet-5-5",
  },
  offered: ClaudeSdk.SDKUserMessage[] = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-result-" });
    const prompt = "Captured text that should never appear in an error.";
    const messages = [
      { type: "system", subtype: "init", model: models.init },
      { type: "user", message: { role: "user", content: prompt } },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { model: models.response },
      },
      { type: "result", ...result },
    ];
    let binaryPath: string | undefined;
    if (transport === "SDK") {
      let drain: Promise<void> | undefined;
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        drain = (async () => {
          if (typeof prompt === "string") throw new Error("Expected streaming input");
          for await (const message of prompt) offered.push(message);
        })();
        const stream = (async function* () {
          yield* messages;
        })();
        return Object.assign(stream, {
          close: () => {},
          getSettings: async () => ({ applied: { model: models.init } }),
        }) as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          query.mockRestore();
          await drain;
        }),
      );
    } else {
      binaryPath = writeFakeCli({
        directory: cwd,
        name: "claude",
        source: `
for await (const _ of process.stdin) {}
process.stdout.write(${JSON.stringify(JSON.stringify(messages))});
process.stderr.write(${JSON.stringify(cli?.stderr ?? "")});
process.exitCode = ${cli?.exitCode ?? 0};
`,
      });
    }
    const generation = yield* makeClaudeTextGeneration(
      Schema.decodeSync(ClaudeSettings)({ enabled: true, binaryPath }),
    );
    return yield* generation.generateStructured({
      cwd,
      prompt,
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
      images: transport === "SDK" ? [{ mediaType: "image/png", data: "AQID" }] : [],
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
  }).pipe(Effect.provide(NodeServices.layer));

it.live.each(["CLI", "SDK"] as const)(
  "%s returns structured output from a healthy result",
  (transport) =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* generateFrom(transport, { ...success, structured_output: output }),
        output,
      );
    }),
);

it.live("SDK never offers the prompt when Claude starts on a different model", () =>
  Effect.gen(function* () {
    const offered: ClaudeSdk.SDKUserMessage[] = [];
    const error = yield* generateFrom(
      "SDK",
      { ...success, structured_output: output },
      undefined,
      { init: "claude-haiku-5-5", response: "claude-haiku-5-5" },
      offered,
    ).pipe(Effect.scoped, Effect.flip);
    assert.instanceOf(error, TextGenerationError);
    if (!(error instanceof TextGenerationError)) return;
    assert.include(error.detail, "Claude Haiku 5.5");
    assert.isEmpty(offered);
  }),
);

it.live.each(["CLI", "SDK"] as const)(
  "%s rejects structured output generated on a substituted model",
  (transport) =>
    Effect.gen(function* () {
      const error = yield* generateFrom(
        transport,
        { ...success, structured_output: output },
        undefined,
        {
          init: "claude-sonnet-5-5",
          response: "claude-haiku-5-5",
        },
      ).pipe(Effect.flip);
      assert.instanceOf(error, TextGenerationError);
      if (!(error instanceof TextGenerationError)) return;
      assert.strictEqual(
        error.detail,
        "Claude Code used Claude Haiku 5.5 for a request on Claude Sonnet 5.5.",
      );
    }),
);

const failures = [
  { name: "API error with a success subtype", result: apiFailure, detail: modelError },
  {
    name: "API rate limit with an HTTP status",
    result: { ...apiFailure, result: "You've hit your limit.", api_error_status: 429 },
    detail: "You've hit your limit. (HTTP 429)",
  },
  {
    name: "non-success subtype",
    result: {
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Claude could not finish.", "Please retry."],
    },
    detail: "Claude could not finish.\nPlease retry.",
  },
  {
    name: "success without structured output",
    result: { ...success, result: "Unstructured assistant text." },
    detail: "Claude finished without a structured answer.",
  },
];

for (const transport of ["CLI", "SDK"] as const) {
  it.live.each(failures)(
    `${transport} surfaces $name as a generation failure`,
    ({ result, detail }) =>
      Effect.gen(function* () {
        const error = yield* generateFrom(transport, result).pipe(Effect.flip);
        assert.instanceOf(error, TextGenerationError);
        assert.strictEqual(error.detail, detail);
      }),
  );
}

it.live("CLI prefers the result reason to stderr on a non-zero exit", () =>
  Effect.gen(function* () {
    const error = yield* generateFrom("CLI", apiFailure, {
      exitCode: 1,
      stderr: "An error occurred during execution.",
    }).pipe(Effect.flip);
    assert.instanceOf(error, TextGenerationError);
    assert.strictEqual(error.detail, modelError);
  }),
);

it.live("CLI fails a non-zero exit without exposing the stdout transcript", () =>
  Effect.gen(function* () {
    const error = yield* generateFrom(
      "CLI",
      { ...success, structured_output: output },
      {
        exitCode: 1,
      },
    ).pipe(Effect.flip);
    assert.instanceOf(error, TextGenerationError);
    assert.strictEqual(error.detail, "Claude CLI command failed with code 1.");
  }),
);
