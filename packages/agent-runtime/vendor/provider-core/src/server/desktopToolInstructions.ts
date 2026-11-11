import type { ProviderAdapterV2TurnMessage } from "./ProviderAdapter.ts";
import type { McpProviderDesktopTools, McpProviderDesktopToolSkill } from "./mcpSession.ts";

/**
 * The skills name the REPL tool the way one client spells it. Every other client needs that
 * name tied to its own before the skill text makes sense.
 */
const toolNaming = (jsToolName: string) =>
  `Desktop skills call the JavaScript tool \`mcp__node_repl__js\`. Here that is ${jsToolName}; its state persists between calls.`;

/**
 * What an Agent needs to use the host's Desktop Tools when its provider cannot load the skills
 * itself: where each skill is, when to read it, and what the REPL tool is called here.
 */
export function desktopToolInstructions(
  desktopTools: McpProviderDesktopTools | undefined,
  input: {
    /** How this provider shows the tool to its model, for example "`node_repl_js`". */
    readonly jsToolName: string;
    /** Providers that load the skills natively only need the tool's name. */
    readonly nativeSkills: boolean;
  },
): string | undefined {
  if (desktopTools === undefined || desktopTools.skills.length === 0) return undefined;
  if (input.nativeSkills) return toolNaming(input.jsToolName);
  return [
    "## Desktop skills",
    "",
    "This app can control its in-app Browser and other desktop surfaces for you. Each skill below is a file of instructions. When a request needs one, read the whole file first and follow it; do not guess its API.",
    "",
    ...desktopTools.skills.map(
      (skill) => `- \`${skill.name}\` (${skill.path}): ${skill.description}`,
    ),
    "",
    toolNaming(input.jsToolName),
  ].join("\n");
}

/** Resolve a picker selection only against the ready skills of the current provider session. */
export function selectedDesktopSkill(
  tools: McpProviderDesktopTools | undefined,
  selection: NonNullable<ProviderAdapterV2TurnMessage["skillInvocations"]>[number],
  instanceId: string,
): McpProviderDesktopToolSkill | undefined {
  if (selection.instanceId !== instanceId) return undefined;
  return tools?.skills.find(({ name, path }) => name === selection.name && path === selection.path);
}

export function invokeDesktopSkillInstructions(
  skills: ReadonlyArray<McpProviderDesktopToolSkill>,
  jsToolName: string,
): string | undefined {
  if (!skills.length) return undefined;
  return [
    ...skills.map(({ name, path }) => `Use the \`${name}\` skill for this message. Read the whole file at \`${path}\` first and follow its instructions.`),
    toolNaming(jsToolName),
  ].join("\n\n");
}
