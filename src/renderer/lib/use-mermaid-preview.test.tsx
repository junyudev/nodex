import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { renderMermaidDiagram } from "./mermaid-runtime";
import { useMermaidPreview } from "./use-mermaid-preview";

vi.mock("./mermaid-runtime", () => ({
  MermaidRenderError: class extends Error {},
  renderMermaidDiagram: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("clears a disabled preview and ignores a render that finishes after clearing", async () => {
  vi.useFakeTimers();
  let finish!: (value: { svg: string; width: number; height: number }) => void;
  vi.mocked(renderMermaidDiagram).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ source, enabled }) => useMermaidPreview(source, "light", enabled),
    { initialProps: { source: "graph TD; A-->B", enabled: true } },
  );
  await act(async () => vi.advanceTimersByTime(300));
  expect(result.current.status).toBe("rendering");
  rerender({ source: "graph TD; A-->B", enabled: false });
  expect(result.current.status).toBe("empty");
  await act(async () => finish({ svg: "<svg/>", width: 10, height: 10 }));
  expect(result.current.status).toBe("empty");
  rerender({ source: "  ", enabled: true });
  await act(async () => vi.advanceTimersByTime(300));
  expect(result.current.status).toBe("empty");
  expect(renderMermaidDiagram).toHaveBeenCalledOnce();
});
