import type { DatabasePage } from "@/lib/types";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";

export function buildPageStageFixturePage(): DatabasePage {
  return {
    id: "fixture-page-stage-1",
    pageKey: "LAB-13",
    status: "build",
    archived: false,
    title: "Refine related Chat property UI",
    richTitle: plainTextToPortableRichText("Refine related Chat property UI"),
    description: "Validate linked Chat properties and Page detail ownership.",
    priority: "p1-high",
    estimate: "m",
    tags: ["ui", "chats", "page-stage"],
    dueDate: new Date("2026-03-08T09:00:00.000Z"),
    scheduledStart: new Date("2026-03-05T14:00:00.000Z"),
    scheduledEnd: new Date("2026-03-05T15:00:00.000Z"),
    reminders: [{ offsetMinutes: 30 }],
    assignee: "asc",
    runInTarget: "localProject",
    created: new Date("2026-03-04T09:30:00.000Z"),
    order: 0,
  };
}
