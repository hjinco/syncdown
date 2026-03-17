#!/bin/sh
set -eu

REPO="hjinco/syncdown"
INSTALL_DIR="${SYNCDOWN_INSTALL_DIR:-$HOME/.local/bin}"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t syncdown-install)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

normalize_tag() {
  case "$1" in
    cli-v*) printf '%s\n' "$1" ;;
    v*) printf 'cli-%s\n' "$1" ;;
    *) printf 'cli-v%s\n' "$1" ;;
  esac
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar

resolve_tag() {
  if [ -n "${SYNCDOWN_VERSION:-}" ]; then
    normalize_tag "$SYNCDOWN_VERSION"
    return
  fi

  tag="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | tr -d '\n' \
    | sed 's/},{"url":"/\
{"url":"/g' \
    | sed -n 's/.*"tag_name":[[:space:]]*"\(cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*"draft":[[:space:]]*false.*"prerelease":[[:space:]]*false.*/\1/p' \
    | awk '
      {
        split(substr($0, 6), parts, ".")
        major = parts[1] + 0
        minor = parts[2] + 0
        patch = parts[3] + 0

        if (
          best == "" ||
          major > best_major ||
          (major == best_major && minor > best_minor) ||
          (major == best_major && minor == best_minor && patch > best_patch)
        ) {
          best = $0
          best_major = major
          best_minor = minor
          best_patch = patch
        }
      }

      END {
        print best
      }
    ')"
  if [ -z "$tag" ]; then
    printf 'error: unable to resolve latest CLI release tag\n' >&2
    exit 1
  fi

  printf '%s\n' "$tag"
}

detect_asset_suffix() {
  os_name="$(uname -s)"
  arch_name="$(uname -m)"

  case "$os_name" in
    Darwin)
      case "$arch_name" in
        arm64) printf 'darwin-arm64\n' ;;
        x86_64) printf 'darwin-x64\n' ;;
        *)
          printf 'error: unsupported macOS architecture: %s\n' "$arch_name" >&2
          exit 1
          ;;
      esac
      ;;
    Linux)
      case "$arch_name" in
        x86_64) printf 'linux-x64\n' ;;
        *)
          printf 'error: unsupported Linux architecture: %s\n' "$arch_name" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      printf 'error: unsupported platform: %s\n' "$os_name" >&2
      exit 1
      ;;
  esac
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi

  printf 'error: shasum or sha256sum is required for checksum verification\n' >&2
  exit 1
}

TAG="$(resolve_tag)"
ASSET_SUFFIX="$(detect_asset_suffix)"
ARCHIVE_NAME="syncdown-${TAG}-${ASSET_SUFFIX}.tar.gz"
CHECKSUM_NAME="syncdown-${TAG}-SHA256SUMS.txt"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
ARCHIVE_PATH="$TMP_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$TMP_DIR/$CHECKSUM_NAME"

printf 'Downloading %s\n' "$ARCHIVE_NAME"
curl -fsSL "$BASE_URL/$ARCHIVE_NAME" -o "$ARCHIVE_PATH"
curl -fsSL "$BASE_URL/$CHECKSUM_NAME" -o "$CHECKSUM_PATH"

EXPECTED="$(awk -v file="$ARCHIVE_NAME" '$2 == file { print $1 }' "$CHECKSUM_PATH")"
ACTUAL="$(sha256_file "$ARCHIVE_PATH")"

if [ -z "$EXPECTED" ]; then
  printf 'error: missing checksum entry for %s\n' "$ARCHIVE_NAME" >&2
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf 'error: checksum mismatch for %s\n' "$ARCHIVE_NAME" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
cp "$TMP_DIR/syncdown" "$INSTALL_DIR/syncdown"
chmod 755 "$INSTALL_DIR/syncdown"

printf 'Installed syncdown to %s/syncdown\n' "$INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf 'Add %s to PATH if it is not already available in your shell.\n' "$INSTALL_DIR"
    ;;
esac
