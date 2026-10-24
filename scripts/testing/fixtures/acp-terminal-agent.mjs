import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.NODEX_PTY_FIXTURE_HOME;
if (!home) throw new Error("Fixture requires NODEX_PTY_FIXTURE_HOME");
mkdirSync(home, { recursive: true });
const authentication = join(home, "authenticated");
const lines = createInterface({ input: process.stdin });
const record = (value) =>
  appendFileSync(
    join(home, "observations.jsonl"),
    `${JSON.stringify(value)}\n`,
  );
if (process.argv.includes("login")) {
  let child;
  record({ event: "terminal", pid: process.pid });
  const finish = (code) => {
    if (!child) {
      process.exit(code);
      return;
    }
    child.once("exit", () => process.exit(code));
    child.kill("SIGKILL");
  };
  process.stdout.write("READY\n");
  lines.on("line", (line) => {
    if (line === "size") {
      process.stdout.write(
        `SIZE:${process.stdout.columns}:${process.stdout.rows}\n`,
      );
      return;
    }
    if (line === "child") {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      record({ event: "descendant", pid: child.pid });
      process.stdout.write(`CHILD:${child.pid}\n`);
      return;
    }
    if (line === "success") {
      writeFileSync(authentication, "authenticated");
      finish(0);
      return;
    }
    if (line === "exit") {
      finish(0);
      return;
    }
    process.stdout.write(`INPUT:${line}\n`);
  });
  lines.on("close", () => finish(0));
} else {
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    record({ event: "request", method: request.method });
    const reply = (result) =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
      );
    if (request.method === "initialize") {
      reply({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "pty-fixture", version: "1" },
        authMethods: [
          {
            id: "terminal",
            name: "Terminal",
            type: "terminal",
            args: ["login"],
          },
        ],
      });
      return;
    }
    if (request.method === "session/new") {
      if (!existsSync(authentication)) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } })}\n`,
        );
        return;
      }
      reply({ sessionId: "fixture-session" });
      return;
    }
    if (request.method === "authenticate" || request.method === "auth/login") {
      throw new Error(
        "Terminal authentication must not call the ACP login method",
      );
    }
    reply({});
  });
}
