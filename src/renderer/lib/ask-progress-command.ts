import { getDisplayCommand, splitShellWords } from "../../shared/codex-command-execution";

const COMMAND_LIMIT = 4_096;
const GLOBAL_SWITCHES = new Set(["--json", "--no-color"]);
const GLOBAL_OPTIONS = new Set([
  "--home",
  "--remote-connection",
  "--expect-profile",
  "--project",
  "--database",
  "--page",
  "--output-format",
  "--help-schema",
]);

// Recognize literal commands in ordinary shell sequences and pipelines. Quoted text and
// escaped operators stay in their argument, and a heredoc body is outside the scan.
const SHELL_SEGMENTS =
  /[ \t]*#[^\r\n]*|(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\\'"&|;\r\n])+|[&|;\r\n]+/guy;

function nodexAction(words: readonly string[]) {
  const action: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (GLOBAL_SWITCHES.has(word)) continue;
    const [flag, value] = word.split("=", 2);
    if (GLOBAL_OPTIONS.has(flag)) {
      if (value === undefined) index += 1;
      continue;
    }
    if (word.startsWith("-")) break;
    action.push(word);
    if (action.length === 2) break;
  }

  const [verb, subcommand] = action;
  switch (verb) {
    case "read":
    case "fetch":
      return "read";
    case "patch":
    case "update_page":
    case "draft":
      return "write";
    case "page":
      return subcommand === "insert" ? "write" : null;
    case "sql":
      return subcommand === "query" ? "query" : null;
    case "visual":
      return subcommand === "check" ? "visual" : null;
    case "discussions":
      if (subcommand === "show") return "read";
      return subcommand === "reply" ? "reply" : null;
    default:
      return null;
  }
}

/** Names a recognizable Nodex action without inspecting tool output or executing shell text. */
export function classifyAskCommandStep(command: string) {
  const script = getDisplayCommand(command.slice(0, COMMAND_LIMIT));
  let heredoc = false;
  for (const [segment] of script.matchAll(SHELL_SEGMENTS)) {
    if (/^[&|;\r\n]/u.test(segment)) {
      if (heredoc && /[\r\n]/u.test(segment)) break;
      continue;
    }
    if (segment.trimStart().startsWith("#")) continue;
    const words = splitShellWords(segment.replaceAll(/\\\r?\n/gu, ""));
    const executable = words?.[0]?.split(/[\\/]/u).at(-1);
    const label =
      words && (executable === "nodex" || executable === "nodex.exe") ? nodexAction(words) : null;
    if (label) return label;
    heredoc ||= segment.includes("<<");
  }
  return "command";
}
