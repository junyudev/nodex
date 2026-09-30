import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertCodexAccountHomeIdentity,
  codexAccountHomeEnvironment,
  codexAccountHomeLaunchArgs,
  inspectCodexAccountHome,
  prepareCodexAccountHome,
} from "./CodexAccountHome";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-codex-account-"));
  roots.push(root);
  const sharedHome = join(root, "shared");
  const accountHome = join(root, "personal");
  mkdirSync(sharedHome);
  mkdirSync(accountHome);
  return { root, sharedHome, accountHome, platform: "darwin" };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex account directory", () => {
  it("shares native history, CLI profiles and writer locks while keeping credentials and model cache private", () => {
    const input = fixture();
    writeFileSync(join(input.sharedHome, "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(input.sharedHome, "work.config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(input.sharedHome, "auth.json"), "shared credentials");
    writeFileSync(join(input.sharedHome, ".credentials.json"), "shared MCP credentials");
    writeFileSync(join(input.sharedHome, "session_index.jsonl"), "shared native name index");
    writeFileSync(join(input.sharedHome, "state_5.sqlite"), "native database");
    writeFileSync(join(input.sharedHome, "state_5.sqlite-wal"), "native journal");
    writeFileSync(join(input.accountHome, "auth.json"), "personal credentials");
    writeFileSync(join(input.accountHome, "models_cache.json"), "personal models");
    const home = prepareCodexAccountHome(input);
    const canonicalInput = {
      ...input,
      sharedHome: home.sharedHome,
      accountHome: home.effectiveHome,
    };
    expect(readlinkSync(join(home.effectiveHome, "sessions"))).toBe(
      join(home.sharedHome, "sessions"),
    );
    expect(readlinkSync(join(home.effectiveHome, "thread-writer-locks"))).toBe(
      join(home.sharedHome, "thread-writer-locks"),
    );
    expect(readFileSync(join(home.effectiveHome, "config.toml"), "utf8")).toBe(
      readFileSync(join(home.sharedHome, "config.toml"), "utf8"),
    );
    expect(readlinkSync(join(home.effectiveHome, "work.config.toml"))).toBe(
      join(home.sharedHome, "work.config.toml"),
    );
    expect(readFileSync(join(home.effectiveHome, "auth.json"), "utf8")).toBe(
      "personal credentials",
    );
    expect(readFileSync(join(home.sharedHome, "auth.json"), "utf8")).toBe("shared credentials");
    expect(lstatSync(join(home.effectiveHome, "models_cache.json")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(home.effectiveHome, "state_5.sqlite"))).toBe(false);
    expect(existsSync(join(home.effectiveHome, "state_5.sqlite-wal"))).toBe(false);
    expect(existsSync(join(home.effectiveHome, ".credentials.json"))).toBe(false);
    expect(existsSync(join(home.effectiveHome, "session_index.jsonl"))).toBe(false);
    expect(codexAccountHomeEnvironment(home, { OTHER: "preserved" })).toEqual({
      OTHER: "preserved",
      CODEX_HOME: home.effectiveHome,
      CODEX_SQLITE_HOME: home.sharedHome,
    });
    expect(
      codexAccountHomeEnvironment(home, { CODEX_SQLITE_HOME: "/explicit/native-store" })
        .CODEX_SQLITE_HOME,
    ).toBe("/explicit/native-store");
    expect(codexAccountHomeLaunchArgs(home)).toEqual(["-c", 'cli_auth_credentials_store="file"']);
    expect(() => assertCodexAccountHomeIdentity(home, input.platform)).not.toThrow();
    expect(prepareCodexAccountHome(canonicalInput).sharedHome).toBe(home.sharedHome);
  });

  it("validates without creating paths and refuses to overwrite existing history or config", () => {
    const input = fixture();
    const missing = join(input.root, "not-created");
    inspectCodexAccountHome({ ...input, accountHome: missing });
    expect(existsSync(missing)).toBe(false);
    writeFileSync(join(input.accountHome, "config.toml"), "personal config");
    expect(() => prepareCodexAccountHome(input)).toThrow("contains its own config.toml");
    expect(readFileSync(join(input.accountHome, "config.toml"), "utf8")).toBe("personal config");
    expect(existsSync(join(input.sharedHome, "sessions"))).toBe(false);
    expect(existsSync(join(input.accountHome, "sessions"))).toBe(false);
  });

  it("rejects an account's independent conversation database and links to another shared home", () => {
    const input = fixture();
    writeFileSync(join(input.accountHome, "state_5.sqlite"), "separate conversations");
    expect(() => prepareCodexAccountHome(input)).toThrow("its own conversation database");
    rmSync(join(input.accountHome, "state_5.sqlite"));
    const wrongTarget = join(input.root, "other-sessions");
    symlinkSync(wrongTarget, join(input.accountHome, "sessions"));
    expect(() => prepareCodexAccountHome(input)).toThrow("different shared home");
    expect(readlinkSync(join(input.accountHome, "sessions"))).toBe(wrongTarget);
  });

  it.each(["symlink", "hardlink"])(
    "refuses shared %s credentials without changing them",
    (kind) => {
      const input = fixture();
      const source = join(input.sharedHome, "auth.json");
      writeFileSync(source, "shared credentials");
      if (kind === "symlink") symlinkSync(source, join(input.accountHome, "auth.json"));
      else linkSync(source, join(input.accountHome, "auth.json"));
      expect(() => prepareCodexAccountHome(input)).toThrow("private regular file");
      expect(readFileSync(source, "utf8")).toBe("shared credentials");
    },
  );

  it("fences account path replacement and never mutates unsupported Windows layouts", () => {
    const input = fixture();
    expect(() => prepareCodexAccountHome({ ...input, platform: "win32" })).toThrow(
      "unavailable on Windows",
    );
    expect(existsSync(join(input.sharedHome, "sessions"))).toBe(false);
    const home = prepareCodexAccountHome(input);
    renameSync(home.effectiveHome, `${home.effectiveHome}-old`);
    mkdirSync(home.effectiveHome);
    expect(() => assertCodexAccountHomeIdentity(home, input.platform)).toThrow(
      "changed after startup",
    );
    expect(() => inspectCodexAccountHome({ ...input, accountHome: input.sharedHome })).toThrow(
      "cannot contain one another",
    );
    expect(() =>
      inspectCodexAccountHome({ ...input, accountHome: join(input.sharedHome, "account") }),
    ).toThrow("cannot contain one another");
  });

  it("refuses to restart an account that lost a shared session or writer-lock link", () => {
    const input = fixture();
    const home = prepareCodexAccountHome(input);
    rmSync(join(home.effectiveHome, "thread-writer-locks"));
    expect(() => assertCodexAccountHomeIdentity(home, input.platform)).toThrow(
      "lost its shared thread-writer-locks",
    );
    expect(existsSync(join(home.effectiveHome, "thread-writer-locks"))).toBe(false);
  });
});
