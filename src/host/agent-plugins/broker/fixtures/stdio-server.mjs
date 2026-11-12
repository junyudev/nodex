import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const [mode, argument] = process.argv.slice(2);
appendFileSync(join(process.env.PLUGIN_DATA, "starts"), "start\n");
if (mode === "crash") process.exit(1);

const tools = [{ name: "inspect", inputSchema: { type: "object" } }];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) continue;
  const { id, method, params } = request;
  if (method === "tools/call" && params.arguments?.exit) process.exit(1);
  if (method === "tools/call" && params.arguments?.pause) {
    const data = process.env.PLUGIN_DATA;
    appendFileSync(join(data, "started"), "call\n");
    while (!existsSync(join(data, "release"))) await setTimeout(10);
    appendFileSync(join(data, "finished"), "call\n");
  }
  const result = method === "initialize"
    ? {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-fixture", version: "1" },
      }
    : method === "tools/list"
      ? { tools }
      : {
          content: [],
          structuredContent: {
            pid: process.pid,
            cwd: process.cwd(),
            env: {
              PLUGIN_ROOT: process.env.PLUGIN_ROOT,
              PLUGIN_DATA: process.env.PLUGIN_DATA,
              DECLARED: process.env.DECLARED,
            },
            envNames: Object.keys(process.env).filter((name) => process.env[name]).sort(),
            argument,
          },
        };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
