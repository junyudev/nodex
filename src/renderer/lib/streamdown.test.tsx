import { describe, expect, test } from "bun:test";
import { StreamdownMermaidError } from "./streamdown";
import { render, textContent } from "../test/dom";

describe("StreamdownMermaidError", () => {
  test("renders a safe mermaid error fallback", () => {
    const { container } = render(
      <StreamdownMermaidError
        chart={"graph TD\nA-->B"}
        error="Invalid Mermaid diagram."
        retry={() => {}}
      />,
    );

    expect(textContent(container).includes("Mermaid Error")).toBeTrue();
    expect(textContent(container).includes("Invalid Mermaid diagram.")).toBeTrue();
  });
});
