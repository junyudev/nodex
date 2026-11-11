/* @effect-diagnostics asyncFunction:off -- Bridges the cancellable runtime loader to native inspection. */
import type * as Effect from "effect/Effect";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WindowsBrowserRuntimeVerifierPort } from "../../codex/browser-runtime-windows-verifier-port";
import {
  hasTrustedWindowsOwner,
  type WindowsDesktopToolsService,
  type PathSecurity,
} from "./WindowsDesktopTools";
import { verifyRuntimeArtifacts } from "./RuntimeArtifactVerification";

function pathRejection(security: PathSecurity): string | null {
  if (security.reparsePoint) return "is a reparse point";
  if (!hasTrustedWindowsOwner(security)) return "has an untrusted owner";
  if (security.grantsForeignWrite) return "grants write access to an untrusted principal";
  return null;
}

export function makeWindowsBrowserRuntimeVerifier(
  native: WindowsDesktopToolsService,
  installBoundary: string,
  runNative: typeof Effect.runPromise,
): WindowsBrowserRuntimeVerifierPort {
  return {
    async verifyClosurePaths(root, signal) {
      const relative = path.relative(installBoundary, root);
      if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
        return { ok: false, reason: "Desktop Tool closure is outside the installation boundary" };

      const inspect = async (paths: string[]) => {
        const results = await runNative(native.inspectPaths(paths), { signal });
        for (const [index, security] of results.entries()) {
          const reason = pathRejection(security);
          if (reason) throw new Error(`Desktop Tool path ${paths[index]} ${reason}`);
        }
      };
      try {
        let ancestor = installBoundary;
        await inspect([ancestor]);
        for (const component of relative.split(path.sep).filter(Boolean)) {
          ancestor = path.join(ancestor, component);
          await inspect([ancestor]);
        }
        // Inspect each directory before traversing it, including junctions that lstat
        // might otherwise mistake for an ordinary directory.
        let directories = [root];
        let count = 1;
        while (directories.length > 0) {
          const next: string[] = [];
          const batches = await verifyRuntimeArtifacts(
            directories,
            async (directory) => {
              const entries = await readdir(directory, { withFileTypes: true });
              count += entries.length;
              if (count > 50_000) throw new Error("Desktop Tool closure path limit exceeded");
              return entries.map((entry) => ({
                path: path.join(directory, entry.name),
                directory: entry.isDirectory(),
              }));
            },
            signal,
          );
          const entries = batches.flat();
          const chunks = [];
          for (let offset = 0; offset < entries.length; offset += 64)
            chunks.push(entries.slice(offset, offset + 64).map((entry) => entry.path));
          await verifyRuntimeArtifacts(chunks, inspect, signal);
          for (const entry of entries) if (entry.directory) next.push(entry.path);
          directories = next;
        }
        return { ok: true, value: undefined };
      } catch (error) {
        signal?.throwIfAborted();
        return { ok: false, reason: nativeFailure(error) };
      }
    },
    async verifyAuthenticode(file, policy, signal) {
      try {
        const signed = await runNative(native.verifyAuthenticode(file, true), { signal });
        if (signed.status === "rejected")
          return { ok: false, reason: `Authenticode ${signed.signature}: ${signed.trustStatus}` };
        if (signed.revocation === "cacheUnavailable")
          return { ok: false, reason: "Authenticode chain revocation could not be established" };
        if (!signed.codeSigningEku)
          return { ok: false, reason: "Authenticode signer lacks a code-signing EKU" };
        const signer = signed.chain[0];
        if (!signer || signer.subject !== policy.subject || signer.issuer !== policy.issuer)
          return {
            ok: false,
            reason: "Authenticode publisher or issuer does not match the manifest",
          };
        return { ok: true, value: signer };
      } catch (error) {
        signal?.throwIfAborted();
        return { ok: false, reason: nativeFailure(error) };
      }
    },
  };
}

function nativeFailure(error: unknown): string {
  if (typeof error === "object" && error && "operation" in error)
    return `Windows Desktop Tools ${String(error.operation)} failed: ${String("cause" in error ? error.cause : error)}`;
  return String(error);
}
