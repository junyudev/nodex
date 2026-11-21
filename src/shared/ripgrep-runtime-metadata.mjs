import lock from "../../resources/ripgrep/ripgrep.lock.json" with { type: "json" };

const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const isDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const isSize = (value) => Number.isSafeInteger(value) && value > 0 && value <= 32 * 1024 * 1024;

export function parseRipgrepRelease(value) {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.version) ||
    !isDigest(value.licenseSha256) ||
    Object.keys(value.builds ?? {}).length !== Object.keys(targets).length
  )
    throw new Error("Invalid ripgrep release lock");
  for (const [target, triple] of Object.entries(targets)) {
    const build = value.builds[target];
    const stem = `ripgrep-${value.version}-${triple}`;
    const windows = target.startsWith("win32-");
    const url = `https://github.com/BurntSushi/ripgrep/releases/download/${value.version}/${stem}.${windows ? "zip" : "tar.gz"}`;
    if (
      !isSize(build?.binarySize) ||
      !isDigest(build.binarySha256) ||
      !isSize(build.archive?.size) ||
      !isDigest(build.archive.sha256) ||
      build.archive.url !== url ||
      build.archive.member !== `${stem}/${windows ? "rg.exe" : "rg"}` ||
      (target === "darwin-arm64" && !isDigest(build.machOContentSha256))
    )
      throw new Error(`Invalid ripgrep release artifact for ${target}`);
  }
  return value;
}

export const ripgrepRelease = parseRipgrepRelease(lock);

export function ripgrepTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  return Object.hasOwn(targets, target) ? target : null;
}

export function ripgrepExecutableName(target) {
  return target.startsWith("win32-") ? "rg.exe" : "rg";
}
