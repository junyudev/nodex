import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vite-plus/test";
import {
  createCodexHomeDirectory,
  readCodexHomeReceipt,
  writeCodexHomeReceipt,
} from "./CodexHomeReceipt";

const newHome = () => realpathSync(mkdtempSync(join(tmpdir(), "nodex-codex-home-")));

test("active home receipts publish the current directory without leaving temporary files", () => {
  const profileHome = newHome();
  try {
    expect(readCodexHomeReceipt(profileHome)).toBeNull();
    const active = join(profileHome, "active");
    writeCodexHomeReceipt({ profileHome, codexHome: active });
    expect(readCodexHomeReceipt(profileHome)).toBe(active);
    const replacement = join(profileHome, "replacement");
    writeCodexHomeReceipt({ profileHome, codexHome: replacement });
    expect(readCodexHomeReceipt(profileHome)).toBe(replacement);
    const directory = join(profileHome, "runtime", "agent");
    expect(readdirSync(directory)).toEqual(["codex-home.json"]);
    if (process.platform !== "win32") {
      expect(statSync(join(directory, "codex-home.json")).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("home receipts reject invalid home identities", () => {
  const profileHome = newHome();
  try {
    expect(() => writeCodexHomeReceipt({ profileHome, codexHome: "relative" })).toThrow(
      "absolute path",
    );
    const directory = join(profileHome, "runtime", "agent");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "codex-home.json"),
      JSON.stringify({ version: 1, codexHome: "relative" }),
    );
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("absolute path");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("home receipts reject oversized, malformed and symlinked files", () => {
  const profileHome = newHome();
  try {
    const directory = join(profileHome, "runtime", "agent");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "codex-home.json");
    writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("too large");
    writeFileSync(file, "malformed");
    expect(() => readCodexHomeReceipt(profileHome)).toThrow();
    rmSync(file);
    const outside = join(profileHome, "outside.json");
    const contents = JSON.stringify({ version: 1, codexHome: join(profileHome, "native") });
    writeFileSync(outside, contents);
    symlinkSync(outside, file);
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("regular file");
    expect(() =>
      writeCodexHomeReceipt({ profileHome, codexHome: join(profileHome, "replacement") }),
    ).toThrow("regular file");
    expect(readFileSync(outside, "utf8")).toBe(contents);
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("native home symlinks retain canonical identity while regular files are rejected", () => {
  const profileHome = newHome();
  try {
    const target = join(profileHome, "native");
    const alias = join(profileHome, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    writeCodexHomeReceipt({ profileHome, codexHome: alias });
    expect(readCodexHomeReceipt(profileHome)).toBe(target);
    const regular = join(profileHome, "file");
    writeFileSync(regular, "content");
    expect(() => writeCodexHomeReceipt({ profileHome, codexHome: regular })).toThrow("directory");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("native home preparation creates a private directory and preserves existing configuration", () => {
  const profileHome = newHome();
  try {
    const native = join(profileHome, "native");
    createCodexHomeDirectory(native);
    expect(statSync(native).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(native).mode & 0o777).toBe(0o700);
    const config = join(native, "config.toml");
    writeFileSync(config, "model = 'custom'\n");
    createCodexHomeDirectory(native);
    expect(readFileSync(config, "utf8")).toBe("model = 'custom'\n");
    expect(() => createCodexHomeDirectory(config)).toThrow("directory");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});
