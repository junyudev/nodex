import { describe, expect, test } from "vite-plus/test";
import { readAssistantCreatedThreadResults } from "./assistant-created-thread-results";

const header = 'created-thread{threadId="child" hostId="remote"}';
const read = (source: string, completed = true, aeon = false) =>
  readAssistantCreatedThreadResults({ source, completed, aeon });

describe("assistant creation declarations", () => {
  test.each([`:${header}`, `::${header}`, `:::${header}`, `    ::${header}`, `\t::${header}`])(
    "reads line metadata from %s",
    (source) => {
      expect(read(source)).toEqual([{ threadId: "child", hostId: "remote" }]);
    },
  );
  test("extracts declared line metadata before ordinary Markdown code interpretation", () => {
    expect(read(`\`\`\`\n::${header}\n\`\`\``)).toEqual([{ threadId: "child", hostId: "remote" }]);
    expect(read(`text ::${header}\n> ::${header}\n- ::${header}\n::::${header}`)).toEqual([]);
  });
  test("requires the assistant item completion and permits no Aeon declaration", () => {
    expect(read(`::${header}`, false)).toEqual([]);
    expect(read(`::${header}`, true, true)).toEqual([]);
  });
  test("keeps ordered source occurrences and rejects unfinished or invalid targets", () => {
    expect(
      read(
        '::created-thread{threadId="first"}\n::created-thread{threadId=" "}\n' +
          '::created-thread{clientThreadId="client-new-thread:any"}\n' +
          '::created-thread{threadId="first"}\n::created-thread{threadId="unfinished"',
      ),
    ).toEqual([
      { threadId: "first" },
      { clientThreadId: "client-new-thread:any" },
      { threadId: "first" },
    ]);
    expect(read('::created-thread{hostId="remote" threadId=child}')).toEqual([
      { threadId: "child", hostId: "remote" },
    ]);
  });
});
