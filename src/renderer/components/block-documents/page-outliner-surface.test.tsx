import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";
import { render } from "@/test/dom";
import {
  PageOutlinerDisclosure,
  PageOutlinerFrame,
  PageOutlinerRowSlots,
  usePageOutlinerActivation,
  type PageOutlinerFrameProps,
  type PageOutlinerRowContentProps,
} from "./page-outliner-surface";
import { PortableRichTitle } from "./portable-rich-title";

function PageOutlinerRow({
  targetBlockId,
  accessKind,
  active,
  sectionRef,
  onTouch,
  ...content
}: PageOutlinerFrameProps & PageOutlinerRowContentProps) {
  return (
    <PageOutlinerFrame
      targetBlockId={targetBlockId}
      accessKind={accessKind}
      expanded={content.expanded}
      active={active}
      sectionRef={sectionRef}
      onTouch={onTouch}
    >
      <PageOutlinerDisclosure {...content}>
        <PageOutlinerRowSlots {...content} />
      </PageOutlinerDisclosure>
    </PageOutlinerFrame>
  );
}

function ActivationHarness({
  disclosureKey = "page:block:target",
  title = "Rich title",
  expandable = true,
  disclosureStore,
  activationBudget,
  renderActive,
  titleNode,
}: {
  readonly disclosureKey?: string;
  readonly title?: string;
  readonly expandable?: boolean;
  readonly disclosureStore: BlockDisclosureStateStore;
  readonly activationBudget: ReferenceSurfaceActivationBudget;
  readonly renderActive: () => React.ReactNode;
  readonly titleNode?: React.ReactNode;
}) {
  const activation = usePageOutlinerActivation({
    disclosureKey,
    expandable,
    disclosureStore,
    activationBudget,
    visibilityOverride: true,
  });
  return (
    <>
      <PageOutlinerRow
        targetBlockId="target"
        accessKind="project"
        plainTitle={title}
        title={titleNode ?? <PortableRichTitle value={plainTextToPortableRichText(title)} />}
        expanded={activation.expanded}
        expandable={expandable}
        active={activation.active}
        sectionRef={activation.sectionRef}
        onExpandedChange={activation.setExpanded}
        onTouch={activation.touch}
      >
        {activation.active ? renderActive() : null}
      </PageOutlinerRow>
      <button type="button" onClick={activation.engageTitle}>
        Edit title
      </button>
      <button type="button" onClick={activation.releaseTitle}>
        Leave title
      </button>
    </>
  );
}

function NestedDisclosureShortcutHarness() {
  const [outerExpanded, setOuterExpanded] = useState(true);
  const [innerExpanded, setInnerExpanded] = useState(false);

  return (
    <PageOutlinerRow
      targetBlockId="outer-page"
      plainTitle="Outer Page"
      title={<span data-testid="outer-title">Outer Page</span>}
      expanded={outerExpanded}
      expandable
      active
      onExpandedChange={setOuterExpanded}
    >
      <PageOutlinerRow
        targetBlockId="inner-page"
        plainTitle="Inner Page"
        title={<span data-testid="inner-title">Inner Page</span>}
        expanded={innerExpanded}
        expandable
        active
        onExpandedChange={setInnerExpanded}
      >
        Inner body
      </PageOutlinerRow>
    </PageOutlinerRow>
  );
}

describe("Page outliner surface", () => {
  test("toggles disclosure from the Page header with either platform modifier", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const view = render(
      <ActivationHarness
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        renderActive={() => <div data-testid="target-runtime" />}
        titleNode={
          <div
            contentEditable
            suppressContentEditableWarning
            data-embedded-surface-input="page-title"
            data-testid="live-title"
          >
            Rich title
          </div>
        }
      />,
    );
    const title = view.getByTestId("live-title");

    await act(async () => {
      fireEvent.keyDown(title, { key: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Collapse Rich title" })).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Expand Rich title" })).toBeTruthy();
  });

  test("lets a nested Page header toggle without collapsing its parent", async () => {
    const view = render(<NestedDisclosureShortcutHarness />);

    await act(async () => {
      fireEvent.keyDown(view.getByTestId("inner-title"), {
        key: "Enter",
        metaKey: true,
      });
      await Promise.resolve();
    });

    expect(view.getByRole("button", { name: "Collapse Outer Page" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Collapse Inner Page" })).toBeTruthy();
  });

  test("ignores modified Enter variants reserved for other commands", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const view = render(
      <ActivationHarness
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        renderActive={() => null}
      />,
    );

    await act(async () => {
      fireEvent.keyDown(view.getByText("Rich title"), {
        key: "Enter",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });

    expect(view.getByRole("button", { name: "Expand Rich title" })).toBeTruthy();
  });

  test("admits target content only while the local row is expanded", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const renderActive = vi.fn(() => <div data-testid="target-runtime" />);
    const view = render(
      <ActivationHarness
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        renderActive={renderActive}
      />,
    );

    expect(view.queryByTestId("target-runtime")).toBeNull();
    expect(renderActive).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Expand Rich title" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByTestId("target-runtime")).toBeTruthy();
      expect(renderActive).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Collapse Rich title" }));
      await Promise.resolve();
    });
    expect(view.queryByTestId("target-runtime")).toBeNull();
  });

  test("activates an authoritative title session without disclosing the body", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const renderActive = vi.fn(() => <div data-testid="target-runtime" />);
    const view = render(
      <ActivationHarness
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        renderActive={renderActive}
      />,
    );
    const frame = view.container.querySelector<HTMLElement>("[data-page-outliner-target='target']");
    if (!frame) throw new Error("Missing Page outliner frame");

    expect(frame.dataset.pageOutlinerActive).toBe("false");
    expect(frame.dataset.pageOutlinerExpanded).toBe("false");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit title" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(frame.dataset.pageOutlinerActive).toBe("true"));
    expect(frame.dataset.pageOutlinerExpanded).toBe("false");
    expect(renderActive).toHaveBeenCalled();
    expect(view.queryByTestId("target-runtime")).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Leave title" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(frame.dataset.pageOutlinerActive).toBe("false"));
  });

  test("keeps navigation available when inline expansion is disabled", () => {
    const open = vi.fn();
    const view = render(
      <PageOutlinerRow
        targetBlockId="cycle"
        plainTitle="Cycle Page"
        title="Cycle Page"
        stateLabel="Cycle"
        expanded={false}
        expandable={false}
        active={false}
        onExpandedChange={() => undefined}
        onOpenPage={open}
      />,
    );

    expect(
      (
        view.getByRole("button", {
          name: "Expand Cycle Page",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Open Cycle Page" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("shares one disclosure preference while keeping duplicate mounts independently active", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(2);
    const view = render(
      <>
        <ActivationHarness
          title="First instance"
          disclosureKey="same-semantic-reference"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          renderActive={() => <div data-testid="duplicate-runtime">First</div>}
        />
        <ActivationHarness
          title="Second instance"
          disclosureKey="same-semantic-reference"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          renderActive={() => <div data-testid="duplicate-runtime">Second</div>}
        />
      </>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Expand First instance" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getAllByTestId("duplicate-runtime")).toHaveLength(2);
      expect(activationBudget.getActiveKeys()).toHaveLength(2);
    });
  });

  test("retains the preferred disclosure while the target is temporarily unavailable", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    disclosureStore.setExpanded("stable-page", true);
    const makeHarness = (expandable: boolean) => (
      <ActivationHarness
        disclosureKey="stable-page"
        expandable={expandable}
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        renderActive={() => <div data-testid="restored-runtime" />}
      />
    );
    const view = render(makeHarness(false));

    expect(view.queryByTestId("restored-runtime")).toBeNull();
    expect(disclosureStore.isExpanded("stable-page")).toBe(true);

    view.rerender(makeHarness(true));
    await waitFor(() => {
      expect(view.getByTestId("restored-runtime")).toBeTruthy();
    });
  });

  test("renders portable formatting and title-safe atoms without a provider", () => {
    const view = render(
      <PortableRichTitle
        value={[
          { type: "text", text: "Bold", styles: { bold: true } },
          {
            type: "link",
            text: " link",
            href: "https://nodex.dev",
            styles: {},
          },
          { type: "threadMention", uuid: "thread-123456789" },
        ]}
      />,
    );

    expect(view.getByText("Bold")).toBeTruthy();
    expect(
      view.container
        .querySelector("[data-portable-rich-title-link]")
        ?.getAttribute("data-portable-rich-title-link"),
    ).toBe("https://nodex.dev");
    expect(view.getByText("@thread-1")).toBeTruthy();
  });
});
