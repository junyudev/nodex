import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Ledger from "../../packages/agent-runtime/vendor/provider-opencode/src/server/OpenCodeServerLedger.ts";

const home = process.argv[process.argv.indexOf("--home") + 1]!;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
await lines.next(); // bootstrap
const slowGroup = process.env.NODEX_FIXTURE_ORPHAN_GROUP === "1";
// The recorded leader exits on SIGTERM; its child keeps the group alive until
// the ledger escalates. IPC disconnect proves the leader has physically exited.
const descendant = `
  const { writeFileSync } = require("node:fs");
  process.on("SIGTERM", () => {});
  process.on("disconnect", () => writeFileSync(${JSON.stringify(join(home, "server-orphaned"))}, "ready"));
  process.send(process.pid);
  setInterval(() => {}, 1000);
`;
const leader = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["--eval", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.once("message", (pid) => process.send(pid));
  setInterval(() => {}, 1000);
`;
const child = spawn(process.execPath, ["--eval", slowGroup ? leader : "setInterval(() => {}, 1000)"], {
  detached: true, stdio: slowGroup ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
});
await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
if (slowGroup) {
  await new Promise<void>((resolve) => child.once("message", () => resolve()));
  child.disconnect();
}
await Effect.runPromise(Effect.gen(function* () {
  const ledger = yield* Ledger.make({ stateDir: join(home, "userdata") });
  yield* ledger.track({ pid: child.pid!, port: 4096, args: [] });
}).pipe(Effect.provide(NodeServices.layer)));
writeFileSync(join(home, "server-pid"), String(child.pid));
child.unref();
const identity = {runtimeId:"fixture-runtime", runtimeGeneration:String(process.pid), schemaVersion:1, databasePath:join(home,"fixture.sqlite"), mcpEndpoint:"http://127.0.0.1:1/mcp",lastSequence:0};
const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
send({type:"ready",identity});
for await (const line of { [Symbol.asyncIterator]: () => lines }) {
  const request = JSON.parse(line);
  if(request.method === "project.read") process.exit(9);
  send({id:request.id,success:true,output:request.method === "shutdown" ? {stopped:true} : identity});
  if(request.method === "shutdown") process.exit(0); // simulate lost provider finalizers
}
