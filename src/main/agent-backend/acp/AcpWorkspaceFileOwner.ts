import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { acpRuntimeError, type AcpRuntimeError } from "./AcpRuntimeError";

export const ACP_DEFAULT_FILE_BYTE_LIMIT = 4 * 1024 * 1024;

export class AcpWorkspaceFileOwner extends Context.Service<
  AcpWorkspaceFileOwner,
  {
    readonly workspaceRoot: string;
    readonly readTextFile: (
      request: ReadTextFileRequest,
    ) => Effect.Effect<ReadTextFileResponse, AcpRuntimeError>;
    readonly writeTextFile: (
      request: WriteTextFileRequest,
    ) => Effect.Effect<WriteTextFileResponse, AcpRuntimeError>;
    readonly resolveDirectory: (
      path: string | null | undefined,
    ) => Effect.Effect<string, AcpRuntimeError>;
  }
>()("nodex/main/agent-backend/acp/AcpWorkspaceFileOwner") {}

export interface AcpWorkspaceFileOwnerOptions {
  readonly workspaceRoot: string;
  readonly maximumFileBytes?: number;
}

const isInside = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

const fail = (operation: string, reason: "authorization" | "protocol", cause: unknown) =>
  acpRuntimeError({ operation, reason, retryable: false, cause });

const validatePositiveInteger = (value: number, label: string): number => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new RangeError(`${label} must be a positive safe integer`);
};

const assertNoSymlinkComponents = async (
  root: string,
  target: string,
  allowMissingFinal: boolean,
): Promise<void> => {
  const fromRoot = relative(root, target);
  const parts = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index] ?? "");
    const metadata = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (allowMissingFinal && index === parts.length - 1 && cause.code === "ENOENT") return null;
      throw cause;
    });
    if (metadata === null) return;
    if (metadata.isSymbolicLink())
      throw new Error(`ACP workspace path contains a symlink: ${current}`);
  }
};

const sliceLines = (
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
) => {
  const startLine = line ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new RangeError("ACP read line must be a positive safe integer");
  }
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError("ACP read limit must be a non-negative safe integer");
  }
  if (startLine === 1 && (limit === undefined || limit === null)) return content;
  const lines = content.split("\n");
  return lines
    .slice(startLine - 1, limit === undefined || limit === null ? undefined : startLine - 1 + limit)
    .join("\n");
};

export const live = (
  options: AcpWorkspaceFileOwnerOptions,
): Layer.Layer<AcpWorkspaceFileOwner, AcpRuntimeError> =>
  Layer.effect(
    AcpWorkspaceFileOwner,
    Effect.tryPromise({
      try: async () => {
        const configuredRoot = resolve(options.workspaceRoot);
        const canonicalRoot = await realpath(configuredRoot);
        const rootStats = await stat(canonicalRoot);
        if (!rootStats.isDirectory()) throw new Error("ACP workspace root must be a directory");
        const maximumFileBytes = validatePositiveInteger(
          options.maximumFileBytes ?? ACP_DEFAULT_FILE_BYTE_LIMIT,
          "ACP maximum file bytes",
        );

        const resolveOwnedPath = (requestedPath: string): string => {
          if (!isAbsolute(requestedPath)) throw new Error("ACP filesystem paths must be absolute");
          const absolute = resolve(requestedPath);
          const lexicalRoot = isInside(configuredRoot, absolute)
            ? configuredRoot
            : isInside(canonicalRoot, absolute)
              ? canonicalRoot
              : null;
          if (lexicalRoot === null)
            throw new Error("ACP filesystem path escapes the workspace root");
          return resolve(canonicalRoot, relative(lexicalRoot, absolute));
        };

        const resolveDirectory = async (
          requestedPath: string | null | undefined,
        ): Promise<string> => {
          const target = resolveOwnedPath(requestedPath ?? canonicalRoot);
          await assertNoSymlinkComponents(canonicalRoot, target, false);
          const canonicalTarget = await realpath(target);
          if (!isInside(canonicalRoot, canonicalTarget))
            throw new Error("ACP directory escapes the workspace root");
          const metadata = await stat(canonicalTarget);
          if (!metadata.isDirectory()) throw new Error("ACP terminal cwd must be a directory");
          return canonicalTarget;
        };

        return AcpWorkspaceFileOwner.of({
          workspaceRoot: canonicalRoot,
          readTextFile: (request) =>
            Effect.tryPromise({
              try: async () => {
                const target = resolveOwnedPath(request.path);
                await assertNoSymlinkComponents(canonicalRoot, target, false);
                const canonicalTarget = await realpath(target);
                if (!isInside(canonicalRoot, canonicalTarget))
                  throw new Error("ACP read escapes the workspace root");
                const handle = await open(
                  canonicalTarget,
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                );
                try {
                  const metadata = await handle.stat();
                  if (!metadata.isFile()) throw new Error("ACP read target must be a regular file");
                  if (metadata.size > maximumFileBytes)
                    throw new Error("ACP read exceeds the file byte limit");
                  const content = await handle.readFile("utf8");
                  return { content: sliceLines(content, request.line, request.limit) };
                } finally {
                  await handle.close();
                }
              },
              catch: (cause) => fail("capability.fs.read", "authorization", cause),
            }),
          writeTextFile: (request) =>
            Effect.tryPromise({
              try: async () => {
                if (Buffer.byteLength(request.content, "utf8") > maximumFileBytes) {
                  throw new Error("ACP write exceeds the file byte limit");
                }
                const target = resolveOwnedPath(request.path);
                await assertNoSymlinkComponents(canonicalRoot, target, true);
                const handle = await open(
                  target,
                  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
                  0o600,
                );
                try {
                  const metadata = await handle.stat();
                  if (!metadata.isFile())
                    throw new Error("ACP write target must be a regular file");
                  await handle.writeFile(request.content, "utf8");
                } finally {
                  await handle.close();
                }
                return {};
              },
              catch: (cause) => fail("capability.fs.write", "authorization", cause),
            }),
          resolveDirectory: (path) =>
            Effect.tryPromise({
              try: () => resolveDirectory(path),
              catch: (cause) => fail("capability.terminal.cwd", "authorization", cause),
            }),
        });
      },
      catch: (cause) => fail("capability.fs.configure", "protocol", cause),
    }),
  );
