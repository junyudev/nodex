import { useEffect } from "react";
import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import {
  InlineVisualizationFollowUpReview,
  useInlineVisualizationFollowUpReview,
} from "./inline-visualization-follow-up-review";

type Review = ReturnType<typeof useInlineVisualizationFollowUpReview>["review"];
function Harness({ expose }: { expose: (review: Review) => void }) {
  const flow = useInlineVisualizationFollowUpReview();
  useEffect(() => expose(flow.review), [expose, flow.review]);
  return <InlineVisualizationFollowUpReview request={flow.request} settle={flow.settle} />;
}

describe("inline visualization follow-up review", () => {
  test("returns the edited prompt only after Send and settles Cancel without sending", async () => {
    let review: Review = async () => {
      throw new Error("Review is not mounted");
    };
    render(
      <Harness
        expose={(value) => {
          review = value;
        }}
      />,
    );
    let result!: Promise<string | null>;
    await act(async () => {
      result = review({ prompt: "Widget proposal" });
      await Promise.resolve();
    });
    const message = await screen.findByRole("textbox", { name: "Message" });
    await act(async () => {
      fireEvent.change(message, { target: { value: "User edited proposal" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    expect(await result).toBe("User edited proposal");
    await act(async () => {
      result = review({ prompt: "Another proposal" });
      await Promise.resolve();
    });
    await screen.findByRole("textbox", { name: "Message" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(await result).toBeNull();
  });
  test("settles an outstanding request when the document consumer leaves", async () => {
    let review: Review = async () => {
      throw new Error("Review is not mounted");
    };
    const mounted = render(
      <Harness
        expose={(value) => {
          review = value;
        }}
      />,
    );
    let result!: Promise<string | null>;
    await act(async () => {
      result = review({ prompt: "Pending proposal" });
      await Promise.resolve();
    });
    await screen.findByRole("textbox", { name: "Message" });
    await act(async () => {
      mounted.unmount();
      await Promise.resolve();
    });
    expect(await result).toBeNull();
  });
});
