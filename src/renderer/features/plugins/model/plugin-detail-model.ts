import { formatCodexMcpVisualSourceName } from "../../../../shared/codex-mcp-tool-call";
import type { PluginDetailView, PluginRow } from "../plugin-management";

type DescribedPlugin = Pick<PluginDetailView, "summary" | "description">;

function firstText(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** The one line under a plugin's name: its short description, else its longer text. */
export function pluginTagline(plugin: DescribedPlugin): string | null {
  const meta = plugin.summary.interface;
  return firstText(meta?.shortDescription, plugin.description, meta?.longDescription);
}

/**
 * The long description shown below the starter prompts, or null when it would only repeat the
 * tagline.
 */
export function pluginLongDescription(plugin: DescribedPlugin): string | null {
  const meta = plugin.summary.interface;
  const description = firstText(meta?.longDescription, plugin.description, meta?.shortDescription);
  return description === pluginTagline(plugin) ? null : description;
}

/** The plugin's starter prompts, trimmed, without blanks. */
export function pluginStarterPrompts(plugin: Pick<PluginDetailView, "summary">): string[] {
  return (plugin.summary.interface?.defaultPrompt ?? [])
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0);
}

/** "By {developer} • {tagline}", either half alone, or null when both are missing. */
export function pluginDeveloperSubtitle(
  developerName: string | null | undefined,
  tagline: string | null | undefined,
): string | null {
  const developer = developerName?.trim();
  if (developer && tagline) return `By ${developer} • ${tagline}`;
  if (developer) return `By ${developer}`;
  return tagline || null;
}

/** Why a plugin can't be used, as its short label. */
export function pluginDisabledReasonLabel(
  reason: PluginRow["summary"]["disabledReason"],
  fallback: string,
): string {
  switch (reason) {
    case "plan_not_eligible":
      return "Not available on your plan";
    case "required_app_unavailable":
      return "Required app unavailable";
    case "unknown":
      return "Unavailable";
    default:
      return fallback;
  }
}

/** The detail page's main action, in priority order. */
export type PluginPrimaryAction =
  | "uninstalling"
  | "installing"
  | "disabled_by_admin"
  | "unavailable"
  | "install"
  | "enable"
  | "try";

export function pluginPrimaryAction(input: {
  readonly row: Pick<PluginRow, "summary" | "actionState">;
  readonly pending: "installing" | "uninstalling" | undefined;
}): PluginPrimaryAction {
  const { row, pending } = input;
  if (pending === "uninstalling") return "uninstalling";
  if (pending === "installing") return "installing";
  if (row.summary.availability === "DISABLED_BY_ADMIN") return "disabled_by_admin";
  if (!row.summary.installed) return row.actionState === "unavailable" ? "unavailable" : "install";
  return row.summary.enabled ? "try" : "enable";
}

/** Which data-sharing notice the page ends with, from how many apps the plugin connects. */
export function pluginLegalNoticeVariant(appCount: number): "none" | "single" | "multiple" {
  if (appCount === 0) return "none";
  return appCount === 1 ? "single" : "multiple";
}

const GOOGLE_CONNECTOR_IDS = new Set([
  "connector_gmail",
  "connector_google_bigquery",
  "connector_google_calendar",
  "connector_google_contacts",
  "connector_google_docs",
  "connector_google_drive",
  "connector_google_sheets",
  "connector_google_slides",
]);

/** Whether any included app is a Google app, which adds Google's data note. */
export function includesGoogleApp(apps: ReadonlyArray<{ readonly id: string }>): boolean {
  return apps.some((app) => GOOGLE_CONNECTOR_IDS.has(app.id));
}

/** How many included rows show before the rest fold behind "See …". */
export const INCLUDED_ITEMS_VISIBLE_LIMIT = 5;

/**
 * The label of the row that reveals folded items: the next names when known ("See A, B, and 3
 * more"), else a count ("Show 3 more").
 */
export function includedItemsShowMoreLabel(
  hiddenLabels: readonly string[] | null,
  hiddenCount: number,
): string {
  if (hiddenLabels == null) return `Show ${hiddenCount} more`;
  const names = hiddenLabels.slice(0, 2).join(", ");
  const remaining = Math.max(hiddenCount - 2, 0);
  return remaining === 0 ? `See ${names}` : `See ${names}, and ${remaining} more`;
}

/** A skill's name for people: its display name, else its last name segment humanized. */
export function skillDisplayName(skill: {
  readonly name: string;
  readonly interface?: { readonly displayName?: string } | null;
}): string {
  const display = skill.interface?.displayName?.trim();
  if (display) return display;
  return formatCodexMcpVisualSourceName(skill.name.split(":").pop() || skill.name);
}

/** A skill's one-line description: its short description, else its description. */
export function skillShortDescription(skill: {
  readonly description: string;
  readonly shortDescription: string | null;
  readonly interface?: { readonly shortDescription?: string } | null;
}): string {
  const short = skill.interface?.shortDescription;
  if (short != null && short.trim().length > 0) return short;
  return skill.shortDescription ?? skill.description;
}

/**
 * A plugin description reduced to inline Markdown: images and HTML are dropped, headings and
 * rules become plain paragraphs, and task-list boxes become literal text.
 */
export function sanitizePluginDescription(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/gm, "$1")
    .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(
      /^(\s*[-*+]\s+)\[([ xX])\]\s+/gm,
      (_match, bullet: string, mark: string) => `${bullet}\\[${mark === " " ? " " : "x"}\\] `,
    )
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .trim();
}

/** Drops a leading `---` front-matter block. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown;
  const rest = markdown.slice(end + 4);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

/**
 * A SKILL.md body as previewed under its own title: without front matter and without the
 * leading `# Title` line (and the blank lines after it) that would repeat the dialog title.
 */
export function skillMarkdownBody(contents: string): string {
  const body = stripFrontmatter(contents.replace(/\r\n/g, "\n"));
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first === -1 || !/^#\s/.test(lines[first]!.trim())) return body.trimStart();
  let next = first + 1;
  while (next < lines.length && lines[next]!.trim().length === 0) next += 1;
  return lines.slice(next).join("\n");
}
