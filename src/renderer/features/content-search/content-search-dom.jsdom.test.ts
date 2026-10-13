import { describe, expect, test } from "vite-plus/test";
import {
  CONTENT_SEARCH_ACTIVE_MARK_CLASS,
  CONTENT_SEARCH_MATCH_ID_ATTRIBUTE,
  CONTENT_SEARCH_SHADOW_STYLE_ID,
  applyContentSearchDiffDomMarks,
  applyContentSearchDomMarks,
  clearContentSearchMarks,
  findContentSearchDomMatch,
  countContentSearchDomMatches,
  setActiveContentSearchDomMatch,
} from "./content-search-dom";

describe("content search DOM marks", () => {
  test("wraps matches and clears marks without losing text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>alpha beta alpha</p>";

    const result = applyContentSearchDomMarks({
      root,
      query: "alpha",
      idPrefix: "test",
      activeMatchId: "test:1",
    });

    expect(result.totalMatches).toBe(2);
    expect(root.querySelectorAll("mark.codex-thread-find-match").length).toBe(2);
    expect(Boolean(root.querySelector(`mark.${CONTENT_SEARCH_ACTIVE_MARK_CLASS}`))).toBe(true);
    expect(root.querySelectorAll("mark")[1]?.getAttribute(CONTENT_SEARCH_MATCH_ID_ATTRIBUTE)).toBe(
      "test:1",
    );

    clearContentSearchMarks(root);

    expect(root.querySelectorAll("mark").length).toBe(0);
    expect(root.textContent).toBe("alpha beta alpha");
  });

  test("skips collapsed and editable content", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<p>visible needle</p>",
      '<p data-thread-find-skip="true">hidden needle</p>',
      "<textarea>editable needle</textarea>",
      '<div contenteditable="true">editable needle</div>',
    ].join("");

    const result = applyContentSearchDomMarks({
      root,
      query: "needle",
      idPrefix: "skip",
    });

    expect(result.totalMatches).toBe(1);
    expect(root.querySelectorAll("mark.codex-thread-find-match").length).toBe(1);
  });

  test("caps marked matches", () => {
    const root = document.createElement("div");
    root.textContent = "needle needle needle";

    const result = applyContentSearchDomMarks({
      root,
      query: "needle",
      idPrefix: "cap",
      limit: 2,
    });

    expect(result.totalMatches).toBe(2);
    expect(result.capped).toBe(true);
    expect(root.querySelectorAll("mark.codex-thread-find-match").length).toBe(2);
  });

  test("keeps formatted ancestors and one logical identity for each fragmented occurrence", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p><span>first need</span><strong>le</strong><span> and need</span><em>le</em> last</p>";
    const paragraph = root.querySelector("p")!;
    const elements = Array.from(paragraph.children);
    const originalText = paragraph.textContent;
    const result = applyContentSearchDomMarks({
      root,
      query: "needle",
      idPrefix: "fragment",
      activeMatchId: "fragment:1",
    });
    expect(result.totalMatches).toBe(2);
    expect(result.matches.map(({ id }) => id)).toEqual(["fragment:0", "fragment:1"]);
    for (const id of ["fragment:0", "fragment:1"]) {
      const fragments = Array.from(
        root.querySelectorAll<HTMLElement>(`mark[${CONTENT_SEARCH_MATCH_ID_ATTRIBUTE}="${id}"]`),
      );
      expect(fragments.map((element) => element.textContent).join("")).toBe("needle");
      expect(fragments).toHaveLength(2);
      expect(findContentSearchDomMatch({ root, matchId: id })).toBe(fragments[0]);
      expect(result.matches.find((match) => match.id === id)?.element).toBe(fragments[0]);
    }
    const active = setActiveContentSearchDomMatch(root, "fragment:0");
    expect(active).toBe(result.matches[0]?.element);
    expect(root.querySelectorAll(`mark.${CONTENT_SEARCH_ACTIVE_MARK_CLASS}`)).toHaveLength(2);
    expect(paragraph.children).toHaveLength(elements.length);
    elements.forEach((element, index) => expect(paragraph.children.item(index)).toBe(element));
    expect(paragraph.textContent).toBe(originalText);
    clearContentSearchMarks(root);
    expect(root.querySelector("mark")).toBeNull();
    expect(paragraph.children).toHaveLength(elements.length);
    elements.forEach((element, index) => expect(paragraph.children.item(index)).toBe(element));
    expect(paragraph.textContent).toBe(originalText);
  });

  test.each([
    "<blockquote><p>hello</p><p><strong>world</strong></p></blockquote>",
    "<p>hello<br><strong>world</strong></p>",
    "<p>hello </p><p><strong>world</strong></p>",
  ])("maps a required text boundary to real fragments without changing formatting: %s", (html) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    const elements = Array.from(root.querySelectorAll("*"));
    const originalText = root.textContent;
    expect(countContentSearchDomMatches({ root, query: "hello world" }).totalMatches).toBe(1);
    const result = applyContentSearchDomMarks({
      root,
      query: "hello world",
      idPrefix: "boundary",
      activeMatchId: "boundary:0",
    });
    expect(result.matches).toHaveLength(1);
    const fragments = Array.from(root.querySelectorAll("mark"));
    expect(fragments.map((fragment) => fragment.textContent?.trim())).toEqual(["hello", "world"]);
    expect(result.matches[0]?.element).toBe(fragments[0]);
    expect(
      fragments.every(
        (fragment) => fragment.getAttribute(CONTENT_SEARCH_MATCH_ID_ATTRIBUTE) === "boundary:0",
      ),
    ).toBe(true);
    expect(
      fragments.every((fragment) => fragment.classList.contains(CONTENT_SEARCH_ACTIVE_MARK_CLASS)),
    ).toBe(true);
    clearContentSearchMarks(root);
    const restored = root.querySelectorAll("*");
    expect(restored).toHaveLength(elements.length);
    elements.forEach((element, index) => expect(restored.item(index)).toBe(element));
    expect(root.textContent).toBe(originalText);
  });

  test("marks a query spanning syntax token nodes inside a shadow root", () => {
    const root = document.createElement("div");
    const diffHost = document.createElement("diffs-container");
    root.append(diffHost);
    const shadowRoot = diffHost.attachShadow({ mode: "open" });
    const line = document.createElement("span");
    line.innerHTML = "<span>need</span><span>le</span>";
    shadowRoot.append(line);

    const result = applyContentSearchDomMarks({
      root,
      query: "needle",
      idPrefix: "shadow",
      includeShadowRoots: true,
      matchIds: ["diff:src/app.ts:0:4"],
    });

    const marks = Array.from(shadowRoot.querySelectorAll("mark.codex-thread-find-match"));
    expect(result.matches.map((match) => match.id)).toEqual(["diff:src/app.ts:0:4"]);
    expect(marks.map((mark) => mark.textContent).join("")).toBe("needle");
    expect(marks.map((mark) => mark.getAttribute(CONTENT_SEARCH_MATCH_ID_ATTRIBUTE))).toEqual([
      "diff:src/app.ts:0:4",
      "diff:src/app.ts:0:4",
    ]);
    expect(shadowRoot.getElementById(CONTENT_SEARCH_SHADOW_STYLE_ID)).not.toBeNull();

    clearContentSearchMarks(root, { includeShadowRoots: true });
    expect(shadowRoot.querySelector("mark")).toBeNull();
    expect(line.textContent).toBe("needle");
  });

  test("targets an exact diff line before marking repeated shadow text", () => {
    const root = document.createElement("div");
    root.textContent = "needle in file stats";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const additions = document.createElement("div");
    additions.setAttribute("data-additions", "");
    const firstLine = document.createElement("div");
    firstLine.dataset.line = "1";
    firstLine.textContent = "needle on first line";
    const secondLine = document.createElement("div");
    secondLine.dataset.line = "2";
    secondLine.append("nee");
    const token = document.createElement("span");
    token.textContent = "dle on second line";
    secondLine.append(token);
    additions.append(firstLine, secondLine);
    shadow.append(additions);
    root.append(host);

    const result = applyContentSearchDiffDomMarks({
      root,
      query: "needle",
      activeMatchId: "diff:file:0:1",
      sourceMatches: [
        {
          id: "diff:file:0:1",
          hunkId: "0",
          lineStart: 2,
          lineEnd: 2,
          side: "additions",
        },
      ],
    });

    expect(result.matches).toHaveLength(1);
    expect(firstLine.querySelector("mark")).toBeNull();
    expect(root.querySelector("mark")).toBeNull();
    const fragments = Array.from(secondLine.querySelectorAll("mark"));
    expect(fragments.map((mark) => mark.textContent).join("")).toBe("needle");
    expect(result.matches[0]?.element).toBe(fragments[0]);
    expect(
      secondLine.querySelector("mark")?.classList.contains(CONTENT_SEARCH_ACTIVE_MARK_CLASS),
    ).toBe(true);
  });
});
