import { expect, test } from "vite-plus/test";
import { readWebSearchSources } from "./codex-web-search";

test("keeps ordered, unique search hits with safe web addresses", () => {
  expect(
    readWebSearchSources([
      null,
      "not a result",
      { type: "text_result", url: "file:///tmp/page", title: "Local page" },
      { type: "text_result", url: "https://member:secret@example.com/private" },
      { type: "text_result", url: "/relative" },
      { url: "https://example.com/preview", snippet: "Page preview" },
      { url: "https://example.com/blank", title: "   " },
      { type: "image_result", url: "https://example.com/image", title: "Picture" },
      { url: "  HTTPS://WWW.EXAMPLE.COM:443/notes?q=1  ", title: " Notes " },
      { type: "text_result", url: "https://www.example.com/notes?q=1", title: "Duplicate" },
      { type: "text_result", url: "http://example.org/source" },
    ]),
  ).toEqual([
    { url: "https://www.example.com/notes?q=1", title: "Notes", label: "example.com/notes" },
    { url: "http://example.org/source", title: null, label: "example.org/source" },
  ]);
});
