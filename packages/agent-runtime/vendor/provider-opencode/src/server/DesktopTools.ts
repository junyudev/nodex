import { desktopToolInstructions } from "@nodex/provider-core/server/desktopToolInstructions";
import type { McpProviderDesktopTools } from "@nodex/provider-core/server/mcpSession";
import { readToolOutputImage } from "@nodex/runtime-shared/toolOutput";
import { skillPaths } from "./NativeExecutionPlugin.ts";

export { invokeDesktopSkillInstructions, selectedDesktopSkill } from "@nodex/provider-core/server/desktopToolInstructions";

export const DESKTOP_MCP_SERVER = "node_repl";
export const DESKTOP_TOOL_TIMEOUT_MS = 65 * 60_000;

export function instructions(
  tools: McpProviderDesktopTools | undefined,
  server: string,
  loadedSkillPaths: ReadonlyArray<string>,
): string | undefined {
  if (tools === undefined) return undefined;
  const paths = skillPaths(tools.pluginRoots);
  return desktopToolInstructions(tools, {
    jsToolName: `\`${server}_js\``,
    nativeSkills:
      paths.length > 0 && paths.every((path) => loadedSkillPaths.includes(path)),
  });
}

/** OpenCode returns MCP images as inline file parts. Preserve their bytes in the transcript. */
export function toolOutput(
  text: string | undefined,
  files: ReadonlyArray<{ readonly mime: string; readonly url: string }>,
) {
  const images = files.flatMap(({ mime, url }) => {
    const prefix = `data:${mime};base64,`;
    if (!url.startsWith(prefix)) return [];
    const image = { type: "image" as const, mimeType: mime, data: url.slice(prefix.length) };
    return readToolOutputImage(image) ? [image] : [];
  });
  if (images.length === 0) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}
