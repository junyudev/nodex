import type { VisualRewriteResult } from "../../../shared/visual/compiler";
import type { VisualRewrite } from "../../../shared/visual/contract";

export type VisualSourceRequest =
  | { kind: "inspect"; source: string }
  | { kind: "rewrite"; source: string; change: VisualRewrite };

const loadCompiler = () => import("../../../shared/visual/browser");
type VisualCompiler = Awaited<ReturnType<typeof loadCompiler>>;
let compiler: ReturnType<typeof loadCompiler> | undefined;

function inspect({ compileVisual }: VisualCompiler, source: string) {
  const result = compileVisual(source);
  if (!result.ok) return result;
  return { ok: true as const, program: result.program, diagnostics: result.diagnostics };
}

export type VisualInspection = ReturnType<typeof inspect>;
export type VisualSourceResult = VisualInspection | VisualRewriteResult;

globalThis.addEventListener("message", ({ data }: MessageEvent<VisualSourceRequest>) => {
  // Register the listener before loading the bindings so their top-level await can't
  // leave the first request without a listener.
  void (compiler ??= loadCompiler())
    .then((loaded) => {
      const result =
        data.kind === "inspect"
          ? inspect(loaded, data.source)
          : loaded.rewriteVisual(data.source, data.change);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A dedicated worker can only reply to its owner.
      globalThis.postMessage(result);
    })
    .catch((error: unknown) => globalThis.reportError(error));
});
