import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { acpRuntimeError, type AcpRuntimeError } from "../../agent-backend/acp/AcpRuntimeError";

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

export interface AcpNodePackageProbeRequest {
  readonly packageRoot: string;
  readonly expectedPackageName: string;
  readonly expectedPackageVersion: string;
  readonly entryRelativePath: string;
  readonly nodeExecutable: string;
  readonly minimumNodeMajor: number;
  readonly timeoutMs?: number;
}

export interface AcpNodePackageProbeResult {
  readonly packageRoot: string;
  readonly entryPath: string;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
  readonly agentVersion: string;
}

export class AcpAgentLaunchProbe extends Context.Service<
  AcpAgentLaunchProbe,
  {
    /** Checks protocol compatibility for user-authorized local code; it does not attest its bytes. */
    readonly probeUserManagedNodePackage: (
      request: AcpNodePackageProbeRequest,
    ) => Effect.Effect<AcpNodePackageProbeResult, AcpRuntimeError>;
    readonly canonicalDirectory: (path: string) => Effect.Effect<string, AcpRuntimeError>;
  }
>()("nodex/main/platform/node/AcpAgentLaunchProbe") {}

const isInside = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

const run = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}): Effect.Effect<string, AcpRuntimeError> =>
  Effect.callback<string, AcpRuntimeError>((resume) => {
    const child = execFile(
      input.command,
      [...input.args],
      {
        timeout: input.timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {},
      },
      (cause, stdout, stderr) => {
        if (cause === null) {
          resume(Effect.succeed(stdout.trim()));
          return;
        }
        resume(
          Effect.fail(
            acpRuntimeError({
              operation: "agent.probe",
              reason: "spawn",
              retryable: false,
              cause: new Error(`${cause.message}${stderr ? `: ${stderr.trim()}` : ""}`, {
                cause,
              }),
            }),
          ),
        );
      },
    );
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  });

const platformFailure = (operation: string, cause: unknown): AcpRuntimeError =>
  acpRuntimeError({ operation, reason: "spawn", retryable: false, cause });

export const makeAcpAgentLaunchProbe = AcpAgentLaunchProbe.of({
  canonicalDirectory: (path) =>
    Effect.tryPromise({
      try: () =>
        realpath(path).then((canonical) =>
          stat(canonical).then((metadata) => {
            if (!metadata.isDirectory()) throw new Error(`Expected a directory: ${path}`);
            return canonical;
          }),
        ),
      catch: (cause) => platformFailure("agent.directory", cause),
    }),
  probeUserManagedNodePackage: Effect.fn("AcpAgentLaunchProbe.probeUserManagedNodePackage")(
    function* (request) {
      const timeoutMs = request.timeoutMs ?? 5_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return yield* platformFailure("agent.probe.configure", new RangeError("Invalid timeout"));
      }
      const packageRoot = yield* Effect.tryPromise({
        try: () =>
          realpath(request.packageRoot).then((root) =>
            stat(root).then((metadata) => {
              if (!metadata.isDirectory())
                throw new Error("ACP agent package root must be a directory");
              return root;
            }),
          ),
        catch: (cause) => platformFailure("agent.package-root", cause),
      });
      const manifestSource = yield* Effect.tryPromise({
        try: () => readFile(join(packageRoot, "package.json"), "utf8"),
        catch: (cause) => platformFailure("agent.package-manifest", cause),
      });
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(PackageManifest))(
        manifestSource,
      ).pipe(Effect.mapError((cause) => platformFailure("agent.package-manifest", cause)));
      if (
        manifest.name !== request.expectedPackageName ||
        manifest.version !== request.expectedPackageVersion
      ) {
        return yield* platformFailure(
          "agent.package-identity",
          new Error(`Unexpected ACP package ${manifest.name}@${manifest.version}`),
        );
      }
      const entryPath = yield* Effect.tryPromise({
        try: () =>
          realpath(join(packageRoot, request.entryRelativePath)).then((entry) => {
            if (!isInside(packageRoot, entry))
              throw new Error("ACP package entry escapes its root");
            return stat(entry).then((metadata) => {
              if (!metadata.isFile()) throw new Error("ACP package entry must be a regular file");
              return entry;
            });
          }),
        catch: (cause) => platformFailure("agent.package-entry", cause),
      });
      const nodeExecutable = yield* Effect.tryPromise({
        try: () =>
          realpath(request.nodeExecutable).then((executable) =>
            stat(executable).then((metadata) => {
              if (!metadata.isFile()) throw new Error("Node executable must be a regular file");
              return access(executable, constants.X_OK).then(() => executable);
            }),
          ),
        catch: (cause) => platformFailure("agent.node-executable", cause),
      });
      const nodeVersion = yield* run({
        command: nodeExecutable,
        args: ["--version"],
        timeoutMs,
      });
      const nodeMajor = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
      if (!Number.isSafeInteger(nodeMajor) || nodeMajor < request.minimumNodeMajor) {
        return yield* platformFailure(
          "agent.node-version",
          new Error(`ACP agent requires Node >=${request.minimumNodeMajor}; found ${nodeVersion}`),
        );
      }
      const agentVersion = yield* run({
        command: nodeExecutable,
        args: [entryPath, "--version"],
        timeoutMs,
      });
      if (agentVersion !== request.expectedPackageVersion) {
        return yield* platformFailure(
          "agent.package-version",
          new Error(`ACP executable reported ${agentVersion}`),
        );
      }
      return { packageRoot, entryPath, nodeExecutable, nodeVersion, agentVersion };
    },
  ),
});

export const live: Layer.Layer<AcpAgentLaunchProbe> = Layer.succeed(
  AcpAgentLaunchProbe,
  makeAcpAgentLaunchProbe,
);
