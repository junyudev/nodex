/// <reference types="vite/client" />

import type { VisualRewriteResult } from "../../../shared/visual/compiler";
import type { VisualRewrite } from "../../../shared/visual/contract";
import type {
  VisualInspection,
  VisualSourceRequest,
  VisualSourceResult,
} from "./visual-source-worker";

let compiler: ReturnType<typeof createCompilerWorker> | undefined;

function createCompilerWorker() {
  // Oxc's browser bindings use top-level await. A separate bundle keeps Rolldown's
  // common-chunk optimization enabled for the renderer's first paint.
  const worker = new Worker(new URL("./visual-source-worker.ts", import.meta.url), {
    type: "module",
  });
  const pending: {
    resolve: (result: VisualSourceResult) => void;
    reject: (error: Error) => void;
  }[] = [];

  let retired = false;
  const retire = (error: Error) => {
    if (retired) return;
    retired = true;
    compiler = undefined;
    worker.terminate();
    for (const { reject } of pending.splice(0)) reject(error);
  };

  // Requests share one compiler initialization and receive replies in submission order.
  worker.addEventListener("message", ({ data }: MessageEvent<VisualSourceResult>) =>
    pending.shift()?.resolve(data),
  );
  worker.addEventListener("error", (event) =>
    retire(new Error(event.message || "Visual compiler failed to load")),
  );
  worker.addEventListener("messageerror", () =>
    retire(new Error("Visual compiler returned an unreadable reply")),
  );

  return {
    retire,
    run(request: VisualSourceRequest) {
      return new Promise<VisualSourceResult>((resolve, reject) => {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The Worker instance is the recipient.
        worker.postMessage(request);
        pending.push({ resolve, reject });
      });
    },
  };
}

import.meta.hot?.dispose(() => compiler?.retire(new Error("Visual compiler reloaded")));

function requestSource(request: { kind: "inspect"; source: string }): Promise<VisualInspection>;
function requestSource(request: {
  kind: "rewrite";
  source: string;
  change: VisualRewrite;
}): Promise<VisualRewriteResult>;
function requestSource(request: VisualSourceRequest): Promise<VisualSourceResult> {
  return (compiler ??= createCompilerWorker()).run(request);
}

export async function inspectVisualSource(source: string) {
  return requestSource({ kind: "inspect", source });
}

export async function editVisualSource(source: string, change: VisualRewrite) {
  return requestSource({ kind: "rewrite", source, change });
}

export { refreshVisualQuery } from "./visual-adapter";
