import { parse } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { extractMessages, messageArguments } from "./check-messages";

describe("extractMessages", () => {
  it("reads descriptors from calls, defineMessages tables and FormattedMessage", () => {
    const source = `
      const messages = defineMessages({ title: { id: "a.title", defaultMessage: "Title" } });
      intl.formatMessage({ id: "a.count", defaultMessage: "{count} files" }, { count });
      const view = <FormattedMessage id="a.view" defaultMessage="View" />;
      const reused = <FormattedMessage {...messages.title} />;
      const forwarded = { id, defaultMessage };
    `;
    const { messages, problems } = extractMessages("/src/example.tsx", source);
    expect(problems).toEqual([]);
    expect(messages.map(({ id, defaultMessage }) => [id, defaultMessage])).toEqual([
      ["a.title", "Title"],
      ["a.count", "{count} files"],
      ["a.view", "View"],
    ]);
  });

  it("extracts literal arguments from a local formatter that forwards a descriptor", () => {
    const source = `
      const label = () => {
        const message = (id: string, defaultMessage: string) =>
          intl.formatMessage({ id, defaultMessage });
        return message("a.label", "Label");
      };
      message("unrelated", "Outside the formatter's scope");
    `;
    const { messages, problems } = extractMessages("/src/example.ts", source);
    expect(messages.map(({ id, defaultMessage }) => [id, defaultMessage])).toEqual([
      ["a.label", "Label"],
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects English that cannot be extracted", () => {
    const source = "intl.formatMessage({ id: `a.${kind}`, defaultMessage: `Open ${name}` });";
    const { messages, problems } = extractMessages("/src/example.ts", source);
    expect(messages).toEqual([]);
    expect(problems.map(({ message }) => message)).toEqual([
      "message `id` and `defaultMessage` must be string literals",
    ]);
  });
});

describe("messageArguments", () => {
  it("collects nested plural arguments and rich-text tags", () => {
    const names = messageArguments(
      parse("{count, plural, one {<b>#</b> file in {folder}} other {# files}}"),
    );
    expect([...names].sort()).toEqual(["<b>", "count", "folder"]);
  });
});
