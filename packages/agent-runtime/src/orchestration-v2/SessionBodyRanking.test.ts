import { describe, expect, it } from "vitest";
import { rankSessionBody, sessionBodyUsage } from "./SessionBodyRanking.ts";

describe("Session body usage evidence", () => {
  it("keeps proven author evidence ahead of newer role-only evidence", () => {
    const authored = "2026-10-01T00:00:00.000Z";
    const role = "2026-10-20T00:00:00.000Z";
    expect(
      sessionBodyUsage({
        latestUserAuthoredMessageAt: authored,
        activityEvidence: { at: role, provenance: "user_role" },
      }).activityAt,
    ).toBe(Date.parse(authored));
    expect(
      sessionBodyUsage({
        latestUserAuthoredMessageAt: null,
        activityEvidence: { at: role, provenance: "user_role" },
      }).activityAt,
    ).toBe(Date.parse(role));
    expect(sessionBodyUsage({ latestUserAuthoredMessageAt: null }).activityAt).toBeNull();
  });
  it("lets explicit role-only evidence affect usage without rewriting authored provenance", () => {
    const at = "2026-10-20T00:00:00.000Z";
    const session = {
      latestUserAuthoredMessageAt: null,
      activityEvidence: { at, provenance: "user_role" as const },
      opens: { openedAt: Date.parse(at), score: 2, picks: [] },
    };
    const fact = { quality: 1, hits: 1, messageAt: "2026-01-01T00:00:00.000Z" };
    const now = Date.parse(at);
    const weighted = rankSessionBody(fact, sessionBodyUsage(session), "needle", now);
    const withoutActivity = rankSessionBody(
      fact,
      sessionBodyUsage({ latestUserAuthoredMessageAt: null, opens: session.opens }),
      "needle",
      now,
    );
    expect(weighted.score).toBeGreaterThan(withoutActivity.score);
    expect(session.latestUserAuthoredMessageAt).toBeNull();
    expect(sessionBodyUsage(session).opens).toBe(session.opens);
  });
});
