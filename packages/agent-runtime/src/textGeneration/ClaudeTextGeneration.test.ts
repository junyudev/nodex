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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-result-" });
    const prompt = "Captured text that should never appear in an error.";
    const messages = [
      { type: "system", subtype: "init" },
      { type: "user", message: { role: "user", content: prompt } },
      { type: "result", result_index: 0, ...result },
    ];
    let binaryPath: string | undefined;
    if (transport === "SDK") {
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const stream = (async function* () {
          yield* messages;
        })();
        return Object.assign(stream, { close: () => {} }) as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
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
