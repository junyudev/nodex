import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

function runCli(
  args: string[],
  homeDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cliPath = path.join(process.cwd(), "bin", "nodex.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

describe("card status CLI arguments", () => {
  test("accepts canonical statuses and ergonomic aliases, and rejects legacy shorthands", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-status-cli-home-"));
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];

    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null;
        requests.push({ method, path: url.pathname + url.search, body });

        if (method === "GET" && url.pathname === "/api/projects/default/column") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: url.searchParams.get("id"), name: "In Progress", cards: [] }));
          return;
        }

        if (method === "POST" && url.pathname === "/api/projects/default/board") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "card-1",
            status: body?.status ?? "draft",
            archived: false,
            title: body?.title ?? "",
            description: "",
            priority: "p2-medium",
            tags: [],
            agentBlocked: false,
            created: "2026-03-12T00:00:00.000Z",
            order: 0,
          }));
          return;
        }

        if (method === "GET" && url.pathname === "/api/projects/default/card") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "card-1",
            status: "done",
            archived: false,
            title: "Ship it",
            description: "",
            priority: "p2-medium",
            tags: [],
            agentBlocked: false,
            created: "2026-03-12T00:00:00.000Z",
            order: 0,
          }));
          return;
        }

        if (method === "PUT" && url.pathname === "/api/projects/default/move") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to start test server");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const lsResult = await runCli(["ls", "in-progress", "--project", "default", "--url", baseUrl, "--json"], homeDir);
      expect(lsResult.exitCode).toBe(0);

      const addResult = await runCli(["add", "in-review", "Ship it", "--project", "default", "--url", baseUrl, "--json"], homeDir);
      expect(addResult.exitCode).toBe(0);

      const moveResult = await runCli(["mv", "card-1", "in-progress", "done", "--project", "default", "--url", baseUrl, "--json"], homeDir);
      expect(moveResult.exitCode).toBe(0);

      const legacyNumeric = await runCli(["ls", "5", "--project", "default", "--url", baseUrl, "--json"], homeDir);
      expect(legacyNumeric.exitCode).toBe(1);
      expect(legacyNumeric.stderr.includes("Unknown status")).toBeTrue();

      const legacyReady = await runCli(["ls", "5-ready", "--project", "default", "--url", baseUrl, "--json"], homeDir);
      expect(legacyReady.exitCode).toBe(1);
      expect(legacyReady.stderr.includes("Unknown status")).toBeTrue();

      const listRequest = requests.find((request) => request.method === "GET");
      expect(listRequest?.path).toBe("/api/projects/default/column?id=in_progress");

      const createRequest = requests.find((request) => request.method === "POST");
      expect(createRequest?.body?.status).toBe("in_review");

      const moveRequest = requests.find((request) => request.method === "PUT");
      expect(moveRequest?.body?.fromStatus).toBe("in_progress");
      expect(moveRequest?.body?.toStatus).toBe("done");
    } finally {
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
