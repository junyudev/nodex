import { expect, test } from "vite-plus/test";
import { trafficSource } from "./traffic-source";

const website = "https://nodex.jyu.app";
const externalReferrer = "https://www.example.org:8443/private/path?secret=value#fragment";

test.each([
  ["?utm_source=%20GitHub.Release_1%20&ref=other", "github.release_1"],
  ["?ref=News-Letter", "news-letter"],
  ["?utm_source=&ref=Forum", "forum"],
  ["?utm_source=alice%40example.org&ref=Forum", "forum"],
  ["?utm_source=https%3A%2F%2Fexample.org%2Fpath", "example.org"],
  ["?utm_source=with%20spaces&ref=%E6%96%B0%E9%97%BB", "example.org"],
  [`?utm_source=${"A".repeat(64)}`, "a".repeat(64)],
  [`?utm_source=${"A".repeat(65)}`, "example.org"],
  ["?utm_medium=social", "example.org"],
])("derives a safe campaign or host from %s", (query, expected) => {
  expect(trafficSource(new URL(website + query), externalReferrer)).toBe(expected);
});

test.each([
  [externalReferrer, "example.org"],
  ["https://github.com/org/repo?secret=value", "github.com"],
  ["https://www.nodex.jyu.app./zh-cn/", "internal"],
  [`${website}/download/?utm_source=prior-campaign`, "internal"],
  ["https://other.jyu.app/path", "other.jyu.app"],
  ["https://nodex.jyu.app.example.org/path", "nodex.jyu.app.example.org"],
  ["file:///private/personal.html", "direct"],
  ["malformed-referrer", "direct"],
  ["", "direct"],
])("derives a visit source from referrer %s", (referrer, expected) => {
  expect(trafficSource(new URL(website), referrer)).toBe(expected);
});

test("an explicit campaign takes precedence over an internal referrer", () => {
  expect(trafficSource(new URL(website + "?utm_source=Campaign"), website + "/changelog/")).toBe(
    "campaign",
  );
});
