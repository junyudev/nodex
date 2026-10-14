import { guestDocumentVideoIcon } from "@/components/shared/icons/guest-document-icons";
import calendarStyles from "./inline-visualization-calendar.css?inline";

/** Register synchronously before parsing a calendar fragment. */
function installCalendar(style: string, videoIcon: string) {
  if (customElements.get("viz-calendar")) return;

  const escape = (value: unknown) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        (
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }) as Record<string, string>
        )[char]!,
    );
  const minutes = (value: unknown) => {
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value)) {
      throw new Error("Use HH:MM times between 00:00 and 24:00.");
    }
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  };

  class Calendar extends HTMLElement {
    #initialized = false;
    #events: unknown;
    static observedAttributes = [
      "date",
      "start",
      "end",
      "now",
      "events",
      "lang",
      "time-zone",
      "empty-label",
      "interactive",
    ];

    constructor() {
      super();
      // Replay data assigned before the custom element was registered.
      if (Object.hasOwn(this, "events")) {
        const events = this.events;
        Reflect.deleteProperty(this, "events");
        this.events = events;
      }
    }

    get events(): unknown {
      return this.#events === undefined
        ? (JSON.parse(this.getAttribute("events") ?? "[]") as unknown)
        : this.#events;
    }

    set events(events: unknown) {
      this.#events = events;
      if (this.#initialized) this.render();
    }

    connectedCallback() {
      // Keep the shared widget surface outside Shadow DOM; only layout is private.
      this.classList.add("widget");
      // Preserve a server-rendered declarative shadow root when upgrading it.
      if (!this.shadowRoot) {
        this.attachShadow({ mode: "open", serializable: true });
        this.render();
      } else if (!this.#initialized && this.#events !== undefined) {
        this.render();
      }
      if (!this.#initialized) {
        this.shadowRoot!.addEventListener("click", (event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("button[data-event-index]")
              : null;
          if (!button) return;
          const index = Number(button.dataset.eventIndex);
          this.dispatchEvent(
            new CustomEvent("eventselect", {
              bubbles: true,
              composed: true,
              detail: { event: Array.isArray(this.events) ? this.events[index] : undefined, index },
            }),
          );
        });
      }
      this.#initialized = true;
    }

    attributeChangedCallback(_name: string, before: string | null, after: string | null) {
      if (before !== after && this.#initialized && this.shadowRoot) this.render();
    }

    render() {
      const shadow = this.shadowRoot;
      if (!shadow) return;
      try {
        const date = this.getAttribute("date") ?? "";
        const calendarDate = new Date(`${date}T12:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(calendarDate.getTime()) ||
          calendarDate.toISOString().slice(0, 10) !== date
        ) {
          throw new Error("Supply a valid calendar date as YYYY-MM-DD.");
        }
        const start = minutes(this.getAttribute("start") ?? "09:00");
        const end = minutes(this.getAttribute("end") ?? "17:00");
        if (end <= start) throw new Error("The visible end must be later than the start.");
        const now = this.hasAttribute("now") ? minutes(this.getAttribute("now")) : null;
        const input = this.events;
        if (!Array.isArray(input) || input.length > 200)
          throw new Error("Supply an array of at most 200 events.");
        const tones = new Set(["blue", "green", "red", "orange", "purple", "yellow"]);
        const events = (input as unknown[])
          .map((event, index) => {
            if (
              event == null ||
              typeof event !== "object" ||
              !("title" in event) ||
              typeof event.title !== "string"
            ) {
              throw new Error("Each event needs a title, start and end.");
            }
            const record = event as Record<string, unknown>;
            const from = minutes(record.start),
              to = minutes(record.end);
            if (to <= from) throw new Error("An event must end after it starts.");
            if (record.detail != null && typeof record.detail !== "string")
              throw new Error("Event detail must be text.");
            return {
              title: event.title,
              start: String(record.start),
              end: String(record.end),
              detail: typeof record.detail === "string" ? record.detail : undefined,
              video: record.video,
              index,
              from,
              to,
              tone:
                typeof record.tone === "string" && tones.has(record.tone) ? record.tone : "blue",
              lane: 0,
              lanes: 1,
            };
          })
          .filter((event) => event.from < end && event.to > start)
          .sort((a, b) => a.from - b.from || b.to - a.to);

        // Allocate interval lanes within each connected overlap group. Adjacent
        // events share a lane; a chain of overlaps shares one column count.
        let group: typeof events = [],
          laneEnds: number[] = [],
          groupEnd = -1;
        const finishGroup = () => {
          for (const event of group) event.lanes = laneEnds.length;
        };
        for (const event of events) {
          if (event.from >= groupEnd) {
            finishGroup();
            group = [];
            laneEnds = [];
          }
          let lane = laneEnds.findIndex((until) => until <= event.from);
          if (lane < 0) lane = laneEnds.length;
          event.lane = lane;
          laneEnds[lane] = event.to;
          group.push(event);
          groupEnd = Math.max(event.to, groupEnd);
        }
        finishGroup();

        const locale = this.lang || document.documentElement.lang || "en";
        const weekday = new Intl.DateTimeFormat(locale, {
          weekday: "short",
          timeZone: "UTC",
        }).format(calendarDate);
        const fullDate = new Intl.DateTimeFormat(locale, {
          dateStyle: "full",
          timeZone: "UTC",
        }).format(calendarDate);
        const timeZone = this.getAttribute("time-zone");
        const ticks = [start];
        for (let tick = (Math.floor(start / 60) + 1) * 60; tick < end; tick += 60) ticks.push(tick);
        ticks.push(end);
        const labelTime = (time: number) =>
          `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
        const compact = end - start > 240;
        // Size from full event durations; the window clips partial events
        // without letting a one-minute sliver stretch the entire time axis.
        const minimumHour = Math.max(
          0,
          ...events.map((event) => (28 * 60) / (event.to - event.from)),
        );
        const minimumTargetHour = Math.max(
          0,
          ...events.map((event) => (48 * 60) / (event.to - event.from)),
        );
        const hourMarkup = ticks
          .map(
            (tick) =>
              `<div class="hour" style="--at:${(tick - start) / 60}">${now != null && now >= start && now <= end && Math.abs(tick - now) < 15 ? "" : `<span>${tick % 60 ? labelTime(tick) : tick / 60}</span>`}</div>`,
          )
          .join("");
        const interactive = this.hasAttribute("interactive");
        const eventMarkup = events
          .map((event) => {
            const label = escape(
              `${event.title}, ${event.start}-${event.end}${event.detail ? `, ${event.detail}` : ""}`,
            );
            const body = `button type="button"${interactive ? ` data-event-index="${event.index}"` : ""} aria-label="${label}" data-tooltip="${label}"`;
            return `<li class="event${now != null && event.to <= now ? " past" : ""}" style="--at:${(event.from - start) / 60};--duration:${(event.to - event.from) / 60};--lane:${event.lane};--lanes:${event.lanes};--tone:var(--${event.tone})"><${body} class="event-body cursor-interaction"><span class="event-content"><span class="title">${escape(event.title)}</span>${event.detail ? `<span class="detail">${escape(event.detail)}</span>` : ""}</span>${event.video ? videoIcon : ""}</button></li>`;
          })
          .join("");
        const nowMarkup =
          now != null && now >= start && now <= end
            ? `<div class="now" style="--at:${(now - start) / 60}" role="img" aria-label="${escape(labelTime(now))}"><span>${labelTime(now)}</span></div>`
            : "";
        shadow.innerHTML = `<style>${style}</style><section class="calendar" aria-label="${escape(fullDate)}"><div class="layout"><div class="date"><span class="weekday">${escape(weekday)}</span><span class="day">${Number(date.slice(-2))}</span>${timeZone ? `<span class="context">${escape(timeZone)}</span>` : ""}</div><div class="axis${compact ? " compact" : ""}" style="--hours:${(end - start) / 60};--minimum-hour:${minimumHour}px;--minimum-target-hour:${minimumTargetHour}px">${hourMarkup}<ol class="events">${eventMarkup}</ol>${nowMarkup}${events.length ? "" : `<span class="empty">${escape(this.getAttribute("empty-label") ?? "No events")}</span>`}</div></div></section>`;
      } catch (error) {
        // Invalid model-authored input remains visible and recoverable through
        // the same attributes; never silently invent dates or drop events.
        shadow.innerHTML = `<style>${style}</style><div class="calendar" role="alert">${escape(error instanceof Error ? error.message : "Invalid calendar data.")}</div>`;
      }
    }
  }
  customElements.define("viz-calendar", Calendar);
}

export function buildInlineVisualizationCalendar(fragment: string): string {
  if (!/\bviz-calendar\b/i.test(fragment)) return "";
  return `<script>(${installCalendar.toString()})(${JSON.stringify(calendarStyles).replaceAll("<", "\\u003c")},${JSON.stringify(guestDocumentVideoIcon).replaceAll("<", "\\u003c")});</script>`;
}
