import { realpath } from "node:fs/promises";
import { dirname, basename, isAbsolute, join } from "node:path";

type ProfileEnvironment = readonly {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}[];
type CredentialScopeInput = {
  readonly agentIdentity: string;
  readonly environment: ProfileEnvironment;
  readonly homeDirectory: string;
  readonly platform: string;
};

/** Missing profile folders still resolve through their nearest existing physical ancestor. */
export async function canonicalAcpProfilePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Agent profile paths must be absolute.");
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      suffix.push(basename(current));
      current = parent;
    }
  }
}
export async function acpNativeStorageScope(
  environment: ProfileEnvironment,
): Promise<string> {
  const directories = environment.filter(
    ({ name, sensitive, value }) =>
      !sensitive &&
      isAbsolute(value) &&
      /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME)$|_(?:CONFIG_DIR|HOME)$/u.test(
        name,
      ),
  );
  const normalized = await Promise.all(
    directories.map(
      async ({ name, value }) => [name, await canonicalAcpProfilePath(value)] as const,
    ),
  );
  return JSON.stringify(normalized.sort(([left], [right]) => left.localeCompare(right)));
}

/** Only a declared Agent's credential root proves account isolation; toolchain/cache roots do not. */
export async function acpCredentialStorageScope(input: CredentialScopeInput): Promise<string> {
  const directory = (name: string) =>
    input.environment.find(
      (entry) =>
        !entry.sensitive &&
        (input.platform === "win32" ? entry.name.toUpperCase() : entry.name) === name &&
        isAbsolute(entry.value),
    )?.value;
  const home =
    (input.platform === "win32" ? directory("USERPROFILE") : directory("HOME")) ??
    input.homeDirectory;
  let root = home;
  switch (input.agentIdentity) {
    case "claude-acp":
    case "claude-agent-acp":
      root = directory("CLAUDE_CONFIG_DIR") ?? join(home, ".claude");
      break;
    case "codex-acp":
      root = directory("CODEX_HOME") ?? join(home, ".codex");
      break;
    case "opencode":
    case "opencode-v2":
      // OpenCode stores credentials under its data root, independently of OPENCODE_CONFIG_DIR.
      root = join(directory("XDG_DATA_HOME") ?? join(home, ".local", "share"), "opencode");
      break;
  }
  return canonicalAcpProfilePath(root);
}

export async function acpProviderStorageScopes(input: CredentialScopeInput) {
  const [nativeStorageScope, credentialStorageScope] = await Promise.all([
    acpNativeStorageScope(input.environment),
    acpCredentialStorageScope(input),
  ]);
  return { nativeStorageScope, credentialStorageScope };
}
