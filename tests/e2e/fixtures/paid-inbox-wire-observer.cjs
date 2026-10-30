// Passive, local-only evidence for the synthetic paid Inbox case. Never records account traffic.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const log = process.env.NODEX_PAID_INBOX_WIRE_LOG;
const record = (value) => fs.appendFileSync(log, `${JSON.stringify(value)}\n`);
const bytesEvidence = (bytes) => ({
  byteLength: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const flagValues = (args, flag) =>
  args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);

// Hash the materialized --image file at spawn, before the request releases its temporary files.
const imageFileEvidence = (file) => {
  try { return bytesEvidence(fs.readFileSync(file)); }
  catch (error) { return { readError: error.code ?? "unreadable" }; }
};

// Observe complete JSONL messages while forwarding the original chunks and backpressure.
const lines = (observe) => {
  let buffer = "";
  return (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    for (const line of complete) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      observe(message);
    }
  };
};

if (log && /[/\\]agent-runtime[/\\]entry\.mjs$/u.test(process.argv[1] ?? "")) {
  record({ type: "observer.started" });
  const requests = new Set();
  const incoming = lines((message) => {
    if (message.method !== "text.generate-structured") return;
    requests.add(message.id);
    const input = message.input;
    record({
      type: "runtime.request",
      modelSelection: input.modelSelection,
      prompt: input.prompt,
      images: (input.images ?? []).map((image) => ({
        mediaType: image.mediaType,
        ...bytesEvidence(Buffer.from(image.data, "base64")),
      })),
      outputSchema: input.outputSchema,
    });
  });
  const emit = process.stdin.emit;
  process.stdin.emit = function (event, ...args) {
    if (event === "data") incoming(args[0]);
    return emit.call(this, event, ...args);
  };
  const outgoing = lines((message) => {
    if (!requests.delete(message.id)) return;
    record({ type: "runtime.response", output: message.output, error: message.error });
  });
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    outgoing(chunk);
    return write.call(this, chunk, ...args);
  };

  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, ...rest) {
    if (!Array.isArray(args) || args[0] !== "exec" || path.basename(command) !== "codex")
      return spawn.call(this, command, args, ...rest);
    const images = flagValues(args, "--image");
    const effort = flagValues(args, "--config")
      .map((value) => /^model_reasoning_effort="?([a-z]+)"?$/u.exec(value)?.[1])
      .find(Boolean) ?? null;
    // Only these allowlisted fields leave the observer. Never record argv, env or native output.
    const evidence = {
      model: flagValues(args, "--model")[0] ?? null,
      effort,
      imageArgumentCount: images.length,
      images: images.map(imageFileEvidence),
    };
    const child = spawn.call(this, command, args, ...rest);
    record({ type: "codex.exec", childPid: child.pid, ...evidence });
    child.once("exit", (code, signal) => {
      record({ type: "codex.exec.exit", childPid: child.pid, code, signal });
    });
    return child;
  };
  syncBuiltinESMExports();
}
