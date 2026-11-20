import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type {
  HostShellEnvironment,
  HostShellOutcome,
} from "../../host-runtime/HostShellEnvironment";
import { mergeProcessEnvironments } from "./child-process-environment";

export const hostEnvironmentHome = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
): string | undefined =>
  platform === "win32"
    ? (hostEnvironmentValue(environment, "USERPROFILE", platform) ??
      hostEnvironmentValue(environment, "HOME", platform))
    : hostEnvironmentValue(environment, "HOME", platform);

export const hostEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string = process.platform,
): string | undefined =>
  platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    : environment[name];
/** Resolve native executables and npm launchers without asking a shell to evaluate user input. */
export const executableCandidates = (
  binary: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
  cwd?: string,
): readonly string[] => {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const home = hostEnvironmentHome(environment, platform);
  const homeRelative = windows ? /^~[/\\]/u.test(binary) : binary.startsWith("~/");
  if (homeRelative && !home) return [];
  const expanded = homeRelative ? path.join(home!, binary.slice(2)) : binary;
  const roots = path.isAbsolute(expanded)
    ? [expanded]
    : cwd && /[/\\]/u.test(expanded)
      ? [path.resolve(cwd, expanded)]
      : searchPathDirectories(environment, platform).map((directory) =>
          path.join(cwd ? path.resolve(cwd, directory) : directory, expanded),
        );
  if (!windows || win32.extname(expanded)) return roots;
  const extensions = (
    hostEnvironmentValue(environment, "PATHEXT", platform) ?? ".EXE;.COM;.CMD;.BAT;.PS1"
  )
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[a-z0-9]+$/iu.test(extension));
  // npm also emits an extensionless Unix shell file next to its Windows shim.
  return roots.flatMap((root) => [
    ...extensions.map((extension) => `${root}${extension.toLowerCase()}`),
    root,
  ]);
};

export interface HostExecutableSearchHost {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly homeDirectory: string;
  readonly systemInstallDirectories?: readonly string[];
}

export interface HostExecutableCandidate {
  readonly path: string;
  readonly realPath: string;
}

interface SearchRequest {
  readonly commands: readonly string[];
  readonly homeLocations?: readonly string[];
  readonly cwd?: string;
  /** An explicit PATH stays authoritative and the account's install directories are skipped. */
  readonly pathOnly?: boolean;
  readonly windowsKind?: "native" | "launcher";
  /** Claude's SDK needs a Windows package entrypoint in place of its npm shell shim. */
  readonly windowsEntries?: (path: string) => readonly string[];
}

const separator = (platform: string) => (platform === "win32" ? ";" : ":");
const searchPathDirectories = (environment: NodeJS.ProcessEnv, platform: string) =>
  (hostEnvironmentValue(environment, "PATH", platform) ?? "")
    .split(separator(platform))
    .filter(Boolean);

const pathKey = (path: string, platform: string) =>
  platform === "win32" ? path.toLowerCase() : path;

const uniquePaths = (paths: readonly string[], platform: string) => {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = pathKey(path, platform);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Common install locations also supply interpreters for user-installed CLI scripts. */
export const hostInstallDirectories = (host: HostExecutableSearchHost) =>
  Effect.gen(function* () {
    const { homeDirectory: home, platform, environment } = host;
    const windows = platform === "win32";
    const path = windows ? win32 : posix;
    const variable = (name: string) => hostEnvironmentValue(environment, name, platform) ?? "";
    const homePath = (...parts: string[]) => path.join(home, ...parts);
    const userPath = (root: string, ...parts: string[]) =>
      path.isAbsolute(root) ? path.join(root, ...parts) : "";
    const xdgData = variable("XDG_DATA_HOME") || homePath(".local", "share");
    const fnmDefault = (directory: string) => userPath(directory, "aliases", "default");
    const common = [
      homePath(".local", "bin"),
      homePath("bin"),
      ...(host.systemInstallDirectories ??
        (windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin"])),
      userPath(variable("BUN_INSTALL"), "bin"),
      homePath(".bun", "bin"),
      homePath(".npm-global", "bin"),
      userPath(variable("VOLTA_HOME"), "bin"),
      homePath(".volta", "bin"),
      userPath(variable("CARGO_HOME"), "bin"),
      homePath(".cargo", "bin"),
      userPath(variable("DENO_INSTALL"), "bin"),
      homePath(".deno", "bin"),
      variable("PNPM_HOME"),
      homePath(...(platform === "darwin" ? ["Library", "pnpm"] : [".local", "share", "pnpm"])),
      userPath(variable("MISE_DATA_DIR"), "shims"),
      userPath(xdgData, "mise", "shims"),
      userPath(variable("ASDF_DATA_DIR"), "shims"),
      homePath(".asdf", "shims"),
    ];
    if (!path.isAbsolute(home)) return [];
    if (windows) {
      const appData = variable("APPDATA") || homePath("AppData", "Roaming");
      const localAppData = variable("LOCALAPPDATA") || homePath("AppData", "Local");
      return uniquePaths(
        [
          ...common,
          userPath(appData, "npm"),
          userPath(appData, "nvm"),
          userPath(localAppData, "pnpm"),
          userPath(localAppData, "Volta", "bin"),
          userPath(localAppData, "mise", "shims"),
          userPath(localAppData, "Microsoft", "WinGet", "Links"),
          homePath("scoop", "shims"),
          variable("NVM_SYMLINK"),
          fnmDefault(variable("FNM_DIR")),
          fnmDefault(userPath(localAppData, "fnm")),
          fnmDefault(userPath(appData, "fnm")),
          fnmDefault(homePath(".fnm")),
          ...["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].map((name) =>
            userPath(variable(name), "nodejs"),
          ),
          userPath(variable("ProgramData"), "chocolatey", "bin"),
        ].filter(path.isAbsolute),
        platform,
      );
    }

    const nvmDirectories = uniquePaths(
      [variable("NVM_DIR"), homePath(".nvm")].filter(path.isAbsolute),
      platform,
    );
    const nvmBins = yield* Effect.forEach(
      nvmDirectories,
      (directory) =>
        Effect.gen(function* () {
          const root = path.join(directory, "versions", "node");
          const versions = yield* Effect.tryPromise(() =>
            readdir(root, { withFileTypes: true }),
          ).pipe(Effect.orElseSucceed(() => []));
          const newest = versions
            .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/u.test(entry.name))
            .map(({ name }) => name)
            .toSorted((left, right) => right.localeCompare(left, "en", { numeric: true }))[0];
          return newest ? path.join(root, newest, "bin") : "";
        }),
      { concurrency: "unbounded" },
    );
    return uniquePaths(
      [
        ...common,
        ...nvmBins,
        ...[
          variable("FNM_DIR"),
          userPath(xdgData, "fnm"),
          homePath(".fnm"),
          ...(platform === "darwin" ? [homePath("Library", "Application Support", "fnm")] : []),
        ].map((directory) => userPath(fnmDefault(directory), "bin")),
      ].filter(path.isAbsolute),
      platform,
    );
  });

export const hostExecutableIdentity = (path: string, platform: string) =>
  Effect.tryPromise(async () => {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    if (!(await stat(path)).isFile()) return undefined;
    return await realpath(path);
  }).pipe(Effect.orElseSucceed(() => undefined));

const recoveredEnvironment = (outcome: HostShellOutcome | null) =>
  outcome?.status === "captured" ? outcome.environment : undefined;

/** All local Agent discovery uses this ordering and file identity check. */
export const makeHostExecutableSearch = (
  host: HostExecutableSearchHost,
  shell: Pick<HostShellEnvironment["Service"], "recover" | "latest">,
  executableIdentity = hostExecutableIdentity,
) => {
  const { platform, homeDirectory } = host;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const loadPath = (directories: readonly string[]) => directories.join(separator(platform));

  const select = <A>(
    request: SearchRequest,
    probe: (
      candidates: readonly HostExecutableCandidate[],
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<A>,
    usable: (result: A) => boolean,
  ) =>
    Effect.gen(function* () {
      const desktop = searchPathDirectories(host.environment, platform);
      const paths = request.commands.some((command) =>
        windows ? /[/\\]/u.test(command) : command.includes("/"),
      );
      const pathOnly = request.pathOnly || paths;
      const directories = pathOnly ? [] : yield* hostInstallDirectories(host);
      const homeLocations = pathOnly
        ? []
        : (request.homeLocations ?? []).map((location) => path.join(homeDirectory, location));
      const run = (login?: NodeJS.ProcessEnv) =>
        Effect.gen(function* () {
          const roots = uniquePaths(
            [...desktop, ...(login ? searchPathDirectories(login, platform) : []), ...directories],
            platform,
          );
          const environment = pathOnly
            ? host.environment
            : mergeProcessEnvironments(platform, host.environment, login ?? {}, {
                PATH: loadPath([
                  ...roots,
                  ...homeLocations.map((location) => path.dirname(location)),
                ]),
              });
          const extensions = windows && request.windowsKind === "native" ? ".EXE;.COM" : undefined;
          const candidates = (commands: readonly string[], tier: readonly string[]) =>
            commands.flatMap((command) =>
              executableCandidates(
                command,
                mergeProcessEnvironments(platform, host.environment, {
                  PATH: loadPath(tier),
                  ...(extensions ? { PATHEXT: extensions } : {}),
                }),
                platform,
                request.cwd,
              ),
            );
          const locations = uniquePaths(
            [
              ...candidates(request.commands, desktop),
              ...(login
                ? candidates(request.commands, searchPathDirectories(login, platform))
                : []),
              ...candidates(request.commands, directories),
              ...candidates(homeLocations, []),
            ].filter(
              (candidate) =>
                path.isAbsolute(candidate) && (!extensions || /\.(exe|com)$/iu.test(candidate)),
            ),
            platform,
          );
          const checked = yield* Effect.forEach(
            locations,
            (candidate) =>
              Effect.gen(function* () {
                const identity = yield* executableIdentity(candidate, platform);
                if (!identity) return undefined;
                if (!windows || !request.windowsEntries)
                  return { path: candidate, realPath: identity };
                for (const entry of request.windowsEntries(candidate)) {
                  const realPath =
                    entry === candidate ? identity : yield* executableIdentity(entry, platform);
                  if (realPath) return { path: entry, realPath };
                }
                return undefined;
              }),
            { concurrency: 16 },
          );
          const seen = new Set<string>();
          return yield* probe(
            checked.filter((candidate): candidate is HostExecutableCandidate => {
              if (!candidate) return false;
              const identity = pathKey(candidate.realPath, platform);
              if (seen.has(identity)) return false;
              seen.add(identity);
              return true;
            }),
            environment,
          );
        });

      if (pathOnly || windows) return yield* run();
      const latest = yield* shell.latest;
      if (latest?.status === "inherited") return yield* run();
      if (latest?.status === "captured") return yield* run(latest.environment);

      // Start recovery even if a known install can answer first. Its process belongs to
      // HostShellEnvironment, so returning here interrupts only this caller's wait.
      const pending = yield* Effect.forkScoped(shell.recover, { startImmediately: true });
      const known = yield* run();
      if (usable(known) && !recoveredEnvironment(yield* shell.latest)) return known;
      const login = recoveredEnvironment(yield* Fiber.join(pending));
      return login ? yield* run(login) : known;
    }).pipe(Effect.scoped);

  return {
    select,
    first: (request: SearchRequest) =>
      select(
        request,
        ([candidate], environment) =>
          Effect.succeed(candidate ? { ...candidate, environment } : undefined),
        (candidate) => candidate !== undefined,
      ),
  };
};
