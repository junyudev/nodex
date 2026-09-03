#!/usr/bin/env node

// Exercise a development handshake without replacing native persistence or history RPCs.
import { spawn } from "node:child_process";
import readline from "node:readline";

const executable = process.env.NODEX_TEST_NATIVE_CODEX_EXECUTABLE;
if (!executable) throw new Error("Missing native Codex executable for the unversioned fixture");
const child = spawn(executable, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
process.stdin.pipe(child.stdin);
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.result?.userAgent === "string") {
    message.result.userAgent = "codex-app-server/0.0.0";
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
