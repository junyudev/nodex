import { delimiter } from "node:path";

function decodeQuotedEscapes(value: string, ansi: boolean): string {
  if (!ansi) return value.replace(/\\([\\"])/g, "$1");
  return value.replace(
    /\\([\\'"?]|a|b|e|E|f|n|r|t|v|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|c.)/g,
    (_, escape: string) => {
      const characters: Record<string, string> = {
        a: "\x07",
        b: "\b",
        e: "\x1b",
        E: "\x1b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
      };
      if (characters[escape] !== undefined) return characters[escape];
      if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
      if (/^[xuU]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (escape[0] === "c")
        return escape[1] === "?" ? "\x7f" : String.fromCharCode(escape.charCodeAt(1) & 31);
      return escape;
    },
  );
}

function shellWords(value: string): string[] | null {
  const words: string[] = [];
  let quote: string | null = null;
  let dollarQuote: string | null = null;
  let escaped = false;
  let lastDollar = -2;
  let word: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      if (char !== "\n") word = (word ?? "") + (quote ? "\\" : "") + char;
      escaped = false;
      continue;
    }
    if (char === "\\" && (!quote || dollarQuote !== null || quote === '"')) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (quote === '"' || dollarQuote === "'")
          word = decodeQuotedEscapes(word ?? "", dollarQuote === "'");
        quote = null;
        dollarQuote = null;
      } else word = (word ?? "") + char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
      if (lastDollar === index - 1) {
        dollarQuote = char;
        word = word.slice(0, -1);
      }
      continue;
    }
    if (/[;&|<>]/u.test(char)) return null;
    if (char === "$") lastDollar = index;
    if (" \t\r\n".includes(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word = (word ?? "") + char;
  }
  if (quote || escaped) return null;
  if (word !== undefined) words.push(word);
  return words;
}

function executable(command: string, depth = 0): string | null {
  const words = shellWords(command);
  if (!words) return null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) || ["exec", "command", "env"].includes(word))
      continue;
    const basename = word.replaceAll("\\", "/").toLowerCase().split("/").at(-1)!;
    if (depth >= 2 || !["sh", "bash", "zsh", "dash", "ksh"].includes(basename)) return word;
    for (const [offset, flag] of words.slice(index + 1).entries()) {
      if (flag === "-c" || /^-[^-]*c/u.test(flag)) {
        const nested = words[index + offset + 2];
        return nested === undefined ? word : executable(nested, depth + 1);
      }
      if (!flag.startsWith("-") || flag === "--") break;
    }
    return word;
  }
  return null;
}

/** Only an unresolved bare ProxyCommand executable requires waiting for login PATH discovery. */
export function codexSshProxyDependency(
  config: string,
  path: string | null,
  resolve: (command: string, path: string) => boolean,
) {
  let proxyCommand: string | null = null;
  for (const line of config.split(/\r?\n/u)) {
    const match = /^proxycommand\s+(.*)$/iu.exec(line.trim());
    if (match) proxyCommand = match[1]!.trim();
  }
  const base = {
    commandName: null as string | null,
    needsShellEnv: false,
    pathEntryCount: path ? path.split(delimiter).length : 0,
    proxyCommand,
  };
  if (proxyCommand === null) return { ...base, reason: "no_proxy_command" };
  if (proxyCommand.toLowerCase() === "none") return { ...base, reason: "proxy_command_none" };
  const commandName = executable(proxyCommand);
  if (commandName === null) return { ...base, reason: "proxy_command_unparsed" };
  if (commandName.includes("/") || commandName.includes("\\") || /^[A-Za-z]:/u.test(commandName))
    return { ...base, commandName, reason: "proxy_command_has_path" };
  const found = !!path && resolve(commandName, path);
  return {
    ...base,
    commandName,
    needsShellEnv: !found,
    reason: found ? "proxy_command_resolved_in_path" : "proxy_command_unresolved_in_path",
  };
}
