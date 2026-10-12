export const CONTENT_SEARCH_MARK_CLASS = "codex-thread-find-match";
export const CONTENT_SEARCH_ACTIVE_MARK_CLASS = "codex-thread-find-active";
export const CONTENT_SEARCH_MATCH_ID_ATTRIBUTE = "data-content-search-match-id";
export const CONTENT_SEARCH_SHADOW_STYLE_ID = "codex-thread-find-shadow-style";

const CONTENT_SEARCH_SHADOW_STYLE = `
mark.codex-thread-find-match {
  background-color: var(--content-search-match-background);
  color: var(--color-token-foreground);
  border-radius: var(--radius-2xs);
  padding: 0;
  margin: 0;
  border: 0;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  word-spacing: inherit;
  vertical-align: baseline;
}

mark.codex-thread-find-active {
  background-color: var(--content-search-active-match-background);
}
`;

const CONTENT_SEARCH_SKIP_SELECTOR = [
  "script",
  "style",
  "textarea",
  "input",
  "[contenteditable='true']",
  "[hidden]",
  "[data-thread-find-skip]",
  "[data-content-search-skip]",
  "[data-review-line-number]",
  "[data-column-number]",
  "[data-line-number-content]",
  "[data-line-num]",
  "[data-line-old-num]",
  "[data-line-new-num]",
  ".diff-line-number",
  ".diff-gutter",
].join(",");

type ContentSearchRoot = HTMLElement | ShadowRoot;

export interface ContentSearchDomMatch {
  id: string;
  ordinal: number;
  element: HTMLElement;
}

export interface ContentSearchDomApplyResult {
  matches: ContentSearchDomMatch[];
  totalMatches: number;
  capped: boolean;
}

export interface ContentSearchDiffSourceMatch {
  id: string;
  hunkId: string;
  lineStart: number;
  lineEnd: number;
  side?: "additions" | "deletions";
}

interface TextNodeOffset {
  node: Text;
  start: number;
  end: number;
}

interface TextRange {
  start: number;
  end: number;
}

function ensureContentSearchShadowStyle(root: ShadowRoot): void {
  if (root.getElementById(CONTENT_SEARCH_SHADOW_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CONTENT_SEARCH_SHADOW_STYLE_ID;
  style.textContent = CONTENT_SEARCH_SHADOW_STYLE;
  root.append(style);
}

function isElementSkipped(element: Element | null): boolean {
  if (!element) return true;
  return Boolean(element.closest(CONTENT_SEARCH_SKIP_SELECTOR));
}

function collectContentSearchRoots(
  root: HTMLElement,
  includeShadowRoots: boolean,
): ContentSearchRoot[] {
  const roots: ContentSearchRoot[] = [root];
  if (!includeShadowRoots) return roots;

  const pending: ContentSearchRoot[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node instanceof HTMLElement && node.shadowRoot) {
        ensureContentSearchShadowStyle(node.shadowRoot);
        roots.push(node.shadowRoot);
        pending.push(node.shadowRoot);
      }
      node = walker.nextNode();
    }
  }
  return roots;
}

function collectTextNodes(root: ContentSearchRoot): TextNodeOffset[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue) {
        return NodeFilter.FILTER_REJECT;
      }
      return isElementSkipped(node.parentElement)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: TextNodeOffset[] = [];
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) {
      const text = node.nodeValue ?? "";
      nodes.push({ node, start: offset, end: offset + text.length });
      offset += text.length;
    }
    node = walker.nextNode();
  }
  return nodes;
}

function findTextRanges(
  nodes: readonly TextNodeOffset[],
  query: string,
  remaining: number,
): { ranges: TextRange[]; capped: boolean } {
  if (remaining <= 0) return { ranges: [], capped: nodes.length > 0 };
  const text = nodes.map((entry) => entry.node.nodeValue ?? "").join("");
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const ranges: TextRange[] = [];
  let cursor = 0;

  while (cursor < normalizedText.length) {
    const start = normalizedText.indexOf(normalizedQuery, cursor);
    if (start < 0) break;
    if (ranges.length >= remaining) {
      return { ranges, capped: true };
    }
    const end = start + query.length;
    ranges.push({ start, end });
    cursor = end;
  }
  return { ranges, capped: false };
}

function findTextNodeAtOffset(
  nodes: readonly TextNodeOffset[],
  offset: number,
): TextNodeOffset | null {
  for (const entry of nodes) {
    if (offset >= entry.start && offset < entry.end) return entry;
  }
  return null;
}

function escapeAttributeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function queryContentSearchRoot(root: ContentSearchRoot, selector: string): HTMLElement | null {
  if (root instanceof HTMLElement && root.matches(selector)) return root;
  return root.querySelector<HTMLElement>(selector);
}

function hasSideSpecificDiffLines(root: ContentSearchRoot): boolean {
  if (
    root instanceof HTMLElement &&
    (root.matches("[data-additions]") || root.matches("[data-deletions]"))
  ) {
    return true;
  }
  return root.querySelector("[data-additions], [data-deletions]") !== null;
}

function findContentSearchDiffLine(input: {
  root: HTMLElement;
  lineNumber: number;
  side?: "additions" | "deletions";
}): HTMLElement | null {
  const line = escapeAttributeSelectorValue(String(input.lineNumber));
  const sideSelector =
    input.side === "additions"
      ? "[data-additions]"
      : input.side === "deletions"
        ? "[data-deletions]"
        : null;

  for (const root of collectContentSearchRoots(input.root, true)) {
    if (sideSelector) {
      const sideLine =
        queryContentSearchRoot(root, `${sideSelector}[data-line="${line}"]`) ??
        queryContentSearchRoot(root, `${sideSelector} [data-line="${line}"]`) ??
        queryContentSearchRoot(root, `[data-line="${line}"] ${sideSelector}`);
      if (sideLine) return sideLine;
      if (hasSideSpecificDiffLines(root)) continue;
    }

    const lineElement = queryContentSearchRoot(root, `[data-line="${line}"]`);
    if (lineElement) return lineElement;
  }
  return null;
}

export function findContentSearchDomMatch(input: {
  root: HTMLElement;
  matchId: string;
  includeShadowRoots?: boolean;
}): HTMLElement | null {
  const escapedId = escapeAttributeSelectorValue(input.matchId);
  for (const root of collectContentSearchRoots(input.root, input.includeShadowRoots === true)) {
    const element = root.querySelector<HTMLElement>(
      `[${CONTENT_SEARCH_MATCH_ID_ATTRIBUTE}="${escapedId}"]`,
    );
    if (element) return element;
  }
  return null;
}

export function clearContentSearchMarks(
  root: HTMLElement | null,
  options: { includeShadowRoots?: boolean } = {},
): void {
  if (!root) return;
  const roots = collectContentSearchRoots(root, options.includeShadowRoots === true);
  for (const searchRoot of roots) {
    const marks = Array.from(
      searchRoot.querySelectorAll<HTMLElement>(`mark.${CONTENT_SEARCH_MARK_CLASS}`),
    );
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }
}

export function applyContentSearchDomMarks(input: {
  root: HTMLElement;
  query: string;
  idPrefix: string;
  activeMatchId?: string | null;
  includeShadowRoots?: boolean;
  matchIds?: readonly string[];
  limit?: number;
}): ContentSearchDomApplyResult {
  const limit = input.limit ?? 250;
  const query = input.query.trim();
  const includeShadowRoots = input.includeShadowRoots === true;
  clearContentSearchMarks(input.root, { includeShadowRoots });
  if (!query || limit <= 0) {
    return { matches: [], totalMatches: 0, capped: false };
  }

  const matches: ContentSearchDomMatch[] = [];
  let capped = false;
  for (const root of collectContentSearchRoots(input.root, includeShadowRoots)) {
    const nodes = collectTextNodes(root);
    if (nodes.length === 0) continue;
    const found = findTextRanges(nodes, query, limit - matches.length);
    capped ||= found.capped;

    const rootMatches: ContentSearchDomMatch[] = [];
    for (let index = found.ranges.length - 1; index >= 0; index -= 1) {
      const range = found.ranges[index];
      if (!range) continue;
      const startNode = findTextNodeAtOffset(nodes, range.start);
      const endNode = findTextNodeAtOffset(nodes, range.end - 1);
      if (!startNode || !endNode) continue;

      const ordinal = matches.length + index;
      const id = input.matchIds?.[ordinal] ?? `${input.idPrefix}:${ordinal}`;
      const domRange = document.createRange();
      domRange.setStart(startNode.node, range.start - startNode.start);
      domRange.setEnd(endNode.node, range.end - endNode.start);
      const mark = document.createElement("mark");
      mark.className =
        input.activeMatchId === id
          ? `${CONTENT_SEARCH_MARK_CLASS} ${CONTENT_SEARCH_ACTIVE_MARK_CLASS}`
          : CONTENT_SEARCH_MARK_CLASS;
      mark.setAttribute(CONTENT_SEARCH_MATCH_ID_ATTRIBUTE, id);
      mark.append(domRange.extractContents());
      domRange.insertNode(mark);
      rootMatches.push({ id, ordinal, element: mark });
    }
    rootMatches.sort((left, right) => left.ordinal - right.ordinal);
    matches.push(...rootMatches);
    if (capped || matches.length >= limit) break;
  }

  return {
    matches,
    totalMatches: matches.length,
    capped,
  };
}

export function applyContentSearchDiffDomMarks(input: {
  root: HTMLElement;
  query: string;
  activeMatchId?: string | null;
  sourceMatches: readonly ContentSearchDiffSourceMatch[];
}): ContentSearchDomApplyResult {
  clearContentSearchMarks(input.root, { includeShadowRoots: true });
  const matchIds = input.sourceMatches.map((match) => match.id);
  const applyFallback = () =>
    applyContentSearchDomMarks({
      root: input.root,
      query: input.query,
      idPrefix: "content-search:diff",
      activeMatchId: input.activeMatchId,
      includeShadowRoots: true,
      matchIds,
      limit: matchIds.length,
    });

  if (input.sourceMatches.some((match) => match.hunkId === "path")) {
    return applyFallback();
  }

  const groups = new Map<
    string,
    {
      lineNumber: number;
      side?: "additions" | "deletions";
      matches: ContentSearchDiffSourceMatch[];
    }
  >();
  for (const match of input.sourceMatches) {
    if (match.lineStart !== match.lineEnd) continue;
    const key = `${match.side ?? "unified"}:${match.lineStart}`;
    const group = groups.get(key) ?? {
      lineNumber: match.lineStart,
      ...(match.side ? { side: match.side } : {}),
      matches: [],
    };
    group.matches.push(match);
    groups.set(key, group);
  }

  let foundLine = false;
  const markedMatches: ContentSearchDomMatch[] = [];
  for (const group of groups.values()) {
    const line = findContentSearchDiffLine({
      root: input.root,
      lineNumber: group.lineNumber,
      side: group.side,
    });
    if (!line) continue;
    foundLine = true;
    const result = applyContentSearchDomMarks({
      root: line,
      query: input.query,
      idPrefix: "content-search:diff-line",
      activeMatchId: input.activeMatchId,
      matchIds: group.matches.map((match) => match.id),
      limit: group.matches.length,
    });
    for (const match of result.matches) {
      markedMatches.push({
        ...match,
        ordinal: markedMatches.length,
      });
    }
  }

  if (
    foundLine ||
    (groups.size > 0 &&
      (input.root.matches("[data-line]") || input.root.querySelector("[data-line]") !== null))
  ) {
    return {
      matches: markedMatches,
      totalMatches: markedMatches.length,
      capped: false,
    };
  }

  return applyFallback();
}

export function setActiveContentSearchDomMatch(
  root: HTMLElement | null,
  activeMatchId: string | null,
  options: { includeShadowRoots?: boolean } = {},
): HTMLElement | null {
  if (!root) return null;
  let activeElement: HTMLElement | null = null;
  for (const searchRoot of collectContentSearchRoots(root, options.includeShadowRoots === true)) {
    const marks = searchRoot.querySelectorAll<HTMLElement>(`mark.${CONTENT_SEARCH_MARK_CLASS}`);
    for (const mark of marks) {
      const isActive = mark.getAttribute(CONTENT_SEARCH_MATCH_ID_ATTRIBUTE) === activeMatchId;
      mark.classList.toggle(CONTENT_SEARCH_ACTIVE_MARK_CLASS, isActive);
      if (isActive) activeElement = mark;
    }
  }
  return activeElement;
}

export function countContentSearchDomMatches(input: {
  root: HTMLElement;
  query: string;
  includeShadowRoots?: boolean;
  limit?: number;
}): { totalMatches: number; capped: boolean } {
  const query = input.query.trim();
  if (!query) return { totalMatches: 0, capped: false };
  const limit = input.limit ?? 250;
  let totalMatches = 0;
  let capped = false;
  for (const root of collectContentSearchRoots(input.root, input.includeShadowRoots === true)) {
    const found = findTextRanges(collectTextNodes(root), query, limit - totalMatches);
    totalMatches += found.ranges.length;
    capped ||= found.capped;
    if (capped || totalMatches >= limit) break;
  }
  return { totalMatches, capped };
}
