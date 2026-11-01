import { describe, expect, test } from "vite-plus/test";
import { StatusLabel, StatusIcon, createStatusIconElement } from "./status-presentation";
import { render } from "../test/dom";

type MockSvgNode = {
  namespaceURI: string | null;
  tagName: string;
  style: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  appendChild: (child: MockSvgNode) => MockSvgNode;
  querySelectorAll: (selector: string) => MockSvgNode[];
};

function createMockDocument(): Document {
  const createNode = (tagName: string, namespaceURI: string | null): MockSvgNode => {
    const attributes = new Map<string, string>();
    const children: MockSvgNode[] = [];

    return {
      namespaceURI,
      style: {},
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      getAttribute(name: string) {
        return attributes.get(name) ?? null;
      },
      appendChild(child: ReturnType<typeof createNode>) {
        children.push(child);
        return child;
      },
      querySelectorAll(selector: string) {
        return children.filter((child) => child.tagName === selector);
      },
      tagName,
    };
  };

  return {
    createElementNS(namespaceURI: string, qualifiedName: string) {
      return createNode(qualifiedName, namespaceURI);
    },
  } as unknown as Document;
}

describe("status presentation", () => {
  test("renders the shared in-review label with an icon and text", () => {
    const { container, getByText } = render(<StatusLabel statusId="review" />);

    expect(getByText("Review").textContent).toBe("Review");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("renders the triage icon as decorative svg markup", () => {
    const { container } = render(<StatusIcon statusId="triage" />);
    const icon = container.querySelector("svg");

    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 14 14");
    expect(container.querySelector("path")).not.toBeNull();
  });

  test("renders plan through review as one progressively filled ring family", () => {
    const { container } = render(<StatusIcon statusId="review" />);
    const ring = container.querySelector("rect");
    const sector = container.querySelector("path");

    expect(ring?.getAttribute("x")).toBe("1");
    expect(ring?.getAttribute("width")).toBe("12");
    expect(ring?.getAttribute("stroke-width")).toBe("1.5");
    expect(sector?.getAttribute("d")).toContain("A3.5,3.5 0 1,1");
    expect(sector?.getAttribute("transform")).toBe("translate(3.5,3.5)");
  });

  test("creates the filled completed icon for editor-rendered status labels", () => {
    const icon = createStatusIconElement("done", {
      documentRef: createMockDocument(),
    });

    expect(icon.getAttribute("viewBox")).toBe("0 0 14 14");
    expect(icon.getAttribute("width")).toBe("14");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelectorAll("path").length).toBe(1);
    expect(icon.querySelectorAll("path")[0]?.getAttribute("fill-rule")).toBe("evenodd");
  });

  test("creates stroked progress geometry through the DOM renderer", () => {
    const icon = createStatusIconElement("doing", {
      documentRef: createMockDocument(),
    });
    const ring = icon.querySelectorAll("rect")[0];
    const sector = icon.querySelectorAll("path")[0];

    expect(ring?.getAttribute("fill")).toBe("none");
    expect(ring?.getAttribute("stroke")).toBe("currentColor");
    expect(ring?.getAttribute("stroke-width")).toBe("1.5");
    expect(sector?.getAttribute("stroke")).toBe("none");
    expect(sector?.getAttribute("transform")).toBe("translate(3.5,3.5)");
  });

  test("keeps renamed labels independent from the stage visual", () => {
    const { container, getByText } = render(<StatusLabel statusId="doing" label="Done" />);
    expect(getByText("Done")).toBeTruthy();
    expect(container.querySelector("svg")?.style.color).toBe("var(--status-doing-dot)");
  });
});
