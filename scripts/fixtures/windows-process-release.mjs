import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [role, directory, stdio] = process.argv.slice(2);
if (!["leader", "descendant", "unrelated"].includes(role)) throw new Error("Unknown role");
if (!["pipe", "ignore"].includes(stdio)) throw new Error("Unknown stdio mode");

if (role !== "leader") {
  process.on("SIGTERM", () => {});
  writeFileSync(path.join(directory, `${role}.json`), JSON.stringify({ pid: process.pid }));
  if (stdio === "pipe") process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  process.on("SIGTERM", () => process.exit(0));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant", directory, stdio], {
    env: process.env,
    stdio: stdio === "pipe" ? ["ignore", "pipe", "inherit"] : "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => { throw error; });
  const publish = () => {
    const descendant = JSON.parse(readFileSync(path.join(directory, "descendant.json"), "utf8")).pid;
    writeFileSync(path.join(directory, "leader.json"), JSON.stringify({ pid: process.pid, descendant }));
    if (stdio === "pipe") process.stdout.write(`${process.pid}:${descendant}\n`);
  };
  if (stdio === "pipe") child.stdout.once("data", publish);
  else {
    const timer = setInterval(() => {
      if (!existsSync(path.join(directory, "descendant.json"))) return;
      clearInterval(timer);
      publish();
    }, 5);
  }
}
