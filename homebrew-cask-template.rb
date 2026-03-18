# This file mirrors the generated cask layout from scripts/generate-homebrew-cask.ts.
# CI writes the real release-specific cask into junyudev/homebrew-tap/Casks/nodex.rb.

cask "nodex" do
  version "0.0.0"

  on_arm do
    sha256 "ARM64_SHA256"

    url "https://github.com/junyudev/nodex/releases/download/v#{version}/Nodex-#{version}-arm64.dmg",
        verified: "github.com/junyudev/nodex/"
  end

  on_intel do
    sha256 "X64_SHA256"

    url "https://github.com/junyudev/nodex/releases/download/v#{version}/Nodex-#{version}-x64.dmg",
        verified: "github.com/junyudev/nodex/"
  end

  name "Nodex"
  desc "Block-based Agent Orchestrator"
  homepage "https://github.com/junyudev/nodex"

  livecheck do
    url :homepage
    strategy :github_latest
  end

  app "Nodex.app"

  zap trash: [
    "~/.nodex",
    "~/Library/Application Support/nodex",
    "~/Library/Preferences/app.jyu.nodex.plist",
    "~/Library/Saved Application State/app.jyu.nodex.savedState",
  ]
end
