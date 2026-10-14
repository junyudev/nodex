import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { WorkspacePierreEditor } from "@/features/workspace-files/workspace-pierre-editor";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  TYPOGRAPHY_STORAGE_KEY,
  writeTypographyPreferences,
} from "@/lib/typography-preferences";
import { TypographyProvider, useTypographyPreferences } from "@/lib/use-typography-preferences";
import { SourceViewer } from "./source-viewer";
import "@/globals.css";

installRendererThemeFixture();
afterEach(() => {
  localStorage.removeItem(TYPOGRAPHY_STORAGE_KEY);
  document.body.replaceChildren();
});

function CodePreferenceControl() {
  const { setFontSize } = useTypographyPreferences();
  return <button onClick={() => setFontSize("code", 18)}>Resize source</button>;
}

test("keeps read-only and editable source rows aligned when the code preference changes", async () => {
  writeTypographyPreferences(DEFAULT_TYPOGRAPHY_PREFERENCES);
  const view = renderWithAppMaitai(
    <TypographyProvider>
      <CodePreferenceControl />
      <div style={{ height: 200, width: 600 }}>
        <SourceViewer value={"first\nsecond\nthird"} ariaLabel="Read-only source" />
      </div>
      <div style={{ height: 200, width: 600 }}>
        <WorkspacePierreEditor
          value={"first\nsecond\nthird"}
          filename="fixture.txt"
          language={null}
          sourceIdentity="fixture.txt"
          documentVersion={0}
          ariaLabel="Editable source"
          onChange={() => undefined}
        />
      </div>
    </TypographyProvider>,
  );
  const lineStyle = (label: string) => {
    const root = view.getByRole("region", { name: label });
    const line = root.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line]");
    if (!line) throw new Error(`Source rows are not ready for ${label}`);
    return getComputedStyle(line);
  };
  try {
    await waitFor(() => {
      expect(lineStyle("Read-only source").fontSize).toBe("12px");
      expect(lineStyle("Read-only source").lineHeight).toBe("21.6px");
      expect(lineStyle("Editable source").fontSize).toBe("12px");
      expect(lineStyle("Editable source").lineHeight).toBe("22px");
    });

    await act(async () => {
      view.getByRole("button", { name: "Resize source" }).click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(lineStyle("Read-only source").fontSize).toBe("18px");
      expect(lineStyle("Read-only source").lineHeight).toBe("32.4px");
      expect(lineStyle("Editable source").fontSize).toBe("18px");
      expect(lineStyle("Editable source").lineHeight).toBe("32px");
    });
  } finally {
    view.unmount();
  }
});
