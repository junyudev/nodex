import type { CodexMcpToolCallView, ProtocolAppInfo } from "../../../../lib/types";
import { resolveCodexMcpAppInfo } from "../../../../../shared/codex-mcp-tool-call";
import { asRecord, humanizeIdentifier, resolveScriptToolTitle } from "./tool-call-utils";

const MCP_TOOL_NAME_ACRONYMS: Readonly<Record<string, string>> = {
  api: "API",
  cdp: "CDP",
  cli: "CLI",
  css: "CSS",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  js: "JS",
  json: "JSON",
  mcp: "MCP",
  pr: "PR",
  sql: "SQL",
  ui: "UI",
  uri: "URI",
  url: "URL",
  xml: "XML",
};

type McpActivityVerb = {
  active: string;
  completed: string;
};

const MCP_ACTIVITY_VERBS: Readonly<Record<string, McpActivityVerb>> = {
  add: { active: "Adding", completed: "Added" },
  check: { active: "Checking", completed: "Checked" },
  create: { active: "Creating", completed: "Created" },
  delete: { active: "Deleting", completed: "Deleted" },
  deploy: { active: "Deploying", completed: "Deployed" },
  download: { active: "Downloading", completed: "Downloaded" },
  duplicate: { active: "Duplicating", completed: "Duplicated" },
  fetch: { active: "Fetching", completed: "Fetched" },
  get: { active: "Getting", completed: "Got" },
  import: { active: "Importing", completed: "Imported" },
  list: { active: "Listing", completed: "Listed" },
  move: { active: "Moving", completed: "Moved" },
  open: { active: "Opening", completed: "Opened" },
  query: { active: "Querying", completed: "Queried" },
  read: { active: "Reading", completed: "Read" },
  search: { active: "Searching", completed: "Searched" },
  send: { active: "Sending", completed: "Sent" },
  update: { active: "Updating", completed: "Updated" },
  upload: { active: "Uploading", completed: "Uploaded" },
};

const MCP_CONTEXT_ARGUMENT_KEYS = ["query", "title", "name", "target", "project", "url"] as const;

export function formatMcpServerName(server: string): string {
  const humanized = humanizeIdentifier(server);
  return humanized.length > 0 ? humanized : "MCP";
}

function splitMcpIdentifierParts(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((part) => part.length > 0);
}

function sentenceCaseMcpToolParts(parts: readonly string[]): string {
  if (parts.length === 0) return "MCP tool";

  return parts
    .map((part, index) => {
      const acronym = MCP_TOOL_NAME_ACRONYMS[part];
      if (acronym) return acronym;
      if (index > 0) return part;
      return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
    })
    .join(" ");
}

function tokenSequencesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function mergeTokenSuffix(tokens: readonly string[], suffix: readonly string[]): string[] {
  const overlapLimit = Math.min(tokens.length, suffix.length);
  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    const tail = tokens.slice(tokens.length - overlap);
    const head = suffix.slice(0, overlap);
    if (tokenSequencesEqual(tail, head)) {
      return [...tokens, ...suffix.slice(overlap)];
    }
  }
  return [...tokens, ...suffix];
}

function collectMcpAppAliases(app: ProtocolAppInfo): string[][] {
  const baseAliases = [
    splitMcpIdentifierParts(app.name),
    splitMcpIdentifierParts(app.id),
    splitMcpIdentifierParts(app.id.replace(/^connector[_-]/i, "")),
    ...app.pluginDisplayNames.map(splitMcpIdentifierParts),
  ].filter((tokens) => tokens.length > 0);
  const aliases = baseAliases.flatMap((tokens) => [
    tokens,
    mergeTokenSuffix(tokens, ["mcp"]),
    mergeTokenSuffix(tokens, ["mcp", "server"]),
  ]);
  return aliases
    .filter(
      (tokens, index) =>
        aliases.findIndex((candidate) => tokenSequencesEqual(candidate, tokens)) === index,
    )
    .sort((left, right) => right.length - left.length);
}

function stripMcpAppPrefix(toolName: string, app: ProtocolAppInfo | null): string[] {
  const toolParts = splitMcpIdentifierParts(toolName);
  if (!app) return toolParts;

  const aliases = collectMcpAppAliases(app);
  let stripped = toolParts;
  while (stripped.length > 0) {
    const matchingAlias = aliases.find(
      (alias) =>
        stripped.length >= alias.length && alias.every((part, index) => stripped[index] === part),
    );
    if (!matchingAlias) break;
    stripped = stripped.slice(matchingAlias.length);
  }
  return stripped.length > 0 ? stripped : toolParts;
}

function resolveReadableMcpArgument(argumentsValue: unknown): string | null {
  const record = asRecord(argumentsValue);
  if (!record) return null;

  for (const key of MCP_CONTEXT_ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized.length === 0 || normalized.length > 80) continue;
    return normalized;
  }
  return null;
}

/**
 * Resolve the rich app-aware phrase used by an MCP activity header.
 *
 * The resolution order intentionally mirrors the desktop client: an explicit
 * JS title wins, then a registered app operation may describe active versus
 * completed work, browser source metadata supplies its own fallback, and the
 * final generic label removes redundant app/server prefixes.
 */
export function resolveMcpToolActivityLabel(input: {
  payload: CodexMcpToolCallView;
  resolvedApps?: readonly ProtocolAppInfo[];
  completed?: boolean;
}): string {
  const { payload } = input;
  const resolvedApps = input.resolvedApps ?? [];
  const completed = input.completed ?? payload.completed;
  const app = resolveCodexMcpAppInfo({
    functionName: payload.functionName,
    invocation: payload.invocation,
    resolvedApps,
  });
  const toolParts = stripMcpAppPrefix(payload.invocation.tool, app);
  const toolKey = toolParts.join("_");

  if (toolKey === "js") {
    return (
      resolveScriptToolTitle(toolKey, payload.invocation.arguments) ??
      (completed ? "Ran JavaScript" : "Running JavaScript")
    );
  }

  const [operation, ...subjectParts] = toolParts;
  const verb = operation ? MCP_ACTIVITY_VERBS[operation] : undefined;
  if (app && verb) {
    const subject =
      subjectParts.length > 0 ? sentenceCaseMcpToolParts(subjectParts).toLowerCase() : app.name;
    const context = resolveReadableMcpArgument(payload.invocation.arguments);
    return `${completed ? verb.completed : verb.active} ${subject}${context ? ` "${context}"` : ""}`;
  }

  if (payload.source?.kind === "browserUse") {
    return payload.source.backend === "chrome" ? "Used Chrome" : "Used the browser";
  }

  return sentenceCaseMcpToolParts(toolParts);
}
