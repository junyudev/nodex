const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const log = process.env.NODEX_TEST_SESSION_MCP_SOURCE_FAULT_LOG;
if (log && /[/\\]agent-runtime[/\\]entry\.mjs$/u.test(process.argv[1] ?? "")) {
  const emit = process.stdin.emit;
  let pending = "";
  let injected = false;
  const decoder = new StringDecoder("utf8");
  // Fail one real owner request at its transport boundary; every other frame reaches
  // the production decoder unchanged. No history, result or clock is fabricated.
  process.stdin.emit = function (event, ...args) {
    if (event !== "data") {
      if (event === "end") {
        pending += decoder.end();
        if (pending) emit.call(this, "data", Buffer.from(pending));
      }
      return emit.call(this, event, ...args);
    }
    pending += Buffer.isBuffer(args[0]) ? decoder.write(args[0]) : String(args[0]);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let frame;
      try { frame = JSON.parse(line); } catch { /* The production decoder owns invalid input. */ }
      if (!injected && frame?.method === "sessions.search" && frame.input?.query === "Synthetic Session") {
        injected = true;
        fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), event: "injected-search-unavailable", requestId: frame.id, query: frame.input.query })}\n`);
        process.stdout.write(`${JSON.stringify({ id: frame.id, success: false, error: { message: "Synthetic search source temporarily unavailable" } })}\n`);
        continue;
      }
      emit.call(this, "data", Buffer.from(`${line}\n`));
    }
    return true;
  };
}
