import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StatusChip,
  StatusIcon,
  createStatusIconElement,
  getStatusAccentColorByLabel,
  getStatusIdByLabel,
} from "./status-chip";

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

describe("status chip", () => {
  test("renders the shared in-review chip with an icon and label", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusChip, {
        statusId: "in_review",
      }),
    );

    expect(markup.includes("In Review")).toBeTrue();
    expect(markup.includes("<svg")).toBeTrue();
    expect(markup.includes("status-review-bg")).toBeTrue();
  });

  test("renders the draft icon as decorative svg markup", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusIcon, {
        statusId: "draft",
      }),
    );

    expect(markup.includes('aria-hidden="true"')).toBeTrue();
    expect(markup.includes("<path")).toBeTrue();
  });

  test("creates a DOM icon element for editor-rendered status chips", () => {
    const icon = createStatusIconElement("done", {
      documentRef: createMockDocument(),
    });

    expect(icon.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelectorAll("path").length).toBe(2);
  });

  test("maps status labels back to shared status metadata", () => {
    expect(getStatusIdByLabel("Backlog")).toBe("backlog");
    expect(getStatusAccentColorByLabel("Done")).toBe("var(--status-done-dot)");
  });
});
