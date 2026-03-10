import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorktreeEnvironmentOptions,
  readWorktreeEnvironmentDefinition,
} from "./worktree-environment-service";

function createWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-env-"));
}

describe("worktree-environment-service", () => {
  test("lists toml environments with name fallback and setup-script flag", async () => {
    const workspacePath = createWorkspace();
    const envDir = path.join(workspacePath, ".codex", "environments");
    fs.mkdirSync(envDir, { recursive: true });

    fs.writeFileSync(
      path.join(envDir, "environment.toml"),
      [
        'name = "nodex"',
        "",
        "[setup]",
        'script = "bun install"',
        "",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(envDir, "environment-2.toml"),
      [
        "version = 1",
        "",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(path.join(envDir, "broken.toml"), "name = ", "utf8");
    fs.writeFileSync(path.join(envDir, "ignore.txt"), "name = \"ignored\"", "utf8");

    try {
      const options = await listWorktreeEnvironmentOptions(workspacePath);

      expect(options.length).toBe(2);
      expect(options[0]?.path).toBe(".codex/environments/environment-2.toml");
      expect(options[0]?.name).toBe("environment-2");
      expect(options[0]?.hasSetupScript).toBeFalse();
      expect(options[1]?.path).toBe(".codex/environments/environment.toml");
      expect(options[1]?.name).toBe("nodex");
      expect(options[1]?.hasSetupScript).toBeTrue();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("reads setup script from a valid environment file", async () => {
    const workspacePath = createWorkspace();
    const envDir = path.join(workspacePath, ".codex", "environments");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, "environment.toml"),
      [
        'name = "ProPick-1"',
        "",
        "[setup]",
        "script = '''",
        "bun install",
        "bun run build",
        "'''",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const definition = await readWorktreeEnvironmentDefinition({
        workspacePath,
        environmentPath: ".codex/environments/environment.toml",
      });

      expect(definition.path).toBe(".codex/environments/environment.toml");
      expect(definition.name).toBe("ProPick-1");
      expect(definition.setupScript?.includes("bun run build")).toBeTrue();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("rejects environment paths outside .codex/environments", async () => {
    const workspacePath = createWorkspace();
    try {
      let failed = false;
      try {
        await readWorktreeEnvironmentDefinition({
          workspacePath,
          environmentPath: "../outside.toml",
        });
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        expect(message.includes("inside .codex/environments")).toBeTrue();
      }

      expect(failed).toBeTrue();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("rejects invalid toml files when reading selected environment", async () => {
    const workspacePath = createWorkspace();
    const envDir = path.join(workspacePath, ".codex", "environments");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, "bad.toml"), "name = ", "utf8");

    try {
      let failed = false;
      try {
        await readWorktreeEnvironmentDefinition({
          workspacePath,
          environmentPath: ".codex/environments/bad.toml",
        });
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        expect(message.includes("Could not parse environment file")).toBeTrue();
      }

      expect(failed).toBeTrue();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("rejects symlinked environment files that resolve outside .codex/environments", async () => {
    const workspacePath = createWorkspace();
    const envDir = path.join(workspacePath, ".codex", "environments");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-env-outside-"));
    const outsidePath = path.join(outsideDir, "outside.toml");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      outsidePath,
      [
        'name = "outside"',
        "",
      ].join("\n"),
      "utf8",
    );

    const symlinkPath = path.join(envDir, "link.toml");

    try {
      try {
        fs.symlinkSync(outsidePath, symlinkPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (process.platform === "win32" || message.includes("operation not permitted")) {
          expect(true).toBeTrue();
          return;
        }
        throw error;
      }

      let failed = false;
      try {
        await readWorktreeEnvironmentDefinition({
          workspacePath,
          environmentPath: ".codex/environments/link.toml",
        });
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        expect(message.includes("inside .codex/environments")).toBeTrue();
      }

      expect(failed).toBeTrue();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
