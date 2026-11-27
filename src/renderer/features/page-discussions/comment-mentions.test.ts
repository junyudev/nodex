import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  decodeCommentMentions,
  encodeCommentMentions,
  mentionedMemberIds,
} from "./comment-mentions";

describe("activeMentionQuery", () => {
  it("finds the @ word at the caret", () => {
    expect(activeMentionQuery("Hi @Ad", 6)).toEqual({ start: 3, text: "Ad" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, text: "" });
  });

  it("ignores @ inside a word and after a space", () => {
    expect(activeMentionQuery("mail me@host", 12)).toBeNull();
    expect(activeMentionQuery("@Ad done", 8)).toBeNull();
  });
});

describe("comment mentions", () => {
  const members = [
    { id: "m-ann", name: "Ann" },
    { id: "m-ann-lee", name: "Ann Lee" },
  ];

  it("encodes chosen names, preferring the longest", () => {
    expect(encodeCommentMentions("@Ann Lee and @Ann, look", members)).toBe(
      "<nodex://members/m-ann-lee> and <nodex://members/m-ann>, look",
    );
  });

  it("leaves names nobody chose as text", () => {
    expect(encodeCommentMentions("@Bob hi", members)).toBe("@Bob hi");
  });

  it("decodes for reading and lists mentioned Members once", () => {
    const body = "<nodex://members/m-ann> and <nodex://members/x> <nodex://members/m-ann>";
    expect(decodeCommentMentions(body, (id) => (id === "m-ann" ? "Ann" : null))).toBe(
      "**@Ann** and **@someone** **@Ann**",
    );
    expect(mentionedMemberIds(body)).toEqual(["m-ann", "x"]);
  });
});
