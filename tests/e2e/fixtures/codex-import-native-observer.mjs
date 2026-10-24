#!/usr/bin/env node

// Keep the pinned native process and its persistence intact; observe only protocol requests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";

const executable = process.env.NODEX_TEST_IMPORT_NATIVE_EXECUTABLE;
const log = process.env.NODEX_TEST_IMPORT_NATIVE_LOG;
if (!executable || !log) throw new Error("Native import observer requires its owned fixture paths");
const child = spawn(executable, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.pipe(process.stdout);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.method === "string")
    fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, method: message.method, params: message.params })}\n`);
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
