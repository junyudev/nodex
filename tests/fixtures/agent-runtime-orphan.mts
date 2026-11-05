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
const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  detached: true, stdio: "ignore",
});
await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
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
