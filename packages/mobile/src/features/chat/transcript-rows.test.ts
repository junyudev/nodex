import type { ChatItem } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import { transcriptRows, workTitle } from "./transcript-rows";

const at = "2026-11-04T00:00:00.000Z";

const user = (id: string): ChatItem => ({
  kind: "user",
  id,
  at,
  text: "hi",
  files: [],
  queued: false,
});

const assistant = (id: string, streaming = false): ChatItem => ({
  kind: "assistant",
  id,
  at,
  text: "hello",
  streaming,
  truncated: false,
});

const activity = (
  id: string,
  status: "running" | "done" | "failed" = "done",
  title = `Run ${id}`,
): Extract<ChatItem, { kind: "activity" }> => ({
  kind: "activity",
  id,
  at,
  category: "command",
  title,
  detail: null,
  status,
  output: null,
  outputTruncated: false,
});

const thinking = (id: string, streaming = false): Extract<ChatItem, { kind: "thinking" }> => ({
  kind: "thinking",
  id,
  at,
  text: "...",
  streaming,
  truncated: false,
});

const idle = { status: "idle" } as const;
const running = { status: "running" } as const;

describe("transcriptRows", () => {
  it("collapses adjacent work between messages", () => {
    const rows = transcriptRows(
      [user("u1"), thinking("t1"), activity("a1"), activity("a2"), assistant("m1")],
      idle,
    );
    expect(rows.map((row) => row.type)).toEqual(["user", "work", "assistant"]);
    expect(rows[1]).toMatchObject({ id: "work:t1", title: "2 steps", running: false });
  });

  it("keeps a group's identity as steps arrive, so an opened group stays open", () => {
    const before = transcriptRows([activity("a1")], running);
    const after = transcriptRows([activity("a1"), activity("a2", "running")], running);
    expect(before[0]?.id).toBe("work:a1");
    expect(after[0]?.id).toBe("work:a1");
  });

  it("counts failed steps", () => {
    const rows = transcriptRows([activity("a1", "failed"), activity("a2")], idle);
    expect(rows[0]).toMatchObject({ failedCount: 1 });
  });

  it("adds a working row only when a running chat shows nothing moving", () => {
    const types = (items: readonly ChatItem[], status: "idle" | "running") =>
      transcriptRows(items, { status }).map((row) => row.type);
    expect(types([user("u")], "running")).toEqual(["user", "working"]);
    expect(types([assistant("m", true)], "running")).toEqual(["assistant"]);
    expect(types([activity("a", "running")], "running")).toEqual(["work"]);
    expect(types([assistant("m")], "running")).toEqual(["assistant", "working"]);
    expect(types([user("u")], "idle")).toEqual(["user"]);
  });

  it("does not claim a waiting chat is working", () => {
    expect(transcriptRows([user("u")], { status: "waiting" }).map((row) => row.type)).toEqual([
      "user",
    ]);
  });
});

describe("workTitle", () => {
  it("names the latest step still running", () => {
    expect(workTitle([activity("a", "running", "npm test"), activity("b")])).toBe("npm test");
    expect(workTitle([activity("a"), thinking("t", true)])).toBe("Thinking");
  });

  it("counts finished steps", () => {
    expect(workTitle([activity("a")])).toBe("1 step");
    expect(workTitle([activity("a"), activity("b")])).toBe("2 steps");
    expect(workTitle([thinking("t")])).toBe("Thought");
  });
});
