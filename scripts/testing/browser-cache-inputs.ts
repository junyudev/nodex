import path from "node:path";
import { cleanId } from "./test-cache-inputs.ts";
import { relativeInput } from "./test-cache-policy.ts";

export interface BrowserCacheExclusion {
  readonly reason: string;
  readonly input?: string;
}

type Input =
  | { readonly kind: "file"; readonly input: string }
  | { readonly kind: "install" | "runtime" | "inline" | "typography" }
  | { readonly kind: "opaque"; readonly exclusion: BrowserCacheExclusion };

const opaque = (reason: string, input?: string): Input => ({
  kind: "opaque",
  exclusion: { reason, input },
});

export function browserFileId(id: string) {
  const clean = cleanId(id);
  if (!clean.startsWith("/@fs/")) return clean;
  return path.normalize(clean.slice("/@fs".length).replace(/^\/(?=[a-z]:\/)/iu, ""));
}

export function browserFileInput(
  id: string,
  {
    root,
    files,
    isOptimized,
  }: {
    readonly root: string;
    readonly files: ReadonlySet<string>;
    readonly isOptimized: (file: string) => boolean;
  },
): Input {
  const absolute = browserFileId(id);
  if (isOptimized(absolute)) return { kind: "install" };
  const virtual = absolute.replace(/^\/@id\/__x00__/u, "\0");
  if (
    /^\0(?:vitest\/browser|vitest\/mock|vitest\/browser\/context|rolldown\/runtime\.js)$/u.test(
      virtual,
    ) ||
    /^\0@oxc-project\+runtime@\d+\.\d+\.\d+\/helpers\/esm\/[\w-]+\.js$/u.test(virtual) ||
    /^(?:\/@vite\/(?:client|env)|\/@react-refresh)$/u.test(absolute)
  )
    return { kind: "runtime" };
  if (!path.isAbsolute(absolute)) return opaque("unknown Vite module", id);
  const file = relativeInput(root, absolute);
  if (file && files.has(file)) return { kind: "file", input: file };
  // Vite resolves installed packages to their real pnpm store files. Workspace
  // links are handled separately because they are not covered by the install.
  if (file?.startsWith("node_modules/.pnpm/")) return { kind: "install" };
  return opaque("unknown workspace input", file ?? id);
}

export function browserRequestInput(
  request: { readonly url: string; readonly method: string; readonly serviceWorker?: boolean },
  context: Parameters<typeof browserFileInput>[1] & {
    readonly origins: ReadonlySet<string>;
    readonly publicDir: string;
  },
): Input {
  const url = new URL(request.url);
  if (request.serviceWorker) return opaque("service worker");
  if (
    url.protocol === "data:" ||
    url.protocol === "blob:" ||
    url.href === "about:blank" ||
    url.href === "about:srcdoc"
  )
    return { kind: "inline" };
  // URL credentials and query parameters can contain secrets. Opaque network
  // requests report just the origin and path.
  const label =
    url.origin === "null"
      ? url.protocol + "//" + url.host + url.pathname
      : url.origin + url.pathname;
  if (!["GET", "HEAD"].includes(request.method)) return opaque("non-read browser request", label);
  if (!context.origins.has(url.origin)) return opaque("external browser request", label);

  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/typography-bootstrap.js") return { kind: "typography" };
  if (
    pathname === "/__vitest_test__/" ||
    pathname === "/__vitest_interception_probe__" ||
    pathname.startsWith("/__vitest_browser__/") ||
    pathname.startsWith("/__vitest__/") ||
    pathname === "/favicon.svg" ||
    (pathname === "/" && url.searchParams.has("sessionId"))
  )
    return { kind: "runtime" };
  if (pathname.startsWith("/@id/") || pathname.startsWith("/@fs/"))
    return browserFileInput(pathname, context);
  if (context.publicDir) {
    const publicFile = relativeInput(context.root, path.join(context.publicDir, pathname));
    if (publicFile && context.files.has(publicFile)) return { kind: "file", input: publicFile };
  }
  if (pathname.startsWith("/@vite/") || pathname === "/@react-refresh")
    return browserFileInput(pathname, context);
  const local = browserFileInput(path.join(context.root, pathname), context);
  // Vitest can import a test or its setup by absolute pathname through Vite.
  const absolute = pathname.replace(/^\/(?=[a-z]:\/)/iu, "");
  if (local.kind === "opaque" && path.isAbsolute(absolute) && relativeInput(context.root, absolute))
    return browserFileInput(path.normalize(absolute), context);
  return local;
}
