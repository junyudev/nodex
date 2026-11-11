import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pending = new Map();
const elicitations = new Map();
let nextElicitation = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
const trace = (entry) => appendFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const success = (id, value) => result(id, {
  content: [{ type: "text", text: "fixture" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
  structuredContent: value,
  _meta: { "codex/toolSurface": { kind: "browserUse", backend: "iab" } },
});
// Model a REPL and kernel that ignore stdin EOF, including while the REPL is idle.
const kernel = process.argv[3] === "lifetime"
  ? spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" })
  : undefined;
if (kernel) process.on("SIGTERM", () => {});
trace({ event: "started", kernelPid: kernel?.pid });
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result: reply } = JSON.parse(line);
  if (reply && elicitations.has(id)) {
    success(elicitations.get(id), { reply });
    elicitations.delete(id);
    return;
  }
  if (method === "initialize") {
    result(id, { protocolVersion: params.protocolVersion, serverInfo: { name: "fixture", version: "2" }, capabilities: { tools: {} }, instructions: "fixture instructions" });
  }
  if (method === "tools/list") {
    result(id, { tools: ["js", "js_reset", "js_add_node_module_dir", "turn_ended", "another_hidden"].map((name) => ({
      name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
      _meta: name === "turn_ended" || name === "another_hidden" ? { ui: { visibility: [] } } : {},
    })) });
  }
  if (method === "notifications/cancelled" && pending.delete(params.requestId)) {
    trace({ event: "cancelled" });
    result(params.requestId, { content: [{ type: "text", text: "js execution cancelled; kernel reset" }], isError: true });
  }
  if (method !== "tools/call") return;
  trace({ event: params.name, arguments: params.name === "turn_ended" ? params.arguments : undefined });
  const code = params.arguments?.code;
  if (code === "crash") process.exit(1);
  if (code === "long") {
    pending.set(id, true);
    send({ method: "notifications/progress", params: { progressToken: params._meta.progressToken, progress: 1 } });
    return;
  }
  if (typeof code === "string" && code.startsWith("elicit")) {
    const reverseId = nextElicitation++;
    elicitations.set(reverseId, id);
    const meta = {
      ...params._meta,
      progressToken: reverseId + 1000,
      codex_approval_kind: "mcp_tool_call",
      persist: ["session"],
      ...(code === "elicit-strict" ? { codex_strict_auto_review: true } : {}),
      ...(code === "elicit-foreign" ? { callId: "foreign" } : {}),
      ...(code === "elicit-other-turn"
        ? { "x-codex-turn-metadata": { ...params._meta["x-codex-turn-metadata"], turn_id: "retired" } }
        : {}),
    };
    send({ id: reverseId, method: "elicitation/create", params: {
      message: "Allow fixture access?",
      requestedSchema: code === "elicit-required"
        ? { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
        : { type: "object", properties: {} },
      _meta: meta,
    } });
    if (code === "elicit-cancel") send({ method: "notifications/cancelled", params: { requestId: reverseId } });
    return;
  }
  success(id, { meta: params._meta ?? {}, pid: process.pid, cwd: process.cwd() });
});
