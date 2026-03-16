import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamdownMermaidError } from "./streamdown";

describe("StreamdownMermaidError", () => {
  test("renders a safe mermaid error fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(StreamdownMermaidError, {
        chart: "graph TD\nA-->B",
        error: "Invalid Mermaid diagram.",
        retry: () => {},
      }),
    );

    expect(markup.includes("Mermaid Error")).toBeTrue();
    expect(markup.includes("Invalid Mermaid diagram.")).toBeTrue();
  });
});
