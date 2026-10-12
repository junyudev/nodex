import { describe, expect, test } from "vite-plus/test";
import {
  MERMAID_RUNTIME_CONFIG,
  MermaidRenderError,
  renderMermaidDiagram,
  sanitizeMermaidSvg,
} from "./mermaid-runtime";

describe("Mermaid runtime", () => {
  test("owns an immutable strict security boundary", () => {
    expect(MERMAID_RUNTIME_CONFIG).toMatchObject({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      maxTextSize: 500_000,
      maxEdges: 1_500,
      htmlLabels: false,
    });
    expect(MERMAID_RUNTIME_CONFIG.secure).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "themeCSS",
      ]),
    );
  });

  test("removes executable and remote SVG surfaces before preview or export", () => {
    const svg = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
        <style>@import url(https://example.com/x.css); .a{fill:url(https://example.com/x)}</style>
        <a href="javascript:alert(1)"><path style="fill:url(data:image/svg+xml,x)" /></a>
        <set attributeName="href" to="javascript:alert(1)" />
        <use href="#safe" />
      </svg>
    `);

    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("script, foreignObject, set")).toBeNull();
    expect(document.querySelector("[onload]")).toBeNull();
    expect(document.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(document.querySelector('[href]:not([href^="#"])')).toBeNull();
    expect(document.querySelector("style")?.textContent).not.toMatch(
      /@import|https?:|javascript:/iu,
    );
    expect(document.querySelector("path")?.getAttribute("style")).not.toMatch(/data:/iu);
    const root = document.documentElement;
    expect(root.getAttribute("height")).toBeNull();
    expect(root.getAttribute("width")).toBe("100%");
    expect(root.getAttribute("style")).toBe("max-width:10px;height:auto;");
  });

  test("renders concurrent diagrams without crossing their output and rejects invalid source", async () => {
    const [first, second] = await Promise.all([
      renderMermaidDiagram({ source: "graph TD\n  Alpha --> Beta", theme: "light" }),
      renderMermaidDiagram({ source: "graph LR\n  Gamma --> Delta", theme: "dark" }),
    ]);

    expect(first.svg).toContain("Alpha");
    expect(first.svg).not.toContain("Gamma");
    expect(second.svg).toContain("Gamma");
    expect(second.svg).not.toContain("Alpha");
    const firstSvg = new DOMParser().parseFromString(first.svg, "image/svg+xml").documentElement;
    expect(Number.parseFloat(firstSvg.style.maxWidth)).toBeCloseTo(first.width, 2);
    expect(document.querySelector('[id^="nodex-mermaid-"]')).toBeNull();

    await expect(
      renderMermaidDiagram({ source: "definitely not Mermaid", theme: "light" }),
    ).rejects.toBeInstanceOf(MermaidRenderError);
  });

  test("keeps architecture group IDs from changing object prototypes", async () => {
    const marker = "nodexArchitecturePollutionMarker";
    try {
      const result = await renderMermaidDiagram({
        source: `architecture-beta
          group __proto__(cloud)[Prototype]
          group ${marker}(cloud)[Group]
          service a(server)[A] in __proto__
          service b(server)[B] in ${marker}
          a:R -- L:b`,
        theme: "light",
      });

      expect(
        new DOMParser().parseFromString(result.svg, "image/svg+xml").querySelector("svg"),
      ).not.toBeNull();
      expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, marker);
    }
  });

  test("bounds radar ticks requested by diagram source", async () => {
    const result = await renderMermaidDiagram({
      source: "radar-beta\n  axis a, b\n  curve c {1, 1}\n  ticks 1000",
      theme: "light",
    });
    const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");

    expect(svg.querySelectorAll("circle, polygon").length).toBeGreaterThan(0);
    expect(svg.querySelectorAll("circle, polygon").length).toBeLessThanOrEqual(33);
  });

  test("renders an XY chart with a zero-width axis range", async () => {
    const result = await renderMermaidDiagram({
      source: "xychart\n  x-axis 1 --> 1\n  line [1, 2]",
      theme: "light",
    });

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(document.querySelector('[id^="nodex-mermaid-"]')).toBeNull();
  });
});
