const readAttributes = (source: string): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="((?:[^"\\]|\\.)*)"/gu)) {
    const [, name, value] = match;
    if (name) attributes[name] = (value ?? "").replace(/\\(.)/gu, "$1");
  }
  return attributes;
};

const rewriteDirectives = (line: string): string =>
  line
    .replace(/:attachment\{([^}]*)\}/gu, (_, body: string) => {
      const { name, source } = readAttributes(body);
      if (!source) return name ?? "";
      return `[${(name ?? "Attachment").replace(/[[\]]/gu, "\\$&")}](${source})`;
    })
    .replace(/:date\{([^}]*)\}/gu, (_, body: string) => {
      const { start, end } = readAttributes(body);
      return end ? `${start ?? ""} – ${end}` : (start ?? "");
    })
    .replace(/:agent-config\{[^}]*\}/gu, "")
    .replace(/:span\[([^\]]*)\]\{[^}]*\}/gu, "$1")
    .replace(/<nodex:\/\/pages\/([^>\s]+)>/gu, "[Page](nodex://pages/$1)")
    .replace(/<nodex:\/\/sessions\/([^>\s]+)>/gu, "[Chat](nodex://sessions/$1)");

/**
 * Reduces Nodex directives to the plain Markdown a phone shows. Containers such as Prompts and
 * toggles keep their title and body; code is left exactly as written.
 */
export const flattenNodexMarkdown = (text: string): string => {
  const out: string[] = [];
  let fence: string | null = null;
  let containerDepth = 0;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    const open = /^\s*:::[\w-]+(?:\[(.*)\])?(?:\{.*\})?\s*$/u.exec(line);
    if (open) {
      containerDepth += 1;
      if (open[1]) out.push(`**${open[1]}**`, "");
      continue;
    }
    if (containerDepth > 0 && /^\s*:::\s*$/u.test(line)) {
      containerDepth -= 1;
      continue;
    }
    const dedented = containerDepth > 0 ? line.replace(/^ {1,2}/u, "") : line;
    out.push(rewriteDirectives(dedented));
  }
  return out.join("\n");
};

/** The part of a body a stream row shows, cut at a line so Markdown stays well formed. */
export const previewMarkdown = (
  text: string,
  maxChars = 560,
): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= maxChars) return { text, cut: false };
  const head = text.slice(0, maxChars);
  const lineEnd = head.lastIndexOf("\n");
  const cut = lineEnd > maxChars / 2 ? head.slice(0, lineEnd) : head;
  const fences = cut.match(/^\s*(```|~~~)/gmu)?.length ?? 0;
  return { text: fences % 2 === 1 ? `${cut}\n\`\`\`` : cut, cut: true };
};
