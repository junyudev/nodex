const fs = require("node:fs");
const log = process.env.NODEX_TEST_SESSION_MCP_WIRE_LOG;
if (log && /[/\\]agent-runtime[/\\]entry\.mjs$/u.test(process.argv[1] ?? "")) {
  const record = (frame) => fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...frame })}\n`);
  const historyReads = new Map();
  const observe = (direction, message) => {
    if (direction === "main-to-runtime" && message.method === "thread.acknowledge-read") {
      historyReads.set(message.id, message.input);
      record({ direction, type: "history.acknowledge.request", id: message.id, input: message.input });
    }
    if (direction === "runtime-to-main" && historyReads.has(message.id) && typeof message.success === "boolean") {
      record({ direction, type: "history.acknowledge.result", id: message.id, input: historyReads.get(message.id), success: message.success, output: message.output });
      historyReads.delete(message.id);
    }
    if (message.type === "host.request" && message.operation === "tool.call")
      record({ direction, type: message.type, id: message.id, tool: message.tool, input: message.input });
    if (message.type === "host.cancel" || message.type === "host.result" || message.type === "cancel")
      record({ direction, type: message.type, id: message.id, success: message.success });
    if (message.method === "thread.execution.wait")
      record({ direction, type: "execution.wait", id: message.id, input: message.input });
  };
  const feed = (direction) => {
    let pending = "";
    return (chunk) => {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try { observe(direction, JSON.parse(line)); } catch { /* The real decoder owns malformed frames. */ }
      }
    };
  };
  const input = feed("main-to-runtime");
  const output = feed("runtime-to-main");
  const emit = process.stdin.emit;
  process.stdin.emit = function (event, ...args) {
    if (event === "data") input(args[0]);
    return emit.call(this, event, ...args);
  };
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    output(chunk);
    return write.call(this, chunk, ...args);
  };
}
