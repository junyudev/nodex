import { expect, test } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { generateHomebrewCask } from "./homebrew";

test("generated cask binds the Apple silicon download and hardware requirement", () => {
  const cask = generateHomebrewCask({
    version: "0.3.0",
    arm64Sha256: "a".repeat(64),
  });
  const result = execFileSync(
    "ruby",
    [
      "-rjson",
      "-e",
      `
    class CaskContract
      attr_reader :downloads, :requirements
      def initialize; @downloads = []; @requirements = {}; end
      def depends_on(**values); @requirements.merge!(values); end
      def version(value = nil); @version = value if value; @version; end
      def appdir; "/Applications"; end
      def url(value, **options)
        raise "Unsupported URL keywords" unless options.empty?
        @downloads << value if value.end_with?(".dmg")
      end
      def method_missing(name, *args, **options, &block)
        instance_eval(&block) if block
      end
    end
    contract = CaskContract.new
    contract.instance_eval(STDIN.read)
    puts JSON.generate({ downloads: contract.downloads, requirements: contract.requirements })
  `,
    ],
    { input: cask, encoding: "utf8" },
  );
  expect(JSON.parse(result)).toEqual({
    downloads: [
      "https://github.com/junyudev/nodex/releases/download/v0.3.0/Nodex-latest-arm64.dmg",
    ],
    requirements: { arch: "arm64", macos: "sequoia" },
  });
});

test("generateHomebrewCask binds immutable version tags to canonical DMGs", () => {
  const cask = generateHomebrewCask({
    arm64Sha256: "a".repeat(64),
    version: "0.2.0",
  });
  expect(cask).toContain('version "0.2.0"');
  expect(cask).toContain("/releases/download/v#{version}/Nodex-latest-arm64.dmg");
  expect(cask).toContain("strategy :github_latest");
  expect(cask).toContain('homepage "https://nodex.jyu.app/"');
  expect(cask).toContain('url "https://github.com/junyudev/nodex"');
  expect(cask).not.toContain("Nodex-#{version}-arm64.dmg");
  expect(cask).not.toContain('depends_on macos: ">= :sequoia"');
});

test("generateHomebrewCask rejects malformed checksums", () => {
  expect(() =>
    generateHomebrewCask({
      arm64Sha256: "bad",
      version: "0.2.0",
    }),
  ).toThrow("SHA-256");
});
