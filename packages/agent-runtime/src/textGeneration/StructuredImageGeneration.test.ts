import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { TextGenerationError } from "@t3tools/contracts";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as Application from "../nodex/Application.ts";
import { AgentRuntime } from "../nodex/Service.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const images = [
  { mediaType: "image/png", data: "AQID" },
  { mediaType: "image/jpeg", data: "BAUG" },
  { mediaType: "image/gif", data: "BwgJ" },
  { mediaType: "image/webp", data: "CgsM" },
] as const;
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};
const prompt = "Read the images in order and suggest a title.";

it.live("production Runtime sends Claude image blocks without ambient platform services", () =>
  Effect.gen(function* () {
    const messages: ClaudeSdk.SDKUserMessage[] = [];
    const close = vi.fn();
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      const stream = (async function* () {
        if (typeof input.prompt === "string") throw new Error("Images need a user message");
        for await (const message of input.prompt) messages.push(message);
        yield {
          type: "result",
          subtype: "success",
          structured_output: { title: "Image suggestion" },
        };
      })();
      return Object.assign(stream, {
        close: input.options?.outputFormat ? close : () => {},
      }) as unknown as ClaudeSdk.Query;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-structured-images-" });
    const binaryPath = writeFakeCli({
      directory: path.join(home, "bin"),
      name: "claude",
      source: "process.exit(0);",
    });
    const configuration = {
      home,
      cwd: home,
      providers: {
        claudeAgent: {
          driver: "claudeAgent",
          environment: [{ name: "NATIVE_TEST", value: "claude", sensitive: false }],
          config: { binaryPath, homePath: path.join(home, "claude-home") },
        },
      },
    };
    const context = yield* Layer.build(Application.layer(configuration, () => Effect.void));
    const runtime = Context.get(context, AgentRuntime);
    const input = {
      cwd: home,
      prompt,
      images,
      outputSchema,
      modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
    };
    assert.deepEqual(
      yield* runtime
        .handle({ id: "claude-images", method: "text.generate-structured", input })
        .pipe(Effect.setContext(Context.empty())),
      { title: "Image suggestion" },
    );
    assert.deepEqual(messages, [
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mediaType,
                data: image.data,
              },
            })),
          ],
        },
      },
    ]);
    const { $schema: _dialect, ...constraints } = outputSchema;
    const options = query.mock.calls
      .map(([request]) => request.options)
      .find((options) => options?.outputFormat?.type === "json_schema");
    assert.deepEqual(options?.outputFormat, { type: "json_schema", schema: constraints });
    assert.strictEqual(options?.persistSession, false);
    assert.strictEqual(options?.pathToClaudeCodeExecutable, binaryPath);
    assert.strictEqual(options?.env?.NATIVE_TEST, "claude");
    assert.strictEqual(close.mock.calls.length, 1);
    const error = yield* runtime
      .handle({
        id: "claude-budget",
        method: "text.generate-structured",
        input: { ...input, maxOutputBytes: 1 },
      })
      .pipe(Effect.setContext(Context.empty()), Effect.flip);
    assert.instanceOf(error, TextGenerationError);
    assert.include(error.message, "byte budget");
    assert.strictEqual(close.mock.calls.length, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
