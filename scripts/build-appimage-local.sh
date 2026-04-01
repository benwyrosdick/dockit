#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_TOOL="${CONTAINER_TOOL:-}"
IMAGE="${DOCKIT_APPIMAGE_IMAGE:-ubuntu:22.04}"

if [[ -z "$CONTAINER_TOOL" ]]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_TOOL="docker"
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_TOOL="podman"
  else
    printf 'Need docker or podman to build the AppImage locally.\n' >&2
    exit 1
  fi
fi

exec "$CONTAINER_TOOL" run --rm -t \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -v "$ROOT_DIR:/workspace" \
  -v dockit-appimage-cargo-registry:/root/.cargo/registry \
  -v dockit-appimage-cargo-git:/root/.cargo/git \
  -v dockit-appimage-rustup:/root/.rustup \
  -v dockit-appimage-bun:/root/.bun/install/cache \
  -w /workspace \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    apt-get update
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      libayatana-appindicator3-dev \
      libfuse2 \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      patchelf \
      pkg-config \
      unzip

    if ! command -v bun >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash
    fi

    if ! command -v cargo >/dev/null 2>&1; then
      curl https://sh.rustup.rs -sSf | sh -s -- -y
    fi

    export PATH="/root/.bun/bin:/root/.cargo/bin:$PATH"

    bun install --frozen-lockfile
    bun run tauri build --bundles appimage

    chown -R "$HOST_UID:$HOST_GID" /workspace/dist /workspace/src-tauri/target
  '
