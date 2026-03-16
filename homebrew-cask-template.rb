# This file mirrors the generated cask layout from scripts/generate-homebrew-cask.ts.
# CI writes the real release-specific cask into Asphocarp/homebrew-nodex/Casks/nodex.rb.

cask "nodex" do
  version "0.0.0"

  on_arm do
    sha256 "ARM64_SHA256"

    url "https://github.com/Asphocarp/nodex/releases/download/v#{version}/Nodex-#{version}-arm64.dmg",
        verified: "github.com/Asphocarp/nodex/"
  end

  on_intel do
    sha256 "X64_SHA256"

    url "https://github.com/Asphocarp/nodex/releases/download/v#{version}/Nodex-#{version}-x64.dmg",
        verified: "github.com/Asphocarp/nodex/"
  end

  name "Nodex"
  desc "SQLite-based kanban board for managing coding agents"
  homepage "https://github.com/Asphocarp/nodex"

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
