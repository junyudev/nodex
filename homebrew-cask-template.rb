# Homebrew Cask template for Nodex
#
# To use this:
# 1. Create a GitHub repo: Asphocarp/homebrew-nodex
# 2. Place this file at: Casks/a/nodex.rb
# 3. Update version, sha256, and URL after each release
# 4. Users install with:
#      brew tap Asphocarp/nodex
#      brew install --cask nodex

cask "nodex" do
  version "0.2.0"
  sha256 "REPLACE_WITH_SHA256" # Run: shasum -a 256 dist/Nodex-0.2.0-arm64.dmg

  url "https://github.com/Asphocarp/nodex/releases/download/v#{version}/Nodex-#{version}-arm64.dmg",
      verified: "github.com/Asphocarp/nodex/"

  name "Nodex"
  desc "SQLite-based kanban board for managing coding agents"
  homepage "https://github.com/Asphocarp/nodex"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Nodex.app"

  zap trash: [
    "~/.nodex",
    "~/Library/Application Support/nodex",
    "~/Library/Preferences/com.nodex.kanban.plist",
    "~/Library/Saved Application State/com.nodex.kanban.savedState",
  ]
end
