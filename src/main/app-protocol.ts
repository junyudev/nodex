import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { net, protocol as electronProtocol, type Protocol, type Session } from "electron";
import { lookup as lookupMimeType } from "mime-types";
import {
  APP_FILESYSTEM_HOST,
  APP_FILESYSTEM_ORIGIN,
  APP_FILESYSTEM_PREFIX,
  APP_PROTOCOL_SCHEME,
  APP_RENDERER_ENTRY,
  APP_RENDERER_HOST,
  APP_RENDERER_ORIGIN,
  isAbsoluteAppFilesystemPath,
  restoreNativeAppFilesystemPath,
} from "../shared/app-protocol";

interface FileMetadata {
  readonly size: number;
  isFile(): boolean;
}

interface FileResponseDependencies {
  readonly createStream?: (
    filePath: string,
    options?: { readonly start: number; readonly end: number },
  ) => Readable;
  readonly lookupMimeType?: typeof lookupMimeType;
  readonly stat?: (filePath: string) => Promise<FileMetadata>;
}

interface AppRequestResolverDependencies {
  readonly lookupMimeType?: typeof lookupMimeType;
  readonly resolvePath?: (...paths: string[]) => string;
}

export interface AppProtocolHandlerOptions
  extends AppRequestResolverDependencies, FileResponseDependencies {
  readonly rendererRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly netFetch?: (url: string) => Promise<Response>;
  readonly getDevelopmentRendererUrl?: () => string | null;
}

export interface AppProtocolRegistrationOptions extends AppProtocolHandlerOptions {
  readonly getDevelopmentRendererUrl: () => string | null;
  readonly protocol?: Protocol;
}

const notFoundResponse = (): Response =>
  new Response(null, {
    status: 404,
    statusText: "Not Found",
  });

function streamBody(stream: Readable): BodyInit {
  return Readable.toWeb(stream) as unknown as BodyInit;
}

function extractRawAppPath(requestUrl: string): string | null {
  if (!requestUrl.startsWith("app://")) return null;
  const withoutScheme = requestUrl.slice("app://".length);
  const firstSlash = withoutScheme.indexOf("/");
  const rawPath = firstSlash >= 0 ? withoutScheme.slice(firstSlash) : "/";
  return rawPath.split("?")[0]?.split("#")[0] ?? null;
}

function containsDecodedTraversal(rawPath: string): boolean {
  return rawPath.split("/").some((segment) => segment === ".." || /^\.\.[. ]+$/u.test(segment));
}

function parseMediaPath(
  pathname: string,
  dependencies: AppRequestResolverDependencies = {},
): string | null {
  const encodedPath = pathname.slice(APP_FILESYSTEM_PREFIX.length);
  if (!encodedPath) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  const rendererPath = decodedPath.replaceAll("\\", "/");
  if (!isAbsoluteAppFilesystemPath(rendererPath)) return null;

  const resolvePath = dependencies.resolvePath ?? path.resolve;
  const resolvedPath = resolvePath(restoreNativeAppFilesystemPath(rendererPath));
  const mimeType = (dependencies.lookupMimeType ?? lookupMimeType)(resolvedPath);
  if (
    typeof mimeType !== "string" ||
    (!mimeType.startsWith("audio/") &&
      !mimeType.startsWith("image/") &&
      !mimeType.startsWith("video/"))
  ) {
    return null;
  }
  return resolvedPath;
}

export function resolveAppRequestPath(
  requestUrl: string,
  rendererRoot: string,
  dependencies: AppRequestResolverDependencies = {},
): string | null {
  const rawPath = extractRawAppPath(requestUrl);
  if (!rawPath) return null;

  try {
    if (containsDecodedTraversal(decodeURIComponent(rawPath).replaceAll("\\", "/"))) {
      return null;
    }
  } catch {
    return null;
  }

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_PROTOCOL_SCHEME}:`) return null;
  if (url.pathname.startsWith(APP_FILESYSTEM_PREFIX)) {
    return url.host === APP_FILESYSTEM_HOST ? parseMediaPath(url.pathname, dependencies) : null;
  }
  if (url.host && url.host !== APP_RENDERER_HOST) return null;

  const normalizedUrlPath = url.pathname.replaceAll("\\", "/");
  const relativeUrlPath = normalizedUrlPath.startsWith("/")
    ? normalizedUrlPath.slice(1)
    : normalizedUrlPath;
  const normalizedRelativePath = path.posix.normalize(relativeUrlPath);
  if (normalizedRelativePath === "." || normalizedRelativePath === "") {
    return path.join(rendererRoot, APP_RENDERER_ENTRY);
  }
  if (normalizedRelativePath.startsWith("..") || normalizedRelativePath.includes("/..")) {
    return null;
  }

  const candidate = path.join(rendererRoot, ...normalizedRelativePath.split("/"));
  const relative = path.relative(rendererRoot, candidate);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : candidate;
}

export function parseAppFilesystemUrl(
  requestUrl: string,
  dependencies: AppRequestResolverDependencies = {},
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${APP_PROTOCOL_SCHEME}:` ||
    url.host !== APP_FILESYSTEM_HOST ||
    !url.pathname.startsWith(APP_FILESYSTEM_PREFIX)
  ) {
    return null;
  }
  return parseMediaPath(url.pathname, dependencies);
}

function isAudioOrVideoPath(
  filePath: string,
  mimeLookup: typeof lookupMimeType = lookupMimeType,
): boolean {
  const mimeType = mimeLookup(filePath);
  return (
    typeof mimeType === "string" && (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))
  );
}

export async function createOrdinaryFileResponse(
  filePath: string,
  dependencies: FileResponseDependencies = {},
): Promise<Response> {
  const statFile = dependencies.stat ?? stat;
  let metadata: FileMetadata;
  try {
    metadata = await statFile(filePath);
  } catch {
    return notFoundResponse();
  }
  if (!metadata.isFile()) return notFoundResponse();

  const mimeType = (dependencies.lookupMimeType ?? lookupMimeType)(filePath);
  const createStream = dependencies.createStream ?? ((target) => createReadStream(target));
  return new Response(streamBody(createStream(filePath)), {
    headers: {
      "Content-Length": String(metadata.size),
      "Content-Type": typeof mimeType === "string" ? mimeType : "application/octet-stream",
    },
  });
}

export interface AppByteRange {
  readonly start: number;
  readonly end: number;
}

export function parseSingleByteRange(value: string, size: number): AppByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;

  if (startText === "") {
    const suffixLength = Number(endText);
    if (suffixLength <= 0 || size === 0) return null;
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);
  if (start < 0 || requestedEnd < start || start >= size) return null;
  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

export async function createRangeFileResponse(
  request: Request,
  filePath: string,
  dependencies: FileResponseDependencies = {},
): Promise<Response> {
  const statFile = dependencies.stat ?? stat;
  let metadata: FileMetadata;
  try {
    metadata = await statFile(filePath);
  } catch {
    return notFoundResponse();
  }
  if (!metadata.isFile()) return notFoundResponse();

  const mimeType = (dependencies.lookupMimeType ?? lookupMimeType)(filePath);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": typeof mimeType === "string" ? mimeType : "application/octet-stream",
  });
  const createStream: NonNullable<FileResponseDependencies["createStream"]> =
    dependencies.createStream ??
    ((target, options?) => createReadStream(target, options ? { ...options } : undefined));
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    headers.set("Content-Length", String(metadata.size));
    return new Response(streamBody(createStream(filePath)), { headers });
  }

  const range = parseSingleByteRange(rangeHeader, metadata.size);
  if (!range) {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers,
    });
  }

  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
  return new Response(streamBody(createStream(filePath, range)), {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

export function createAppProtocolHandler(
  options: AppProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  const mimeLookup = options.lookupMimeType ?? lookupMimeType;
  const platform = options.platform ?? process.platform;
  const netFetch = options.netFetch ?? ((url) => net.fetch(url));
  const fileDependencies: FileResponseDependencies = {
    createStream: options.createStream,
    lookupMimeType: mimeLookup,
    stat: options.stat,
  };

  const serve = async (request: Request): Promise<Response> => {
    const filePath = resolveAppRequestPath(request.url, options.rendererRoot, {
      lookupMimeType: mimeLookup,
      resolvePath: options.resolvePath,
    });
    if (!filePath) return notFoundResponse();
    if (isAudioOrVideoPath(filePath, mimeLookup)) {
      return await createRangeFileResponse(request, filePath, fileDependencies);
    }
    if (platform === "win32") return await netFetch(pathToFileURL(filePath).toString());
    return await createOrdinaryFileResponse(filePath, fileDependencies);
  };

  return async (request) => {
    const response = await serve(request);
    if (new URL(request.url).host !== APP_FILESYSTEM_HOST) return response;

    // The filesystem host is cross-origin even in a packaged app. Keep Fetch
    // and anonymous canvas images behind the same origin policy as the frame gate.
    const origin = request.headers.get("origin");
    if (
      !isAllowedAppFilesystemFrame(
        { url: origin ?? "" },
        options.getDevelopmentRendererUrl?.() ?? null,
      )
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin!);
    headers.set("Vary", "Origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function resolveFrameOrigin(frameUrl: string | null | undefined): string | null {
  if (frameUrl == null) return null;
  try {
    const url = new URL(frameUrl);
    return url.protocol === `${APP_PROTOCOL_SCHEME}:`
      ? `${APP_PROTOCOL_SCHEME}://${url.host}`
      : url.origin;
  } catch {
    return null;
  }
}

function resolveDevelopmentRendererOrigin(rendererUrl: string | null): string | null {
  if (rendererUrl == null || rendererUrl.trim().length === 0) return null;
  try {
    const url = new URL(rendererUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function isAllowedAppFilesystemFrame(
  frame: { readonly url: string } | null | undefined,
  developmentRendererUrl: string | null,
): boolean {
  const origin = resolveFrameOrigin(frame?.url);
  return (
    origin !== null &&
    (origin === APP_RENDERER_ORIGIN ||
      origin === resolveDevelopmentRendererOrigin(developmentRendererUrl))
  );
}

export function registerAppProtocol(
  electronSession: Session,
  options: AppProtocolRegistrationOptions,
): () => void {
  const targetProtocol = options.protocol ?? electronProtocol;
  const handler = createAppProtocolHandler(options);
  electronSession.webRequest.onBeforeRequest(
    { urls: [`${APP_FILESYSTEM_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        cancel: !isAllowedAppFilesystemFrame(details.frame, options.getDevelopmentRendererUrl()),
      });
    },
  );

  try {
    if (targetProtocol.isProtocolHandled(APP_PROTOCOL_SCHEME)) {
      targetProtocol.unhandle(APP_PROTOCOL_SCHEME);
    }
    targetProtocol.handle(APP_PROTOCOL_SCHEME, handler);
  } catch (error) {
    electronSession.webRequest.onBeforeRequest(null);
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    electronSession.webRequest.onBeforeRequest(null);
    if (targetProtocol.isProtocolHandled(APP_PROTOCOL_SCHEME)) {
      targetProtocol.unhandle(APP_PROTOCOL_SCHEME);
    }
  };
}
