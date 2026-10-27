import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import { WorkspacePdfPreview } from "./workspace-pdf-preview";

describe("WorkspacePdfPreview browser runtime", () => {
  test("loads the bundled PDF.js worker and renders canvas plus selectable text", async () => {
    const fileDataUrl = buildPdfDataUrl("Nodex PDF Preview");
    const openExternalLink = vi.fn();
    const view = render(
      <div style={{ width: 820, height: 640 }}>
        <WorkspacePdfPreview
          fileDataUrl={fileDataUrl}
          title="runtime-check.pdf"
          onOpenExternalLink={openExternalLink}
        />
      </div>,
    );

    const preview = await waitForAct(() =>
      view.getByLabelText("PDF preview for runtime-check.pdf"),
    );
    await waitForAct(() => {
      const canvas = preview.querySelector("canvas");
      expect(canvas).not.toBeNull();
      expect(canvas?.width ?? 0).toBeGreaterThan(0);
      expect(canvas?.height ?? 0).toBeGreaterThan(0);
      expect(preview.querySelector(".textLayer")?.textContent).toContain("Nodex PDF Preview");
      const text = preview.querySelector<HTMLElement>('.textLayer span[role="presentation"]');
      if (text === null) throw new Error("Expected selectable PDF text");
      const page = text.closest<HTMLElement>("[data-workspace-pdf-page]")!;
      const scale = page.getBoundingClientRect().width / 612;
      expect(Number.parseFloat(getComputedStyle(text).fontSize)).toBeCloseTo(24 * scale, 1);
      expect(text.getBoundingClientRect().width).toBeGreaterThan(100 * scale);
      expect(
        preview.querySelector<HTMLAnchorElement>(
          '.annotationLayer a[href="https://example.com/spec"]',
        ),
      ).not.toBeNull();
    });

    const externalLink = preview.querySelector<HTMLAnchorElement>(
      '.annotationLayer a[href="https://example.com/spec"]',
    );
    if (externalLink === null) throw new Error("Expected the PDF annotation link");
    await act(async () => {
      fireEvent.click(externalLink);
      await Promise.resolve();
    });
    expect(openExternalLink).toHaveBeenCalledWith("https://example.com/spec");

    const pageLink = preview.querySelector<HTMLAnchorElement>(
      '.annotationLayer a:not([target="_blank"])',
    );
    if (pageLink === null) throw new Error("Expected the PDF page destination link");
    await act(async () => {
      fireEvent.click(pageLink);
      await Promise.resolve();
    });
    await waitForAct(() => expect(view.getByText("2/2")).not.toBeNull());
  });
});

async function waitForAct<T>(read: () => T, timeout = 10_000): Promise<T> {
  const deadline = performance.now() + timeout;
  let lastError: unknown = new Error("Timed out waiting for the PDF preview");
  while (performance.now() < deadline) {
    try {
      return read();
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    });
  }
  throw lastError;
}

function buildPdfDataUrl(text: string): string {
  const content = `BT\n/F1 24 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R 8 0 R] >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 680 280 710] /Border [0 0 0] /A << /S /URI /URI (https://example.com/spec) >> >>\nendobj\n",
    "7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    "8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 630 280 660] /Border [0 0 0] /Dest [7 0 R /Fit] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefOffset = body.length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  const pdf = `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return `data:application/pdf;base64,${window.btoa(pdf)}`;
}
