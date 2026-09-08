import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { CodexConversationItem } from "../../../../lib/types";
import { render, settleAsyncRender, textContent } from "../../../../test/dom";
import {
  AutomaticApprovalReviewRow,
  AutomaticApprovalReviewSurface,
} from "./automatic-approval-review-surface";

function buildReviewItem(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-review",
    entryId: "item-review",
    type: "automaticApprovalReview",
    kind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    rawItem: {
      targetItemId: "item-command",
      review: {
        status: "approved",
        riskScore: 0.11,
        riskLevel: "low",
        rationale: "Only local tests are executed.",
      },
      action: {
        type: "command",
        source: "shell",
        command: "bun test",
        cwd: "/tmp/project",
      },
    },
    ...overrides,
  };
}

function disclosureBody(trigger: HTMLElement): HTMLElement | null {
  return trigger.parentElement?.nextElementSibling as HTMLElement | null;
}

describe("AutomaticApprovalReviewSurface", () => {
  test("renders the standalone action activity with the compact review row nested inside", async () => {
    const item = buildReviewItem();
    const { getByRole, container } = render(<AutomaticApprovalReviewSurface item={item} />);

    const trigger = getByRole("button", { name: "bun test" });
    const summary = textContent(container);
    expect(summary.includes("bun test")).toBe(true);
    expect(summary.includes("Auto-review approved")).toBe(true);
    expect(summary.includes("Automatic approval review")).toBe(false);
    expect(summary.includes("Low risk")).toBe(false);
    expect(summary.includes("Only local tests are executed.")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("false");

    const reviewTrigger =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
        (button) => textContent(button).includes("Auto-review approved"),
      ) ?? null;
    expect(reviewTrigger === null).toBe(false);
    expect(reviewTrigger?.getAttribute("aria-expanded") ?? "").toBe("false");

    fireEvent.click(reviewTrigger as HTMLButtonElement);
    await settleAsyncRender();
    expect(textContent(container).includes("Only local tests are executed.")).toBe(true);
  });

  test("uses the request fallback summary and directly explains high-risk authorization", async () => {
    const item = buildReviewItem({
      rawItem: {
        targetItemId: "item-command",
        review: {
          status: "denied",
          riskScore: 0.9,
          riskLevel: "high",
          rationale: "The request edits outside the workspace.",
        },
        action: null,
      },
    });

    const { getByRole, getByText, queryByRole, queryByText } = render(
      <AutomaticApprovalReviewSurface item={item} />,
    );
    const trigger = getByRole("button", { name: "Request" });
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    expect(
      getByText("Requires explicit authorization because this action is considered high risk"),
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Auto-review denied high risk" })).toBeNull();
    expect(queryByText("The request edits outside the workspace.")).toBeNull();
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("false");
  });

  test("keeps the reviewed action shimmering from canonical review status", async () => {
    const item = buildReviewItem({
      status: "completed",
      rawItem: {
        targetItemId: "item-command",
        review: {
          status: "inProgress",
          riskScore: 0.45,
          riskLevel: "medium",
          rationale: null,
        },
        action: {
          type: "command",
          source: "shell",
          command: "bun test",
          cwd: "/tmp/project",
        },
      },
    });

    const { getByRole, container } = render(<AutomaticApprovalReviewSurface item={item} />);
    const trigger = getByRole("button", { name: "bun test" });
    const content = textContent(container);
    expect(content.includes("bun test")).toBe(true);
    expect(content.includes("Auto-reviewing")).toBe(true);
    expect(content.includes("Medium risk")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".codex-cadenced-shimmer") === null).toBe(false);

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
    expect(textContent(container).includes("Auto-reviewing")).toBe(true);
    expect(textContent(container).includes("Medium risk")).toBe(false);
    expect(disclosureBody(trigger)?.getAttribute("aria-hidden")).toBe("false");
  });

  test("renders the compact non-expandable branch as title text only", () => {
    const item = buildReviewItem();
    const { container, queryByRole } = render(
      <AutomaticApprovalReviewRow item={item} isExpandable={false} />,
    );

    expect(queryByRole("button") === null).toBe(true);
    expect(textContent(container).includes("Auto-review approved")).toBe(true);
    expect(textContent(container).includes("Only local tests are executed.")).toBe(false);
  });
});
