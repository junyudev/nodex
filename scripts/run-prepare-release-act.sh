#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW_PATH="${REPO_ROOT}/.github/workflows/prepare-release.yml"
DEFAULT_EVENT_TEMPLATE="${REPO_ROOT}/.github/act/prepare-release.event.json"
DEFAULT_SECRET_FILE="${REPO_ROOT}/.github/act/prepare-release.secrets.local"

release_type="patch"
custom_version=""
list_only="false"
explicit_secret_file=""
declare -a extra_act_args=()

usage() {
  cat <<'EOF'
Usage:
  scripts/run-prepare-release-act.sh [--list]
  scripts/run-prepare-release-act.sh [--release-type patch|minor|major|custom] [--custom-version X.Y.Z] [--secret-file PATH] [-- ACT_ARGS...]

Examples:
  bun run release:prepare:act:list
  bun run release:prepare:act -- --release-type patch
  bun run release:prepare:act -- --release-type custom --custom-version 0.1.3
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --list)
      list_only="true"
      shift
      ;;
    --release-type)
      shift
      (($# > 0)) || fail "Expected a value after --release-type."
      release_type="$1"
      shift
      ;;
    --custom-version)
      shift
      (($# > 0)) || fail "Expected a value after --custom-version."
      custom_version="$1"
      shift
      ;;
    --secret-file)
      shift
      (($# > 0)) || fail "Expected a value after --secret-file."
      explicit_secret_file="$1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      extra_act_args=("$@")
      break
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

case "${release_type}" in
  patch|minor|major)
    if [[ -n "${custom_version}" ]]; then
      fail "--custom-version is only valid when --release-type custom is selected."
    fi
    ;;
  custom)
    [[ -n "${custom_version}" ]] || fail "--custom-version is required when --release-type custom is selected."
    ;;
  *)
    fail "Unsupported --release-type value: ${release_type}"
    ;;
esac

command -v act >/dev/null 2>&1 || fail "Missing \`act\`. Install it first, for example with \`brew install act\`."

if [[ "${list_only}" != "true" ]]; then
  command -v docker >/dev/null 2>&1 || fail "Missing \`docker\`. Start Docker Desktop or OrbStack so \`docker info\` succeeds before retrying."
  docker info >/dev/null 2>&1 || fail "Docker is installed but not reachable. Start Docker Desktop or OrbStack and retry."
fi

secret_source=""
if [[ -n "${explicit_secret_file}" ]]; then
  [[ -f "${explicit_secret_file}" ]] || fail "Secret file not found: ${explicit_secret_file}"
  secret_source="${explicit_secret_file}"
elif [[ -f "${DEFAULT_SECRET_FILE}" ]]; then
  secret_source="${DEFAULT_SECRET_FILE}"
fi

gh_token=""
if command -v gh >/dev/null 2>&1; then
  gh_token="$(gh auth token 2>/dev/null || true)"
fi

event_file="$(mktemp)"
secret_file=""
cleanup() {
  rm -f "${event_file}"
  if [[ -n "${secret_file}" ]]; then
    rm -f "${secret_file}"
  fi
}
trap cleanup EXIT

cat >"${event_file}" <<EOF
{
  "act": true,
  "inputs": {
    "release_type": "${release_type}",
    "custom_version": "${custom_version}"
  }
}
EOF

declare -a secret_args=()
if [[ -n "${secret_source}" || -n "${gh_token}" ]]; then
  secret_file="$(mktemp)"
  if [[ -n "${secret_source}" ]]; then
    cat "${secret_source}" > "${secret_file}"
  fi
  if [[ -n "${gh_token}" ]] && ! grep -q '^GITHUB_TOKEN=' "${secret_file}" 2>/dev/null; then
    printf 'GITHUB_TOKEN=%s\n' "${gh_token}" >> "${secret_file}"
  fi
  secret_args=(--secret-file "${secret_file}")
fi

printf 'Using workflow: %s\n' "${WORKFLOW_PATH}"
printf 'Using event template: %s\n' "${DEFAULT_EVENT_TEMPLATE}"
printf 'Resolved release_type=%s\n' "${release_type}"
if [[ "${release_type}" == "custom" ]]; then
  printf 'Resolved custom_version=%s\n' "${custom_version}"
fi
if [[ -n "${secret_source}" ]]; then
  printf 'Using local secret file: %s\n' "${secret_source}"
elif [[ -n "${gh_token}" ]]; then
  printf 'Using GITHUB_TOKEN from gh auth.\n'
else
  printf 'Running without an explicit GITHUB_TOKEN secret.\n'
fi

declare -a act_cmd=(
  act
  workflow_dispatch
  -W "${WORKFLOW_PATH}"
  -j prepare
  --eventpath "${event_file}"
)

if [[ "${list_only}" == "true" ]]; then
  act_cmd+=(-l)
fi

if ((${#secret_args[@]} > 0)); then
  act_cmd+=("${secret_args[@]}")
fi

if ((${#extra_act_args[@]} > 0)); then
  act_cmd+=("${extra_act_args[@]}")
fi

printf 'Running:'
for arg in "${act_cmd[@]}"; do
  printf ' %q' "${arg}"
done
printf '\n'

cd "${REPO_ROOT}"
exec "${act_cmd[@]}"
