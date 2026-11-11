// @effect-diagnostics nodeBuiltinImport:off -- spawned regression fixture
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { acquire } from "../../nodex/RuntimeHomeLease.ts";
import { makeRepl } from "../Repl.ts";
import { reapDesktopReplProcesses } from "../ReplProcess.ts";

const [home, mode] = process.argv.slice(2) as [string, string];
const sessionId = "a".repeat(64);
const codexHome = join(home, "codex");
const activeExecs = join(codexHome, "node_repl", "active_execs");
const trace = join(home, "trace.jsonl");

await Effect.runPromise(
  Effect.scoped(
    acquire(home).pipe(
      Effect.andThen(Effect.promise(() => reapDesktopReplProcesses(home))),
      Effect.andThen(
        Effect.promise(async () => {
          if (mode === "replacement") return;
          const repl = makeRepl({
            home,
            sessionId,
            server: {
              command: process.execPath,
              args: [fileURLToPath(new URL("./repl.mjs", import.meta.url)), trace, "lifetime"],
              env: { CODEX_HOME: codexHome },
            },
            environment: {},
            cwd: home,
            elicit: async () => ({ action: "decline" }),
          });
          const client = await repl.get();
          const [started] = (await readFile(trace, "utf8")).split("\n");
          if (!started) throw new Error("Fixture REPL did not report its process IDs");
          const { pid: nodeReplPid, kernelPid } = JSON.parse(started) as {
            pid: number;
            kernelPid: number;
          };
          if (mode === "idle") process.send!({ nodeReplPid, kernelPid });
          else {
            const call = client.request(
              {
                method: "tools/call",
                params: { name: "js", arguments: { code: "long" }, _meta: { progressToken: 7 } },
              },
              CallToolResultSchema,
              {
                onprogress: async () => {
                  await mkdir(activeExecs, { recursive: true });
                  await writeFile(
                    join(activeExecs, "fixture.json"),
                    JSON.stringify({ sessionId, nodeReplPid, kernelPid }),
                  );
                  process.send!({ nodeReplPid, kernelPid });
                },
              },
            );
            await call;
          }
          await new Promise<void>(() => {});
        }),
      ),
    ),
  ),
);
