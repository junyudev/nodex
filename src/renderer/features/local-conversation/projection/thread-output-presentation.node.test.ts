import { describe, expect, test } from "vitest";
import { describeThreadOutput, resolveThreadOutputOpenAction } from "./thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "./thread-summary-panel-output-model";

const cwd = "/Users/ada/repo/nodex";

function file(path: string, kind: "file" | "image" | "generated-image" = "file") {
  const label = path.slice(path.lastIndexOf("/") + 1);
  return { id: `${kind}:${path}`, kind, path, label, title: path } as const;
}

describe("describeThreadOutput", () => {
  test("names a generic entry file by its folder and locates it from the working directory", () => {
    expect(
      describeThreadOutput(
        file(`${cwd}/notes.local/artifacts/new-tab-page/report/index.html`),
        cwd,
      ),
    ).toEqual({
      title: "report/index.html",
      kind: "HTML",
      location: { head: "notes.local/artifacts/", tail: "new-tab-page" },
      iconPath: `${cwd}/notes.local/artifacts/new-tab-page/report/index.html`,
    });
  });

  test("spells locations outside the working directory from home and omits the working directory itself", () => {
    expect(describeThreadOutput(file("/Users/ada/Desktop/brief.pdf"), cwd)).toMatchObject({
      title: "brief.pdf",
      kind: "PDF",
      location: { head: "~/", tail: "Desktop" },
    });
    expect(describeThreadOutput(file(`${cwd}/summary.md`), cwd)).toMatchObject({
      title: "summary.md",
      kind: "Markdown",
      location: null,
    });
    expect(describeThreadOutput(file("/tmp/out/data.parquet"), cwd)).toMatchObject({
      kind: "PARQUET",
      location: { head: "/tmp/", tail: "out" },
    });
  });

  test("keeps a generic name bare when it has no named parent", () => {
    expect(describeThreadOutput(file("/index.html"), cwd)).toMatchObject({
      title: "index.html",
      location: { head: "", tail: "/" },
    });
  });

  test("reads images, generated images and files without an extension", () => {
    expect(describeThreadOutput(file(`${cwd}/shots/after.png`), cwd).kind).toBe("Image");
    expect(
      describeThreadOutput(
        { ...file(`${cwd}/.codex/generated/a.png`, "generated-image"), label: "Generated image 2" },
        cwd,
      ),
    ).toMatchObject({ title: "Generated image 2", kind: "Image" });
    expect(describeThreadOutput(file(`${cwd}/LICENSE`), cwd).kind).toBe("File");
  });

  test("describes web resources without a location or file artwork", () => {
    const website: ThreadSummaryPanelOutputRow = {
      id: "website:http://localhost:5173/",
      kind: "website",
      target: "http://localhost:5173/",
      label: "localhost:5173",
      title: "http://localhost:5173/",
    };
    expect(describeThreadOutput(website, cwd)).toEqual({
      title: "localhost:5173",
      kind: "Website",
      location: null,
      iconPath: null,
    });
    expect(
      describeThreadOutput(
        {
          id: "google-drive:x",
          kind: "google-drive",
          url: "https://docs.google.com/spreadsheets/d/x",
          resourceKind: "spreadsheet",
          label: "Q3 plan",
          title: "https://docs.google.com/spreadsheets/d/x",
        },
        cwd,
      ),
    ).toMatchObject({ title: "Q3 plan", kind: "Google Sheets", iconPath: null });
  });
});

describe("resolveThreadOutputOpenAction", () => {
  test("renders HTML in the default browser and images in the viewer on this device", () => {
    expect(resolveThreadOutputOpenAction(file(`${cwd}/report/index.html`), "local")).toEqual({
      type: "files",
      path: `${cwd}/report/index.html`,
    });
    expect(resolveThreadOutputOpenAction(file(`${cwd}/after.PNG`), "local")).toEqual({
      type: "files",
      path: `${cwd}/after.PNG`,
    });
    expect(resolveThreadOutputOpenAction(file(`${cwd}/notes.md`), "local")).toEqual({
      type: "files",
      path: `${cwd}/notes.md`,
    });
  });

  test("keeps every remote file in Files", () => {
    for (const path of ["/srv/app/index.html", "/srv/app/after.png", "/srv/app/notes.md"])
      expect(resolveThreadOutputOpenAction(file(path), "remote-host")).toEqual({
        type: "files",
        path,
      });
  });

  test("opens web resources as links", () => {
    expect(
      resolveThreadOutputOpenAction(
        {
          id: "appgen-app:p",
          kind: "appgen-app",
          projectId: "p",
          url: "https://app.example.com",
          label: "Example",
          title: "https://app.example.com",
        },
        "local",
      ),
    ).toEqual({ type: "web", url: "https://app.example.com" });
  });
});
