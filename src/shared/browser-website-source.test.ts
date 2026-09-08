import { describe, expect, test } from "vite-plus/test";
import { resolveBrowserWebsiteSourceIconId } from "./browser-website-source";

describe("Browser website source identity", () => {
  test("identifies exact domains and their subdomains while keeping Google products distinct", () => {
    expect(resolveBrowserWebsiteSourceIconId("https://www.github.com/openai")).toBe("github");
    expect(resolveBrowserWebsiteSourceIconId("https://mail.google.com/inbox")).toBe("gmail");
    expect(resolveBrowserWebsiteSourceIconId("https://calendar.google.com/calendar")).toBe(
      "googleCalendar",
    );
    expect(resolveBrowserWebsiteSourceIconId("https://docs.google.com/document/one")).toBe(
      "googleDrive",
    );
    expect(resolveBrowserWebsiteSourceIconId("https://slides.google.com/presentation/one")).toBe(
      "googleDrive",
    );
    expect(resolveBrowserWebsiteSourceIconId("https://workspace.force.com/record")).toBe(
      "salesforce",
    );
  });
  test("does not infer a known source from lookalike hosts, paths or non-web URLs", () => {
    for (const href of [
      "https://notgithub.com",
      "https://github.com.evil.example",
      "https://example.com/github.com",
      "file:///github.com",
      "github.com",
      "https://example.com",
    ]) {
      expect(resolveBrowserWebsiteSourceIconId(href)).toBeNull();
    }
  });
});
