import { expect, test } from "vite-plus/test";
import { ProductEvent } from "../../src/shared/product-analytics/catalog";
import { DASHBOARD_WIDGETS } from "./product-dashboard";

const CATALOG = new Set(ProductEvent.options.map((event) => event.shape.name.value));
/** Reported by the website and the distribution workflow, which never count as installations. */
const ANONYMOUS_EVENTS = new Set([
  "landing_viewed",
  "landing_download_clicked",
  "distribution_downloads",
  "update_feed_requests",
]);

const chartedEvents = DASHBOARD_WIDGETS.flatMap((widget) => {
  if (widget.type === "funnel")
    return widget.query.steps.map((step) => ({
      event: step.event_name,
      unit: widget.query.unit_type,
    }));
  if (widget.type !== "drilldown") return [];
  return widget.query.series.map((series) => ({
    event: series.source.event_name,
    unit: series.unit_type,
  }));
});

test("every chart reads an event something actually reports", () => {
  expect(chartedEvents.length).toBeGreaterThan(0);
  for (const { event } of chartedEvents) {
    expect(CATALOG.has(event as never) || ANONYMOUS_EVENTS.has(event), event).toBe(true);
  }
});

test("charts count installations and anonymous rows by the identity each one carries", () => {
  for (const { event, unit } of chartedEvents) {
    expect(unit, event).toBe(ANONYMOUS_EVENTS.has(event) ? "stableID" : "user_id");
  }
});

test("the answers to the core product questions stay on the dashboard", () => {
  const titles = DASHBOARD_WIDGETS.map((widget) => widget.title);
  expect(titles).toEqual(
    expect.arrayContaining(["New installations", "Active installations", "Conversations started"]),
  );
});
