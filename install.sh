#!/usr/bin/env bash
set -euo pipefail

# Install Nodex from source (HEAD) on macOS
# - Builds the Electron app and copies to /Applications
# - Links the `nodex` CLI globally via bun
# - Installs the agent skill to ~/.agents/skills/nodex-kanban/

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Nodex.app"
SKILL_DIR="$HOME/.agents/skills/nodex-kanban"
APP_INSTALL_PATH="/Applications/$APP_NAME"
CLI_INSTALL_PATH="$HOME/.bun/bin/nodex"

print_usage() {
  cat <<EOF
Usage: ./install.sh [--app] [--cli] [--skill] [--all]

Install targets:
  --app, -a    Install desktop app to $APP_INSTALL_PATH
  --cli, -c    Install CLI to $CLI_INSTALL_PATH
  --skill, -s  Install skill to $SKILL_DIR/SKILL.md
  --all        Install all targets (same as no args)
  --help, -h   Show this help
EOF
}

install_app=false
install_cli=false
install_skill=false
selected_any=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|-a)
      install_app=true
      selected_any=true
      ;;
    --cli|-c)
      install_cli=true
      selected_any=true
      ;;
    --skill|-s)
      install_skill=true
      selected_any=true
      ;;
    --all)
      install_app=true
      install_cli=true
      install_skill=true
      selected_any=true
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$selected_any" = false ]; then
  install_app=true
  install_cli=true
  install_skill=true
fi

if [ "$install_skill" = true ] && ! command -v codex >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Error: Codex CLI is required but was not found in PATH.
Install it first with one of:
  npm install -g @openai/codex
  brew install --cask codex
EOF
  exit 1
fi

if [ "$install_app" = true ] || [ "$install_cli" = true ]; then
  echo "==> Installing dependencies..."
  cd "$REPO_DIR"
  bun install
fi

if [ "$install_app" = true ]; then
  echo "==> Building app bundle (local-only, unsigned)..."
  cd "$REPO_DIR"
  bun run build
  CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac dir

  # Find the built .app in dist/mac-arm64 or dist/mac
  APP_PATH=""
  for candidate in dist/mac-arm64/"$APP_NAME" dist/mac/"$APP_NAME"; do
    if [ -d "$REPO_DIR/$candidate" ]; then
      APP_PATH="$REPO_DIR/$candidate"
      break
    fi
  done

  if [ -z "$APP_PATH" ]; then
    echo "Error: Could not find $APP_NAME in dist/" >&2
    ls -d "$REPO_DIR"/dist/*/ 2>/dev/null >&2
    exit 1
  fi

  echo "==> Installing $APP_NAME to /Applications..."
  if [ -d "$APP_INSTALL_PATH" ]; then
    rm -rf "$APP_INSTALL_PATH"
  fi
  cp -R "$APP_PATH" /Applications/
  echo "    Installed $APP_INSTALL_PATH"
fi

if [ "$install_cli" = true ]; then
  echo "==> Linking nodex CLI..."
  cd "$REPO_DIR"
  bun link
  echo "    CLI available as: $(command -v nodex 2>/dev/null || echo "$CLI_INSTALL_PATH")"
fi

if [ "$install_skill" = true ]; then
  echo "==> Installing skill to $SKILL_DIR..."
  mkdir -p "$SKILL_DIR"
  cp "$REPO_DIR/skills/nodex-kanban/SKILL.md" "$SKILL_DIR/SKILL.md"
  echo "    Skill installed: $SKILL_DIR/SKILL.md"
fi

echo ""
echo "Done! Nodex installed from HEAD ($(git -C "$REPO_DIR" rev-parse --short HEAD))."
if [ "$install_app" = true ]; then
  echo "  App:   $APP_INSTALL_PATH"
fi
if [ "$install_cli" = true ]; then
  echo "  CLI:   $(command -v nodex 2>/dev/null || echo "$CLI_INSTALL_PATH")"
fi
if [ "$install_skill" = true ]; then
  echo "  Skill: $SKILL_DIR/SKILL.md"
fi
