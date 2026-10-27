import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type WorkspacePdfRuntime = typeof import("pdfjs-dist") &
  typeof import("./workspace-pdf-link-service");

let runtimePromise: Promise<WorkspacePdfRuntime> | null = null;
let workerConfigured = false;

/** PDF.js is a large, preview-only runtime, so keep it out of the initial renderer chunk. */
export async function loadWorkspacePdfRuntime(): Promise<WorkspacePdfRuntime> {
  if (typeof window === "undefined") throw new Error("PDF.js requires a browser runtime");
  runtimePromise ??= import("pdfjs-dist").then(async (pdf) => {
    // The viewer helpers read pdfjsLib installed by the core module at evaluation time.
    const links = await import("./workspace-pdf-link-service");
    return { ...pdf, ...links };
  });
  const runtime = await runtimePromise;
  if (!workerConfigured || runtime.GlobalWorkerOptions.workerSrc !== pdfWorkerUrl) {
    runtime.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerConfigured = true;
  }
  return runtime;
}
