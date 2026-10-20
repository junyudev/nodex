import path from "node:path";
import { prepareElectronRuntime } from "./prepare-electron-runtime";

void prepareElectronRuntime({ projectRoot: path.resolve(import.meta.dirname, "..") }).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
