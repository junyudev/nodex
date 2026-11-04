import { render, screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import "@/globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";

installRendererThemeFixture();

test("a text area that scrolls has the app's scrollbar without asking for it", () => {
  render(<textarea aria-label="Field" className="max-h-10" readOnly value={"line\n".repeat(40)} />);
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Field" });

  expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
  // The thumb's shade follows the pointer; a clear track is what sets it apart from the platform's.
  expect(getComputedStyle(field).scrollbarColor).toMatch(/ rgba\(0, 0, 0, 0\)$/u);
});
