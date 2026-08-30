import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { PageSearchResult, PageSearchSnapshot } from "../../shared/types";
import { render, textContent } from "../test/dom";
import { searchPages } from "./api";
import {
  __testing,
  configureInteractivePageSearch,
  useInteractivePageSearch,
} from "./interactive-page-search";

const apiMocks = vi.hoisted(() => ({
  searchPages: vi.fn<() => Promise<PageSearchSnapshot>>(() => new Promise(() => undefined)),
}));

vi.mock("./api", () => ({
  searchPages: apiMocks.searchPages,
  subscribeLibraryChanges: () => () => undefined,
}));

const PROJECT_IDS = ["project-1"];

function hit(query: string): PageSearchResult {
  return {
    projectId: "project-1",
    pageId: "page-1",
    pageKey: "NDX-1",
    title: `Canonical ${query}`,
    status: null,
    priority: null,
    tags: [],
    assignee: null,
    locationLabel: "Pages",
    titleParts: [],
    excerpt: null,
    excerptParts: [],
    matches: [],
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function pageHit(pageId: string, title: string): PageSearchResult {
  return { ...hit(title), pageId, title };
}

function snapshot(results: readonly PageSearchResult[]): PageSearchSnapshot {
  return {
    libraryId: "library-1",
    storeEpoch: "test-epoch",
    commitSeq: 1,
    results: [...results],
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Harness() {
  const [query, setQuery] = useState("");
  const [unrelated, setUnrelated] = useState(0);
  const search = useInteractivePageSearch({ projectIds: PROJECT_IDS, query, limit: 10 });
  return (
    <>
      <input
        aria-label="Search Pages"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <button onClick={() => setUnrelated((value) => value + 1)}>Rerender {unrelated}</button>
      {search.rows.map((row) => (
        <div data-page-id={row.pageId} key={row.pageId}>
          {row.title}
        </div>
      ))}
      {search.enrichment === "loading" ? <div>Loading more Pages…</div> : null}
      {search.enrichment === "unavailable" ? <div>Full Page search is unavailable</div> : null}
      {search.enrichment === "settled" && search.rows.length === 0 ? (
        <div>No matching Pages</div>
      ) : null}
    </>
  );
}

function SharedHarness() {
  const first = useInteractivePageSearch({ projectIds: PROJECT_IDS, query: "shared", limit: 10 });
  const second = useInteractivePageSearch({ projectIds: PROJECT_IDS, query: "shared", limit: 10 });
  return (
    <>
      <div data-shared="first">
        {first.enrichment}:{first.rows[0]?.title ?? "none"}
      </div>
      <div data-shared="second">
        {second.enrichment}:{second.rows[0]?.title ?? "none"}
      </div>
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(searchPages).mockReset();
  vi.mocked(searchPages).mockImplementation(() => new Promise(() => undefined));
  __testing.reset();
});

describe("InteractivePageSearch", () => {
  test("renders query-fresh metadata in the input event before complete search resolves", () => {
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: (request: { query?: string }) => (request.query ? [hit(request.query)] : []),
    });
    const { container } = render(<Harness />);
    const input = container.querySelector("input")!;

    void act(() => fireEvent.change(input, { target: { value: "canon" } }));

    expect(textContent(container)).toContain("Canonical canon");
    expect(textContent(container)).toContain("Loading more Pages…");
  });

  test("discards an older complete response after the live query changes", async () => {
    vi.useFakeTimers();
    const older = deferred<PageSearchSnapshot>();
    const current = deferred<PageSearchSnapshot>();
    vi.mocked(searchPages).mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: (request: { query?: string }) => (request.query ? [hit(request.query)] : []),
    });
    const { container } = render(<Harness />);
    const input = container.querySelector("input")!;

    void act(() => fireEvent.change(input, { target: { value: "older" } }));
    await act(async () => vi.advanceTimersByTimeAsync(175));
    void act(() => fireEvent.change(input, { target: { value: "current" } }));
    await act(async () => vi.advanceTimersByTimeAsync(175));
    expect(vi.mocked(searchPages).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => older.resolve(snapshot([hit("older complete")])));

    expect(textContent(container)).toContain("Canonical current");
    expect(textContent(container)).not.toContain("older complete");

    await act(async () => current.resolve(snapshot([hit("current complete")])));
    expect(textContent(container)).toContain("Canonical current complete");
  });

  test("adopts Core ordering once complete search settles", async () => {
    vi.useFakeTimers();
    const previewFirst = pageHit("page-preview-first", "Preview first");
    const previewSecond = pageHit("page-preview-second", "Preview second");
    vi.mocked(searchPages).mockResolvedValueOnce(snapshot([previewSecond, previewFirst]));
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: () => [previewFirst, previewSecond],
    });
    const { container } = render(<Harness />);

    await act(async () => {
      fireEvent.change(container.querySelector("input")!, { target: { value: "pages" } });
    });
    const previewIds = () =>
      Array.from(container.querySelectorAll("[data-page-id]")).map((element) =>
        element.getAttribute("data-page-id"),
      );
    expect(previewIds()).toEqual(["page-preview-first", "page-preview-second"]);

    await act(async () => vi.advanceTimersByTimeAsync(175));
    expect(previewIds()).toEqual(["page-preview-second", "page-preview-first"]);
  });

  test("keeps the current complete request across unrelated renders", async () => {
    vi.useFakeTimers();
    const current = deferred<PageSearchSnapshot>();
    vi.mocked(searchPages).mockReturnValueOnce(current.promise);
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: (request: { query?: string }) => (request.query ? [hit(request.query)] : []),
    });
    const { container } = render(<Harness />);

    void act(() =>
      fireEvent.change(container.querySelector("input")!, { target: { value: "stable" } }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(175));
    const signal = vi.mocked(searchPages).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    void act(() => fireEvent.click(container.querySelector("button")!));

    expect(signal?.aborted).toBe(false);
    await act(async () => current.resolve(snapshot([hit("stable complete")])));
    expect(textContent(container)).toContain("Canonical stable complete");
  });

  test("shares one complete request across concurrent consumers of a revision", async () => {
    vi.useFakeTimers();
    const shared = deferred<PageSearchSnapshot>();
    vi.mocked(searchPages).mockReturnValueOnce(shared.promise);
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: () => [],
    });
    const { container } = render(<SharedHarness />);

    await act(async () => vi.advanceTimersByTimeAsync(175));
    expect(searchPages).toHaveBeenCalledTimes(1);
    await act(async () => shared.resolve(snapshot([hit("shared complete")])));

    const rows = Array.from(container.querySelectorAll("[data-shared]")).map(
      (element) => element.textContent,
    );
    expect(rows).toEqual([
      "settled:Canonical shared complete",
      "settled:Canonical shared complete",
    ]);
  });

  test("keeps metadata rows when complete search is unavailable", async () => {
    vi.useFakeTimers();
    vi.mocked(searchPages).mockRejectedValueOnce(new Error("offline"));
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: (request: { query?: string }) => (request.query ? [hit(request.query)] : []),
    });
    const { container } = render(<Harness />);

    void act(() =>
      fireEvent.change(container.querySelector("input")!, { target: { value: "local" } }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(175));

    expect(textContent(container)).toContain("Canonical local");
    expect(textContent(container)).toContain("Full Page search is unavailable");
  });

  test("falls back to complete Core results without retrying a failed metadata projection", async () => {
    vi.useFakeTimers();
    vi.mocked(searchPages).mockResolvedValueOnce(snapshot([hit("complete fallback")]));
    __testing.installUnavailable(PROJECT_IDS);
    const { container } = render(<Harness />);

    configureInteractivePageSearch([...PROJECT_IDS]);
    await act(async () => vi.advanceTimersByTimeAsync(175));

    expect(searchPages).toHaveBeenCalledTimes(1);
    expect(textContent(container)).toContain("Canonical complete fallback");
    expect(textContent(container)).not.toContain("Full Page search is unavailable");
  });

  test("shows an empty state only after the current complete search settles", async () => {
    vi.useFakeTimers();
    vi.mocked(searchPages).mockResolvedValueOnce(snapshot([]));
    __testing.installIndex(PROJECT_IDS, {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: () => [],
    });
    const { container } = render(<Harness />);

    void act(() =>
      fireEvent.change(container.querySelector("input")!, { target: { value: "missing" } }),
    );
    expect(textContent(container)).not.toContain("No matching Pages");

    await act(async () => vi.advanceTimersByTimeAsync(175));
    expect(textContent(container)).toContain("No matching Pages");
  });
});
