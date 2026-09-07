import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { MaitaiProvider, createMaitaiStore, useScopedAtom, useSetScopedAtom } from "@/lib/maitai";
import { WorkbenchSessionScopePath } from "@/lib/workbench-ui-scopes";
import { canonicalizeReviewPath, resolveReviewPathCandidate } from "./review-path";
import {
  prepareReviewOpenAtom,
  reviewDiffPreferencesAtom,
  reviewRouteStateAtom,
} from "./review-view-state";

function ReviewStateProbe() {
  const [routeState, setRouteState] = useScopedAtom(reviewRouteStateAtom);
  const [preferences, setPreferences] = useScopedAtom(reviewDiffPreferencesAtom);
  const prepareOpen = useSetScopedAtom(prepareReviewOpenAtom);
  const targetPath = canonicalizeReviewPath("/workspace/src/app.ts", ["/workspace"]);

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          prepareOpen({
            operationId: "external-1",
            source: { kind: "git", mode: "staged" },
            targetPath,
          })
        }
      >
        external
      </button>
      <button
        type="button"
        onClick={() =>
          prepareOpen({
            source: { kind: "last-turn", threadId: "thread-1" },
            targetPath,
          })
        }
      >
        prepare
      </button>
      <button
        type="button"
        onClick={() =>
          setRouteState((current) => ({
            ...current,
            fileFilter: current.fileFilter ? "" : "route-filter",
          }))
        }
      >
        route
      </button>
      <button
        type="button"
        onClick={() =>
          setPreferences((current) => ({
            ...current,
            wrap: !current.wrap,
          }))
        }
      >
        wrap
      </button>
      <output data-testid="state">{JSON.stringify({ routeState, preferences })}</output>
    </div>
  );
}

function RouteHarness({ routeKey }: { readonly routeKey: string }) {
  return (
    <WorkbenchSessionScopePath
      thread={{
        stableKey: "session:review-state-test",
        phase: "attached",
        projectSessionId: "review-state-test",
        clientThreadId: null,
        threadId: "thread-1",
      }}
      route={{ routeKey, kind: "thread" }}
      selected
    >
      <ReviewStateProbe />
    </WorkbenchSessionScopePath>
  );
}

describe("Review view state", () => {
  test("consumes an external opening once without replaying it over a later source selection", async () => {
    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <RouteHarness routeKey="/thread/external" />
      </MaitaiProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "external" }));
      await Promise.resolve();
    });
    const read = () => JSON.parse(view.getByTestId("state").textContent ?? "{}").routeState;
    expect(read()).toMatchObject({
      source: "staged",
      nextRevealRequestId: 1,
      externalOpenOperationId: "external-1",
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "prepare" }));
      await Promise.resolve();
    });
    expect(read()).toMatchObject({ source: "last-turn", nextRevealRequestId: 2 });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "external" }));
      await Promise.resolve();
    });
    expect(read()).toMatchObject({ source: "last-turn", nextRevealRequestId: 2 });
  });
  test("canonicalizes absolute and patch-prefixed paths and resolves rename aliases", () => {
    expect(canonicalizeReviewPath("/workspace/./src/app.ts", ["/workspace"])).toBe("src/app.ts");
    expect(canonicalizeReviewPath("b/src/app.ts", ["/workspace"])).toBe("src/app.ts");
    const candidates = [{ displayPath: "src/new.ts", previousPath: "src/old.ts" }];
    expect(
      resolveReviewPathCandidate(candidates, canonicalizeReviewPath("a/src/old.ts"))?.displayPath,
    ).toBe("src/new.ts");
  });

  test("fails closed when an alias resolves to more than one Review file", () => {
    const target = canonicalizeReviewPath("src/old.ts");
    expect(
      resolveReviewPathCandidate(
        [
          { displayPath: "src/new-a.ts", previousPath: "src/old.ts" },
          { displayPath: "src/new-b.ts", previousPath: "src/old.ts" },
        ],
        target,
      ),
    ).toBeNull();
  });

  test("prefers an exact current path over a rename alias", () => {
    const target = canonicalizeReviewPath("src/current.ts");
    expect(
      resolveReviewPathCandidate(
        [
          { displayPath: "src/current.ts" },
          { displayPath: "src/renamed.ts", previousPath: "src/current.ts" },
        ],
        target,
      )?.displayPath,
    ).toBe("src/current.ts");
  });

  test("creates a fresh reveal request for repeated clicks without retaining raw patches", () => {
    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <RouteHarness routeKey="/thread/a" />
      </MaitaiProvider>,
    );

    fireEvent.click(view.getByText("prepare"));
    fireEvent.click(view.getByText("prepare"));

    const state = view.getByTestId("state").textContent ?? "";
    expect(state).toContain('"nextRevealRequestId":2');
    expect(state).toContain('"targetPath":"src/app.ts"');
    expect(state).not.toContain("patch");
  });

  test("retains Route state per task while sharing App preferences", () => {
    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <RouteHarness routeKey="/thread/a" />
      </MaitaiProvider>,
    );

    fireEvent.click(view.getByText("route"));
    fireEvent.click(view.getByText("wrap"));
    expect(view.getByTestId("state").textContent).toContain("route-filter");
    expect(view.getByTestId("state").textContent).toContain('"wrap":true');

    view.rerender(
      <MaitaiProvider store={store}>
        <RouteHarness routeKey="/thread/b" />
      </MaitaiProvider>,
    );
    expect(view.getByTestId("state").textContent).not.toContain("route-filter");
    expect(view.getByTestId("state").textContent).toContain('"wrap":true');

    view.rerender(
      <MaitaiProvider store={store}>
        <RouteHarness routeKey="/thread/a" />
      </MaitaiProvider>,
    );
    expect(view.getByTestId("state").textContent).toContain("route-filter");
  });
});
