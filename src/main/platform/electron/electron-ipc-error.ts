import { readActionableErrorMessage } from "../../actionable-error-message";

/** Electron serializes only the rejection Error message across `ipcRenderer.invoke`. */
export function toElectronIpcRendererError(cause: unknown): Error {
  const message = readActionableErrorMessage(cause, {
    fallback: "The requested operation could not be completed",
    maximumLength: 1_000,
  });
  return new Error(message, { cause });
}
