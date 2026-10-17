import { CodexSettings, ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
