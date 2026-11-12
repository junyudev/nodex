import { expect, it } from "@effect/vitest";
import { renderPersonalInstructions } from "./Instructions.ts";

it.each([
  ["when-helpful", "After you create or edit an artifact, open it beside the chat"],
  ["ask-first", "ask the person whether they want it opened"],
  ["never", "Do not open artifacts beside the chat"],
] as const)(
  "the %s artifact preference tells the Agent how to open artifacts",
  (artifactOpening, sentence) => {
    expect(renderPersonalInstructions({ artifactOpening, standingInstructions: "" })).toContain(
      sentence,
    );
  },
);

it("omits the standing section when the person has written nothing", () => {
  const text = renderPersonalInstructions({
    artifactOpening: "when-helpful",
    standingInstructions: "  \n ",
  });
  expect(text).toContain("## Your instructions");
  expect(text).not.toContain("### Standing instructions");
});

it("appends trimmed standing instructions after the preferences", () => {
  const text = renderPersonalInstructions({
    artifactOpening: "never",
    standingInstructions: "\n  Keep answers short.  \n",
  });
  expect(text.endsWith("### Standing instructions\n\nKeep answers short.")).toBe(true);
  expect(text.indexOf("### Preferences")).toBeLessThan(text.indexOf("### Standing instructions"));
});
