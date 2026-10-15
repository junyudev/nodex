import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_FILES = [
  "config.toml",
  "managed_config.toml",
  "requirements.toml",
  "hooks.json",
  "AGENTS.md",
] as const;
const RESOURCES = ["skills", "rules", "prompts", "agents", "plugins", "marketplaces"] as const;
const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
const stat = (path: string) =>
  lstat(path).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });

/** Current account policy stays authoritative; formal native capture excludes these private resources. */
export async function materializeRestoredCodexConfiguration(input: {
  readonly configuredHome: string;
  readonly historyHome: string;
}): Promise<void> {
  const historyHome = await realpath(input.historyHome);
  const home = resolve(input.configuredHome);
  const selectedHome = await realpath(home).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });
  if (selectedHome === historyHome) return;
  for (const name of CONFIG_FILES) {
    const destination = join(historyHome, name);
    const existing = await stat(destination);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
      throw new Error("Restored Codex configuration must remain a private regular file");
    const sourcePath = join(home, name);
    const source = await stat(sourcePath);
    if (!source) {
      if (existing) await rm(destination);
      continue;
    }
    // An approved account overlay may link its current config to its shared home.
    const file = await open(await realpath(sourcePath), constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES)
        throw new Error("Configured Codex policy exceeds its file admission bound");
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const part = await file.read(bytes, count, bytes.length - count, count);
        if (part.bytesRead === 0) break;
        count += part.bytesRead;
      }
      if (count > MAX_CONFIG_BYTES)
        throw new Error("Configured Codex policy exceeds its file admission bound");
      data = bytes.subarray(0, count);
    } finally {
      await file.close();
    }
    if (name === "config.toml" || name === "managed_config.toml") {
      try {
        data = Buffer.from(
          stringify({
            ...parse(data.toString("utf8")),
            sqlite_home: historyHome,
            cli_auth_credentials_store: "ephemeral",
          }),
        );
      } catch {
        throw new Error("Configured Codex policy could not be admitted");
      }
    }
    const temporary = join(historyHome, `.config-${randomUUID()}`);
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await output.writeFile(data);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const name of RESOURCES) {
    const destination = join(historyHome, name);
    const existing = await stat(destination);
    if (existing && !existing.isSymbolicLink())
      throw new Error("Restored Codex resources must use the configured account's directory");
    const source = join(home, name);
    if (!(await stat(source))) {
      if (existing) await rm(destination);
      continue;
    }
    const target = await realpath(source);
    if (existing && resolve(dirname(destination), await readlink(destination)) === target) continue;
    if (existing) await rm(destination);
    await symlink(target, destination);
  }
}
