import { describe, expect, test, vi } from "vite-plus/test";
import { sendInlineVisualizationFollowUp } from "./inline-visualization-follow-up";

describe("inline visualization follow-up authorization", () => {
  const setup = (gesture: boolean) => ({
    message: { prompt: "Widget proposal", context: { selected: 3 } },
    sourceId: "application-owned-widget",
    signal: new AbortController().signal,
    consumeGesture: vi.fn(async () => gesture),
    review: vi.fn(async () => "Edited user prompt" as string | null),
    send: vi.fn(async () => {}),
  });
  test("passes gesture-backed content separately with the application-owned source identity", async () => {
    const input = setup(true);
    await sendInlineVisualizationFollowUp(input);
    expect(input.review).not.toHaveBeenCalled();
    expect(input.send).toHaveBeenCalledWith({
      sourceId: input.sourceId,
      prompt: "Widget proposal",
      context: { selected: 3 },
    });
  });
  test("reviews a gesture-free request and sends only the reviewed prompt", async () => {
    const input = setup(false);
    await sendInlineVisualizationFollowUp(input);
    expect(input.review).toHaveBeenCalledWith(input.message, input.signal);
    expect(input.send).toHaveBeenCalledWith({
      sourceId: input.sourceId,
      prompt: "Edited user prompt",
    });
  });
  test("cancellation never dispatches a proposed message", async () => {
    const input = setup(false);
    input.review.mockResolvedValue(null);
    await sendInlineVisualizationFollowUp(input);
    expect(input.send).not.toHaveBeenCalled();
  });
  test("a retired document cannot dispatch after asynchronous authorization or review", async () => {
    const controller = new AbortController();
    const input = { ...setup(false), signal: controller.signal };
    input.review.mockImplementation(async () => {
      controller.abort();
      return "Too late";
    });
    await sendInlineVisualizationFollowUp(input);
    expect(input.send).not.toHaveBeenCalled();
    input.consumeGesture.mockClear();
    await sendInlineVisualizationFollowUp(input);
    expect(input.consumeGesture).not.toHaveBeenCalled();
  });
});
