import path from "node:path";

import {
  collectRendererCommandInventory,
  rendererCommandBoundaryDiagnostics,
  rendererCommandInventoryReport,
} from "./renderer-command-boundaries";

const projectRoot = path.resolve(import.meta.dirname, "../..");

const inventory = collectRendererCommandInventory(projectRoot);

if (process.argv.includes("--inventory")) {
  process.stdout.write(rendererCommandInventoryReport(inventory));
} else {
  const diagnostics = rendererCommandBoundaryDiagnostics(inventory);
  if (diagnostics.length > 0) {
    throw new Error(
      [
        "Renderer command boundary verification failed:",
        ...diagnostics.map(
          (diagnostic) =>
            `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${diagnostic.message}`,
        ),
      ].join("\n- "),
    );
  }

  const counts = inventory.occurrenceCounts;
  console.log(
    [
      `Renderer command boundaries verified across ${inventory.ipcApiEndpointCount} IPC endpoints.`,
      `${counts["renderer-leaf-raw-invoke-import"] + counts["renderer-raw-invoke-import"]} raw invoke imports,`,
      `${counts["renderer-leaf-raw-invoke-call"] + counts["renderer-raw-invoke-call"]} raw invoke calls,`,
      `${counts["renderer-direct-preload-invoke"]} direct preload calls,`,
      `${counts["renderer-local-commit-admission"]} LocalCommit admissions,`,
      `${counts["main-ipc-handle-wrapper"]} raw Main handle wrappers, and`,
      `${counts["main-ipc-handle-registration"]} raw Main handle registrations.`,
    ].join(" "),
  );
}
