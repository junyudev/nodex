import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { MarkdownRenderer } from "./markdown-renderer";

const trace = vi.hoisted(() => ({ rendered: [] as string[], clicked: [] as string[] }));
vi.mock("./markdown-core", () => ({
  MarkdownCore: ({ content }: { content: string }) => {
    trace.rendered.push(content);
    return <button onClick={() => trace.clicked.push(content)}>Copy source</button>;
  },
}));

test("compiled Markdown wrapper reuses stable child input and updates changed input", async () => {
  trace.rendered.length = 0;
  trace.clicked.length = 0;
  const view = render(<MarkdownRenderer content="first" className="first-wrapper" />);
  try {
    expect(trace.rendered).toEqual(["first"]);
    const button = view.getByRole("button", { name: "Copy source" });
    trace.rendered.length = 0;
    view.rerender(<MarkdownRenderer content="first" className="changed-wrapper" />);
    expect(trace.rendered).toEqual([]);
    expect(view.getByRole("button", { name: "Copy source" })).toBe(button);
    view.rerender(<MarkdownRenderer content="second" className="changed-wrapper" />);
    expect(trace.rendered).toEqual(["second"]);
    expect(view.getByRole("button", { name: "Copy source" })).toBe(button);
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(trace.clicked).toEqual(["second"]);
  } finally {
    view.unmount();
  }
});
