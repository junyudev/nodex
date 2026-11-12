import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostCliShell } from "@nodex/provider-core/server/ExecutionHost";

import { fromLenientJson } from "@nodex/runtime-shared/schemaJson";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { NODEX_APP_MCP_SERVER } from "@nodex/runtime-shared/nodexAppMcp";

const shellRouting = `import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
const route = async (id) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id ?? "")) return;
  try {
    return JSON.parse(await readFile(join(process.env.NODEX_OPENCODE_CLI_ROUTING, id), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};
const markAgentShell = (env) => {
  env.NODEX_AGENT_SHELL = "1";
  if (process.env.NODEX_AGENT_PROFILE_HOME)
    env.NODEX_AGENT_PROFILE_HOME = process.env.NODEX_AGENT_PROFILE_HOME;
};
const bind = (env, binding) => {
  if (binding.profileHome) env.NODEX_AGENT_PROFILE_HOME = binding.profileHome;
  env.NODEX_CLI_TASK_ID = binding.taskId;
  env.PATH = [binding.bin, env.PATH ?? process.env.PATH].filter(Boolean).join(delimiter);
};
`;

/** Register only a provider-observed Session, in its local server's private directory. */
export const shellRouter = (fs: FileSystem.FileSystem, directory: string) => (
  sessionId: string,
  binding: HostCliShell | undefined,
) => Effect.gen(function* () {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) return false;
  const file = `${directory}/${sessionId}`;
  if (!binding) {
    yield* fs.remove(file, { force: true });
    return false;
  }
  const temp = yield* fs.makeTempFile({ directory, prefix: `.${sessionId}-` });
  yield* fs.writeFileString(temp, JSON.stringify(binding), { mode: 0o600 }).pipe(
    Effect.andThen(fs.rename(temp, file)),
    Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
  );
  return true;
});

export type ShellRouter = ReturnType<typeof shellRouter>;

export const cliInstruction = (binding: HostCliShell | undefined) =>
  binding
    ? `Run nodex for content work. Use set_page_properties for batched Property edits through the Nodex tools. Read the bundled Skill at ${JSON.stringify(binding.skill)}.`
    : undefined;

/** OpenCode 2's shell tool calls Shell.create for each command, including background jobs. */
export const source = `${shellRouting}
import { randomUUID } from "node:crypto";
const marker = "# nodex-shell:";
export default {
  id: "nodex-native-execution",
  async setup({ tool, shell }) {
    const pending = new Map();
    await shell.hook("create.before", async (event) => {
      markAgentShell(event.env);
      if (!event.command.startsWith(marker)) return;
      const end = event.command.indexOf("\\n");
      const key = event.command.slice(marker.length, end);
      const binding = pending.get(key);
      pending.delete(key);
      if (!binding) throw new Error("The Nodex shell binding is unavailable.");
      bind(event.env, binding);
      event.command = event.command.slice(end + 1);
    });
    await tool.hook("execute.before", async (event) => {
      if ((event.tool === "shell" || event.tool === "bash") && typeof event.input?.command === "string") {
        const binding = await route(event.sessionID);
        if (binding) {
          const key = randomUUID();
          if (pending.size >= 256) pending.delete(pending.keys().next().value);
          pending.set(key, binding);
          event.input = { ...event.input, command: marker + key + "\\n" + event.input.command };
        }
      }
      if (!event.tool.startsWith(${JSON.stringify(`${NODEX_APP_MCP_SERVER}-`)})) return;
      event.input = {
        ...(event.input ?? {}),
        __nodexNativeExecution: {
          nativeThreadId: event.sessionID,
          nativeTurnId: event.messageID,
          nativeCallId: event.id,
        },
      };
    });
  },
};
`;

/** OpenCode 1 publishes each tool's immutable message context before its before-tool hook. */
export const sourceV1 = `${shellRouting}
export default async function () {
  const calls = new Map();
  const waiting = new Map();
  const keyOf = (sessionID, callID) => JSON.stringify([sessionID, callID]);
  const owns = (tool) => tool.startsWith(${JSON.stringify(`${NODEX_APP_MCP_SERVER}_`)});
  return {
    async "shell.env"(input, output) {
      markAgentShell(output.env);
      const binding = await route(input.sessionID);
      if (binding) bind(output.env, binding);
    },
    event({ event }) {
      if (event.type !== "message.part.updated") return;
      const part = event.properties.part;
      if (part.type !== "tool" || !owns(part.tool)) return;
      const key = keyOf(part.sessionID, part.callID);
      if (part.state.status === "completed" || part.state.status === "error") {
        if (calls.get(key)?.nativeTurnId === part.messageID) calls.delete(key);
        return;
      }
      if (!calls.has(key) && calls.size >= 4096) return;
      const source = { nativeThreadId: part.sessionID, nativeTurnId: part.messageID, nativeCallId: part.callID };
      calls.set(key, source);
      waiting.get(key)?.(source);
    },
    async "tool.execute.before"(input, output) {
      if (!owns(input.tool)) return;
      const key = keyOf(input.sessionID, input.callID);
      const source = calls.get(key) ?? await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting.delete(key);
          reject(new Error("Native tool call context did not arrive."));
        }, 3000);
        waiting.set(key, (source) => {
          clearTimeout(timeout);
          waiting.delete(key);
          resolve(source);
        });
      });
      output.args.__nodexNativeExecution = source;
    },
    "tool.execute.after"(input) {
      if (owns(input.tool)) calls.delete(keyOf(input.sessionID, input.callID));
    },
  };
}
`;

export const skillPaths = (pluginRoots: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  pluginRoots?.map((root) => join(root, "skills")) ?? [];

function skillConfig(
  skills: unknown,
  generation: "v1" | "v2",
  paths: ReadonlyArray<string>,
): { readonly skills?: unknown } {
  if (paths.length === 0) return {};
  if (generation === "v2") {
    return { skills: [...new Set([...(Array.isArray(skills) ? skills : []), ...paths])] };
  }
  const previous = Predicate.isObject(skills) ? skills : {};
  const existing = "paths" in previous && Array.isArray(previous.paths) ? previous.paths : [];
  return { skills: { ...previous, paths: [...new Set([...existing, ...paths])] } };
}

/** Adds process-scoped v2 skills to the inline config produced by `environment`. */
export function withSkills(inherited: NodeJS.ProcessEnv, paths: ReadonlyArray<string>): NodeJS.ProcessEnv {
  const content = inherited.OPENCODE_CONFIG_CONTENT;
  if (paths.length === 0 || content === undefined) return inherited;
  // The plugin environment has already decoded and serialized the inline config.
  const config = JSON.parse(content) as Record<string, unknown>;
  return {
    ...inherited,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, ...skillConfig(config.skills, "v2", paths) }),
  };
}

/** One private, credential-free plugin for the locally owned server's lifetime. */
export const environment = Effect.fn("OpenCode.NativeExecutionPlugin.environment")(function* (
  inherited: NodeJS.ProcessEnv,
  generation: "v1" | "v2" = "v2",
  desktopSkillPaths: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-opencode-native-" });
  yield* fs.chmod(directory, 0o700);
  yield* fs.writeFileString(`${directory}/index.js`, generation === "v1" ? sourceV1 : source);
  yield* fs.writeFileString(`${directory}/package.json`, '{"type":"module","main":"index.js"}');
  const content = OpenCodeRuntime.resolveOpenCodeConfigContent(inherited);
  const config = yield* Schema.decodeUnknownEffect(
    fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
  )(content);
  const routing = `${directory}/shells`;
  yield* fs.makeDirectory(routing, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    NODEX_AGENT_SHELL: "1",
    NODEX_OPENCODE_CLI_ROUTING: routing,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      ...skillConfig(config.skills, generation, desktopSkillPaths),
      ...(generation === "v1"
        ? {
            plugin: [
              ...(Array.isArray(config.plugin) ? config.plugin : []),
              pathToFileURL(`${directory}/index.js`).href,
            ],
          }
        : {
            plugins: [...(Array.isArray(config.plugins) ? config.plugins : []), directory],
          }),
    }),
  };
  return environment;
});
