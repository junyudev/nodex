const fs = require("node:fs");
const entry = process.argv[1] ?? "";
const log = process.env.NODEX_TEST_AGENT_RUNTIME_WIRE_LOG;
if (log && /[/\\]agent-runtime[/\\]entry\.mjs$/u.test(entry)) {
  const record = (value) => fs.appendFileSync(log, `${JSON.stringify(value)}\n`);
  record({ type: "engine.started", executable: process.execPath, version: process.version });
  const emit = process.stdin.emit;
  const authorityReads = new Set();
  let buffer = "";
  // Observe the production transport without starting stdin or changing delivery.
  process.stdin.emit = function (event, ...args) {
    if (event === "data") {
      buffer += Buffer.isBuffer(args[0]) ? args[0].toString("utf8") : String(args[0]);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (typeof message.method === "string") record({ type: "request", method: message.method });
          if (message.method === "events.observe") record({ type: "observation", id: message.id, input: message.input });
          if (message.method === "thread.authority") authorityReads.add(message.id);
          if (message.type === "host.result" && message.success === false)
            record({ type: "host.failure", error: message.error });
        } catch { /* The real decoder owns malformed input. */ }
      }
    }
    return emit.call(this, event, ...args);
  };
  const write = process.stdout.write;
  let outputBuffer = "";
  process.stdout.write = function (chunk, ...args) {
    outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type === "host.request" && message.operation === "turn.prepare")
          record({ type: "host.prepare", identity: message.identity });
        if (message.type === "event") record({ type: "engine.event", subscriptionId: message.subscriptionId, sequence: message.event?.sequence, eventType: message.event?.event?.type, itemId: message.event?.event?.payload?.id });
        if (message.type === "event.error") record({ type: "engine.event-error", subscriptionId: message.subscriptionId, message: message.message });
        if (authorityReads.delete(message.id))
          record({ type: "authority.proof", output: message.output });
      } catch { /* The transport owns output validation. */ }
    }
    return write.call(this, chunk, ...args);
  };
}
