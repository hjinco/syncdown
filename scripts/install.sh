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

release_asset_exists() {
  curl -fsSLI "$1" >/dev/null 2>&1
}

resolve_tag() {
  asset_suffix="$1"

  if [ -n "${SYNCDOWN_VERSION:-}" ]; then
    normalize_tag "$SYNCDOWN_VERSION"
    return
  fi

  candidate_tags="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/tags?per_page=100" \
    | tr '{' '\n' \
    | sed -n 's/.*"name":[[:space:]]*"\(cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    | awk '
      {
        split(substr($0, 6), parts, ".")
        printf "%09d.%09d.%09d %s\n", parts[1] + 0, parts[2] + 0, parts[3] + 0, $0
      }
    ' \
    | sort -r \
    | awk '{print $2}')"

  for tag in $candidate_tags; do
    base_url="https://github.com/$REPO/releases/download/$tag"
    archive_name="syncdown-${tag}-${asset_suffix}.tar.gz"
    checksum_name="syncdown-${tag}-SHA256SUMS.txt"

    if release_asset_exists "$base_url/$archive_name" &&
      release_asset_exists "$base_url/$checksum_name"; then
      printf '%s\n' "$tag"
      return
    fi
  done

  printf 'error: unable to resolve latest downloadable CLI release tag\n' >&2
  exit 1
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

ASSET_SUFFIX="$(detect_asset_suffix)"
TAG="$(resolve_tag "$ASSET_SUFFIX")"
ARCHIVE_NAME="syncdown-${TAG}-${ASSET_SUFFIX}.tar.gz"
CHECKSUM_NAME="syncdown-${TAG}-SHA256SUMS.txt"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
ARCHIVE_PATH="$TMP_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$TMP_DIR/$CHECKSUM_NAME"

printf 'Downloading %s\n' "$ARCHIVE_NAME"
curl -fsSL "$BASE_URL/$ARCHIVE_NAME" -o "$ARCHIVE_PATH"
curl -fsSL "$BASE_URL/$CHECKSUM_NAME" -o "$CHECKSUM_PATH"

EXPECTED="$(awk -v file="$ARCHIVE_NAME" '
  {
    candidate = $2
    sub(/^\*/, "", candidate)
    count = split(candidate, parts, "/")

    if (parts[count] == file) {
      print $1
      exit
    }
  }
' "$CHECKSUM_PATH")"
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
