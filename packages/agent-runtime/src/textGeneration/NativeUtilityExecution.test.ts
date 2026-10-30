import { CodexSettings, ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeFS from "node:fs";
import * as Application from "../nodex/Application.ts";
import { AgentRuntime } from "../nodex/Service.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";

// A native CLI peer checks its executable policy before accepting the task and its output schema.
const cliPeer = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const codex = args[0] === "exec";
const required = codex ? "--dangerously-bypass-approvals-and-sandbox" : "--dangerously-skip-permissions";
if (!args.includes(required) || ["--allowedTools", "--disallowedTools", "--tools"].some(flag => args.includes(flag))) {
  process.stderr.write("Native utility was launched with a restricted execution policy");
  process.exit(7);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const schema = JSON.parse(codex ? fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8") : args[args.indexOf("--json-schema") + 1]);
  if (!codex && schema.$schema) {
    process.stderr.write("Error: --json-schema is not a valid JSON Schema: no schema with key or ref " + schema.$schema);
    process.exit(1);
  }
  const investigation = !!schema.properties.stops;
  if (investigation && !prompt.includes("git diff")) throw new Error("Investigation task context was lost");
  const result = investigation ? { stops: [] } : { title: "Inspect exact native execution" };
  const ephemeral = args.includes(codex ? "--ephemeral" : "--no-session-persistence");
  fs.appendFileSync(path.join(process.env.NATIVE_UTILITY_PROOF_DIR, "accepted.jsonl"), JSON.stringify({ investigation, ephemeral, cwd: process.cwd() }) + "\\n");
  if (codex) fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(result));
  else process.stdout.write(JSON.stringify({ structured_output: result }));
});
`;

for (const driver of ["codex", "claude"] as const) {
  it.effect(
    `${driver} utility tasks use automatic full access while retaining task context and structured output`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-utility-policy-" });
        const scriptPath = path.join(directory, "native-peer.cjs");
        yield* fs.writeFileString(scriptPath, cliPeer);
        const binaryPath =
          process.platform === "win32" ? path.join(directory, "native-peer.cmd") : scriptPath;
        if (process.platform === "win32")
          yield* fs.writeFileString(
            binaryPath,
            `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
          );
        else yield* fs.chmod(binaryPath, 0o700);
        const environment = { ...process.env, NATIVE_UTILITY_PROOF_DIR: directory };
        const generation =
          driver === "codex"
            ? yield* makeCodexTextGeneration(
                Schema.decodeSync(CodexSettings)({ enabled: true, binaryPath }),
                environment,
              )
            : yield* makeClaudeTextGeneration(
                Schema.decodeSync(ClaudeSettings)({ enabled: true, binaryPath }),
                environment,
              );
        const modelSelection = {
          instanceId: ProviderInstanceId.make(driver),
          model: driver === "codex" ? "codex" : "sonnet",
        };
        const title = yield* generation.generateThreadTitle({
          cwd: directory,
          message: "Inspect exact native execution",
          modelSelection,
        });
        assert.deepEqual(title, { title: "Inspect exact native execution" });
        const guide = yield* generation.generateReviewGuide({
          cwd: directory,
          number: 42,
          title: "Correct native execution",
          description: "Preserve exact source",
          baseBranch: "main",
          baseCommit: "base",
          settledReview: "",
          modelSelection,
        });
        assert.deepEqual(guide, { stops: [] });
        // Callers may declare a dialect, as Nodex's chat title schema does.
        const outputSchema = {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        };
        const structured = yield* generation.generateStructured!({
          cwd: directory,
          prompt: "Generate a title",
          images: [],
          modelSelection,
          outputSchema,
          maxOutputBytes: 1024,
        });
        assert.deepEqual(structured, { title: "Inspect exact native execution" });
        const oversized = yield* generation.generateStructured!({
          cwd: directory,
          prompt: "Generate a title",
          modelSelection,
          outputSchema,
          maxOutputBytes: 1,
        }).pipe(Effect.result);
        assert.equal(oversized._tag, "Failure");
        const accepted = (yield* fs.readFileString(path.join(directory, "accepted.jsonl")))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { investigation: boolean; ephemeral: boolean; cwd: string },
          );
        assert.deepEqual(
          accepted.map((row) => row.investigation),
          [false, true, false, false],
        );
        // Utility tasks never leave a conversation in the user's native history.
        assert.isTrue(accepted.every((row) => row.ephemeral));
        assert.strictEqual(accepted[1]?.cwd, yield* fs.realPath(directory));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "nodex-utility-runtime-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
}

const promptImages = [
  { mediaType: "image/png", data: "AAECA/8=" },
  { mediaType: "image/jpeg", data: "BAUGBw==" },
  { mediaType: "image/gif", data: "CAkKCw==" },
  { mediaType: "image/webp", data: "DA0ODw==" },
] as const;
const imageOutputSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};
const imageProof = Schema.Struct({
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
  images: Schema.Array(Schema.Struct({ path: Schema.String, data: Schema.String })),
});
const decodeImageProof = Schema.decodeSync(Schema.fromJsonString(imageProof));

it.live.each(["success", "failure", "output-budget", "interruption"] as const)(
  "production Runtime sends exact image bytes and cleans temporary files after %s",
  (behavior) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-utility-images-" });
      const proofPath = path.join(home, "image-proof.json");
      const peerReady = yield* Deferred.make<void>();
      if (behavior === "interruption")
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.watch(home, (_event, fileName) => {
              if (fileName?.toString() === "image-proof.json")
                Deferred.doneUnsafe(peerReady, Effect.void);
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );
      const binaryPath = writeFakeCli({
        directory: path.join(home, "bin"),
        name: "codex",
        source: `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "exec") process.exit(0);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const images = args.flatMap((arg, index) => arg === "--image" ? [args[index + 1]] : []);
fs.writeFileSync(${JSON.stringify(proofPath + ".tmp")}, JSON.stringify({
  args, prompt, images: images.map(path => ({ path, data: fs.readFileSync(path).toString("base64") })),
}));
fs.renameSync(${JSON.stringify(proofPath + ".tmp")}, ${JSON.stringify(proofPath)});
const behavior = ${JSON.stringify(behavior)};
if (behavior === "failure") process.exit(23);
if (behavior === "interruption") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ title: "Image suggestion" }));
`,
      });
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        // Invocation has only the runtime's captured services, as in the Desktop Host.
        const execution = runtime
          .handle({
            id: "image-suggestion",
            method: "text.generate-structured",
            input: {
              cwd: home,
              prompt: "Read these images in order",
              images: promptImages,
              modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
              outputSchema: imageOutputSchema,
              ...(behavior === "output-budget" ? { maxOutputBytes: 1 } : {}),
            },
          })
          .pipe(Effect.setContext(Context.empty()));
        if (behavior === "interruption") {
          const running = yield* Effect.forkChild(execution);
          yield* Deferred.await(peerReady).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(running);
          return;
        }
        if (behavior !== "success") {
          const error = yield* execution.pipe(Effect.flip);
          assert.instanceOf(error, Error);
          assert.include(error.message, behavior === "failure" ? "code 23" : "byte budget");
          return;
        }
        assert.deepEqual(yield* execution, { title: "Image suggestion" });
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                codex: {
                  driver: "codex",
                  config: {
                    binaryPath,
                    homePath: path.join(home, "codex-home"),
                    setupMode: "existing",
                  },
                },
              },
            },
            () => Effect.void,
          ),
        ),
      );
      const proof = decodeImageProof(yield* fs.readFileString(proofPath));
      assert.strictEqual(proof.args[0], "exec");
      assert.strictEqual(proof.prompt, "Read these images in order");
      assert.deepEqual(
        proof.images.map(({ data }) => data),
        promptImages.map(({ data }) => data),
      );
      assert.deepEqual(
        proof.images.map(({ path: file }) => path.extname(file)),
        [".png", ".jpg", ".gif", ".webp"],
      );
      const temporaryPaths = [
        proof.args[proof.args.indexOf("--output-schema") + 1]!,
        proof.args[proof.args.indexOf("--output-last-message") + 1]!,
        ...proof.images.map(({ path }) => path),
      ];
      for (const file of temporaryPaths) assert.isFalse(yield* fs.exists(path.dirname(file)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
