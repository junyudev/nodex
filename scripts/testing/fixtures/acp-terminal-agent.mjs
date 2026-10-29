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
  const reportSize = (kind) => process.stdout.write(
    `${kind}:${process.stdout.columns}:${process.stdout.rows}\n`,
  );
  // Child-side columns/rows change asynchronously when Node handles the resize.
  process.stdout.on("resize", () => reportSize("RESIZED"));
  process.stdout.write("READY\n");
  lines.on("line", (line) => {
    if (line === "secret") {
      const secret = process.env.NODEX_PTY_FIXTURE_TOKEN;
      if (!secret) throw new Error("Missing secret fixture");
      process.stdout.write(`TOKEN:${secret.slice(0, 12)}`);
      setTimeout(() => process.stdout.write(`${secret.slice(12)}\nSECRET_DONE\n`), 150);
      return;
    }
    if (line === "size") {
      reportSize("SIZE");
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
