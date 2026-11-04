// Holds execution's replies to Thread reads while its event loop keeps answering, which is what a
// read stuck on a slow disk looks like from Main. The flag file's presence is the switch.
const fs = require("node:fs");
const flag = process.env.NODEX_TEST_HELD_READS_FLAG;
if (flag && /[/\\]agent-runtime[/\\]entry\.mjs$/u.test(process.argv[1] ?? "")) {
  const reads = new Set();
  const emit = process.stdin.emit;
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
          if (message.method === "thread.read" || message.method === "thread.snapshot")
            reads.add(message.id);
        } catch {
          /* The real decoder owns malformed input. */
        }
      }
    }
    return emit.call(this, event, ...args);
  };
  const write = process.stdout.write;
  const held = [];
  process.stdout.write = function (chunk, ...args) {
    try {
      const { id } = JSON.parse(String(chunk));
      if (reads.delete(id) && fs.existsSync(flag)) {
        held.push([chunk, args]);
        return true;
      }
    } catch {
      /* Not a whole frame this fixture understands; deliver it unchanged. */
    }
    return write.call(this, chunk, ...args);
  };
  setInterval(() => {
    if (held.length === 0 || fs.existsSync(flag)) return;
    for (const [chunk, args] of held.splice(0)) write.call(process.stdout, chunk, ...args);
  }, 100).unref();
}
