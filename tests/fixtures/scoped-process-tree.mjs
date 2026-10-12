import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  process.on("SIGTERM", () => process.exit(0));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.once("data", () => process.stdout.write(`${process.pid} ${child.pid}\n`));
}
