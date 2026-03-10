import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

interface BackupRecord {
  version: number;
  id: string;
  createdAt: string;
  trigger: "manual" | "auto" | "pre-restore";
  label: string | null;
  includesAssets: boolean;
  dbBytes: number;
  assetsBytes: number;
  totalBytes: number;
}

function createMockBackup(id: string, trigger: BackupRecord["trigger"], label: string | null): BackupRecord {
  return {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    trigger,
    label,
    includesAssets: true,
    dbBytes: 100,
    assetsBytes: 200,
    totalBytes: 300,
  };
}

function parseJsonBody(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};
  return JSON.parse(rawBody) as Record<string, unknown>;
}

function runCli(
  args: string[],
  homeDir: string
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

describe("backups CLI command", () => {
  test("supports create/list/restore and enforces --yes for restore", async () => {
    const backups: BackupRecord[] = [];
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-cli-home-"));

    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = parseJsonBody(rawBody);

        if (method === "GET" && url.pathname === "/api/backups") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ backups }));
          return;
        }

        if (method === "POST" && url.pathname === "/api/backups") {
          const next = createMockBackup(`bkp-${backups.length + 1}`, "manual", (body.label as string) || null);
          backups.unshift(next);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(next));
          return;
        }

        const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
        if (method === "POST" && restoreMatch) {
          const backupId = decodeURIComponent(restoreMatch[1]);
          if (!backups.find((entry) => entry.id === backupId)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Backup not found" }));
            return;
          }

          if (body.confirm !== true) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Restore requires confirm=true" }));
            return;
          }

          const safetyBackup = createMockBackup(`safe-${Date.now()}`, "pre-restore", "auto safety");
          backups.unshift(safetyBackup);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              restoredBackupId: backupId,
              safetyBackupId: safetyBackup.id,
            })
          );
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

      const createResult = await runCli(
        ["backups", "create", "--url", baseUrl, "--json", "--label", "before-tests"],
        homeDir
      );
      expect(createResult.exitCode).toBe(0);
      const created = JSON.parse(createResult.stdout) as BackupRecord;
      expect(created.id.length > 0).toBeTrue();

      const listResult = await runCli(["backups", "--url", baseUrl, "--json"], homeDir);
      expect(listResult.exitCode).toBe(0);
      const listed = JSON.parse(listResult.stdout) as BackupRecord[];
      expect(listed.length).toBe(1);
      expect(listed[0].id).toBe(created.id);

      const restoreWithoutYes = await runCli(
        ["backups", "restore", created.id, "--url", baseUrl, "--json"],
        homeDir
      );
      expect(restoreWithoutYes.exitCode).toBe(1);
      expect(restoreWithoutYes.stderr.includes("--yes")).toBeTrue();

      const restoreWithYes = await runCli(
        ["backups", "restore", created.id, "--yes", "--url", baseUrl, "--json"],
        homeDir
      );
      expect(restoreWithYes.exitCode).toBe(0);
      const restored = JSON.parse(restoreWithYes.stdout) as {
        success: boolean;
        restoredBackupId: string;
        safetyBackupId?: string;
      };
      expect(restored.success).toBeTrue();
      expect(restored.restoredBackupId).toBe(created.id);
      expect(Boolean(restored.safetyBackupId)).toBeTrue();
    } finally {
      server.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
