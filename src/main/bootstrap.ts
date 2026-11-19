import { registerNodexPrivilegedSchemes } from "./privileged-schemes";
import { app } from "electron";
import { runVisualWorker } from "./visual/visual-worker-entry";

if (process.argv.includes("--nodex-visual-worker")) {
  runVisualWorker();
} else {
  registerNodexPrivilegedSchemes();
  void import("./desktop-bootstrap").catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
}
