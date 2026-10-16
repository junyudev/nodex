import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap, type SourceMapPayload } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vite-plus/test";
import { nodeBuildOptimizationArguments, type NodeBuildMode } from "./node-build-optimization";

test("shrinks shipped Node code without losing reflective names or original error locations", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-node-optimization-"));
  const source = join(root, "diagnostic.ts");
  const esbuild = createRequire(import.meta.url).resolve("esbuild/bin/esbuild");
  writeFileSync(
    source,
    [
      "export class RuntimeFailure extends Error {}",
      "export function diagnoseRuntime(runtimeDescription: string, operationDescription: string) {",
      "  const normalizedRuntimeDescription = runtimeDescription.trim().toLowerCase();",
      "  const normalizedOperationDescription = operationDescription.trim().toLowerCase();",
      "  const diagnosticMessage = normalizedRuntimeDescription + ': ' + normalizedOperationDescription;",
      "  throw new RuntimeFailure(diagnosticMessage);",
      "}",
    ].join("\n"),
  );
  try {
    const build = (mode: NodeBuildMode) => {
      const output = join(root, mode, "diagnostic.mjs");
      execFileSync(esbuild, [
        source,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node24",
        `--outfile=${output}`,
        "--log-level=error",
        ...nodeBuildOptimizationArguments(mode),
      ]);
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import { diagnoseRuntime } from ${JSON.stringify(pathToFileURL(output).href)};
             try { diagnoseRuntime("Agent Runtime", "Startup"); }
             catch (error) {
               process.stdout.write(JSON.stringify({
                 functionName: diagnoseRuntime.name,
                 errorName: error.constructor.name,
                 message: error.message,
                 stack: error.stack,
               }));
             }`,
          ],
          { encoding: "utf8" },
        ),
      ) as { functionName: string; errorName: string; message: string; stack: string };
      expect(result).toMatchObject({
        functionName: "diagnoseRuntime",
        errorName: "RuntimeFailure",
        message: "agent runtime: startup",
      });
      return { output, result, bytes: readFileSync(output).byteLength };
    };
    const development = build("development");
    const production = build("production");
    expect(production.bytes).toBeLessThan(development.bytes);
    const frame = production.result.stack
      .split("\n")
      .find((line) => line.includes("diagnoseRuntime"));
    const coordinates = frame?.match(/:(\d+):(\d+)\)?$/u);
    if (!coordinates) throw new Error(`Missing generated stack location: ${frame}`);
    const sourceMap = new SourceMap(
      JSON.parse(readFileSync(`${production.output}.map`, "utf8")) as SourceMapPayload,
    );
    const original = sourceMap.findEntry(Number(coordinates[1]) - 1, Number(coordinates[2]) - 1);
    if (!("originalSource" in original)) throw new Error("Missing original error location");
    expect(original.originalSource).toMatch(/diagnostic\.ts$/u);
    expect(original.originalLine).toBe(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
