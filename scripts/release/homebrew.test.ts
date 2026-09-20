import { expect, test } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { generateHomebrewCask } from "./homebrew";

test("generated cask evaluates with keyword-free download URLs", () => {
  const cask = generateHomebrewCask({
    version: "0.3.0",
    arm64Sha256: "a".repeat(64),
    x64Sha256: "b".repeat(64),
  });
  const result = execFileSync(
    "ruby",
    [
      "-rjson",
      "-e",
      `
    class CaskContract
      attr_reader :downloads
      def initialize; @downloads = []; end
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
    puts JSON.generate(contract.downloads)
  `,
    ],
    { input: cask, encoding: "utf8" },
  );
  expect(JSON.parse(result)).toEqual([
    "https://github.com/junyudev/nodex/releases/download/v0.3.0/Nodex-latest-arm64.dmg",
    "https://github.com/junyudev/nodex/releases/download/v0.3.0/Nodex-latest-x64.dmg",
  ]);
});

test("generateHomebrewCask binds immutable version tags to canonical DMGs", () => {
  const cask = generateHomebrewCask({
    arm64Sha256: "a".repeat(64),
    version: "0.2.0",
    x64Sha256: "b".repeat(64),
  });
  expect(cask).toContain('version "0.2.0"');
  expect(cask).toContain("/releases/download/v#{version}/Nodex-latest-arm64.dmg");
  expect(cask).toContain("strategy :github_latest");
  expect(cask).toContain('homepage "https://nodex.jyu.app/"');
  expect(cask).toContain('url "https://github.com/junyudev/nodex"');
  expect(cask).toContain("  end\n  on_intel do");
  expect(cask).toContain("  auto_updates true\n  depends_on macos: :sequoia");
  expect(cask).not.toContain("Nodex-#{version}-arm64.dmg");
  expect(cask).not.toContain('depends_on macos: ">= :sequoia"');
});

test("generateHomebrewCask rejects malformed checksums", () => {
  expect(() =>
    generateHomebrewCask({
      arm64Sha256: "bad",
      version: "0.2.0",
      x64Sha256: "b".repeat(64),
    }),
  ).toThrow("SHA-256");
});
