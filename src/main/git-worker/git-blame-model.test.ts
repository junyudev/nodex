import { describe, expect, test } from "vite-plus/test";
import { parseGitBlamePorcelain } from "./git-blame-model";

const sha = "a".repeat(40);

describe("Git blame porcelain", () => {
  test("keeps each final-file line's author, time and subject", () => {
    expect(
      parseGitBlamePorcelain(
        [
          `${sha} 1 3 1`,
          "author The Octocat",
          "author-mail <octocat@example.com>",
          "author-time 1700000000",
          "summary Add file (#123)",
          "filename example.ts",
          "\tcontent",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 3,
        commitSha: sha,
        author: "The Octocat",
        authorTime: 1700000000,
        summary: "Add file (#123)",
      },
    ]);
  });

  test("keeps repeated commits, uncommitted lines and SHA-256 lines independent", () => {
    const records = [sha, sha, "0".repeat(40), "b".repeat(64)].flatMap((hash, index) => [
      `${hash} ${index + 1} ${index + 1}`,
      `author Author ${index}`,
      "author-mail <private@example.com>",
      "author-time invalid",
      `summary Change ${index}`,
      "\tline",
    ]);
    const lines = parseGitBlamePorcelain(records.join("\n"));
    expect(lines.map((line) => [line.line, line.commitSha, line.author, line.authorTime])).toEqual(
      [sha, sha, "0".repeat(40), "b".repeat(64)].map((hash, index) => [
        index + 1,
        hash,
        `Author ${index}`,
        null,
      ]),
    );
  });

  test("does not publish incomplete or malformed records", () => {
    expect(parseGitBlamePorcelain(`${sha} 1 0\n\tbad\n${sha} 1 2\nauthor Incomplete`)).toEqual([]);
  });
});
