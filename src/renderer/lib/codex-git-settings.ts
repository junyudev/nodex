import type { CodexGitSettings } from "./types";
import { invokeRendererQuery } from "./renderer-command";

/** Reads the Main-owned Git settings snapshot. */
export function readCodexGitSettings(): Promise<CodexGitSettings> {
  return invokeRendererQuery("settings:git:get");
}
