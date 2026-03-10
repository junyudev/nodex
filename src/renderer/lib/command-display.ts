const BASH_LIKE_SHELLS = new Set(["bash", "zsh", "sh"]);
const POWERSHELL_SHELLS = new Set(["pwsh", "powershell"]);
const POWERSHELL_FLAGS = new Set(["-nologo", "-noprofile", "-command", "-c"]);

function splitShellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) return null;
  if (current.length > 0) words.push(current);
  return words;
}

function normalizeShellName(shellPathOrName: string): string | null {
  const basename = shellPathOrName.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!basename) return null;
  if (basename.endsWith(".exe")) return basename.slice(0, -4);
  return basename;
}

function extractBashLikeScript(words: string[]): string | null {
  if (words.length !== 3) return null;
  const shellName = normalizeShellName(words[0]);
  if (!shellName || !BASH_LIKE_SHELLS.has(shellName)) return null;
  const flag = words[1];
  if (flag !== "-lc" && flag !== "-c") return null;
  return words[2];
}

function extractPowerShellScript(words: string[]): string | null {
  if (words.length < 3) return null;
  const shellName = normalizeShellName(words[0]);
  if (!shellName || !POWERSHELL_SHELLS.has(shellName)) return null;

  let index = 1;
  while (index + 1 < words.length) {
    const flag = words[index].toLowerCase();
    if (!POWERSHELL_FLAGS.has(flag)) return null;
    if (flag === "-command" || flag === "-c") {
      return words[index + 1];
    }
    index += 1;
  }

  return null;
}

export function getDisplayCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return command;

  const words = splitShellWords(trimmed);
  if (!words || words.length === 0) return trimmed;

  return extractBashLikeScript(words) ?? extractPowerShellScript(words) ?? trimmed;
}
