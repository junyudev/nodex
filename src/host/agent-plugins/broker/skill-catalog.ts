import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { packageRelativePath } from "../../../shared/agent-plugins/validation";
import type { PackageFiles } from "../PackageFiles";
import { packageFilesNode } from "../PackageFilesNode";
import { PluginMcpFailure, type PluginMcpInstallation } from "./contract";

export type SkillCatalogSource = readonly (readonly [string, PluginMcpInstallation])[];

const pageSize = 25;
const maxTextBytes = 64 * 1024;
const maxFilePaths = 100;
const maxPathLength = 512;

const boundedPath = Schema.String.check(Schema.isMaxLength(maxPathLength));
const listInput = Schema.Struct({
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const readInput = Schema.Struct({
  pluginId: boundedPath,
  skill: boundedPath,
  file: Schema.optionalKey(boundedPath),
});

const tools: readonly Tool[] = [
  {
    name: "list_plugin_skills",
    description: "List enabled plugin skills in this Project. Use nextOffset to continue.",
    inputSchema: {
      type: "object",
      properties: { offset: { type: "integer", minimum: 0 } },
    },
  },
  {
    name: "read_plugin_skill",
    description:
      "Read a listed skill and its supporting file paths, or read one supporting text file.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string", maxLength: maxPathLength },
        skill: { type: "string", maxLength: maxPathLength },
        file: { type: "string", maxLength: maxPathLength },
      },
      required: ["pluginId", "skill"],
    },
  },
];

function result(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError && { isError }) };
}

function supportingFiles(files: PackageFiles, directory: string) {
  const paths: string[] = [];
  let remaining = 1_000;
  const visit = (relative: string, ancestors: ReadonlySet<string>) => {
    if (--remaining < 0 || paths.length >= maxFilePaths || relative.length > maxPathLength) return;
    if (relative !== "" && packageRelativePath(relative) !== relative) return;
    const entry = files.inspect(directory + (relative ? "/" + relative : ""));
    if (entry.kind === "file") {
      if (relative !== "SKILL.md" && entry.size <= maxTextBytes) paths.push(relative);
      return;
    }
    if (entry.kind !== "directory" || ancestors.has(entry.path)) return;
    const next = new Set(ancestors).add(entry.path);
    for (const child of files.children(entry.path)) {
      if (remaining <= 0 || paths.length >= maxFilePaths) break;
      visit(relative ? relative + "/" + child : child, next);
    }
  };
  visit("", new Set());
  return { files: paths, filesTruncated: remaining <= 0 || paths.length === maxFilePaths };
}

export function skillCatalog(source: SkillCatalogSource) {
  const read = Effect.fnUntraced(
    function* (args: Record<string, unknown>) {
      const input = Schema.decodeUnknownOption(readInput)(args);
      if (input._tag === "None") return result({ error: "Invalid skill selection." }, true);
      const { pluginId, skill, file } = input.value;
      const relative = file === undefined ? "SKILL.md" : packageRelativePath(file);
      if (!relative || relative === ".")
        return result({ error: "Invalid supporting file path." }, true);
      const installation = source.find(([id]) => id === pluginId)?.[1];
      const directory = installation?.skills?.find(
        (entry) => entry.valid && entry.directory === skill,
      )?.directory;
      if (!installation || !directory || packageRelativePath(directory) !== directory)
        return result({ error: "Skill unavailable." }, true);

      const files = yield* packageFilesNode.open(installation.packageRoot);
      const entry = files.inspect(directory + "/" + relative);
      if (entry.kind !== "file" || entry.size > maxTextBytes)
        return result({ error: "File unavailable or larger than 64 KiB." }, true);
      const bytes = yield* files.read(entry.path);
      const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (text.includes("\0")) return result({ error: "File is not text." }, true);
      return result({
        text,
        ...(file === undefined ? supportingFiles(files, directory) : {}),
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.succeed(result({ error: "Could not read the installed skill." }, true)),
        ),
      ),
  );

  return {
    listTools: Effect.succeed(tools),
    callTool: (name: string, args: Record<string, unknown>) => {
      if (name === "read_plugin_skill") return read(args);
      if (name !== "list_plugin_skills") return Effect.fail(new PluginMcpFailure("unknown_tool"));
      return Effect.sync(() => {
        const input = Schema.decodeUnknownOption(listInput)(args);
        if (input._tag === "None") return result({ error: "Invalid catalog offset." }, true);
        const offset = input.value.offset ?? 0;
        const entries = source.flatMap(([pluginId, installation]) =>
          (installation.skills ?? [])
            .filter((skill) => skill.valid && skill.directory.length <= maxPathLength)
            .map(({ directory, name, description }) => ({
              pluginId,
              skill: directory,
              name: name.slice(0, 128),
              description: description.slice(0, 256),
              generation: installation.generation,
            })),
        );
        const end = offset + pageSize;
        return result({
          skills: entries.slice(offset, end),
          nextOffset: end < entries.length ? end : null,
        });
      });
    },
  };
}
