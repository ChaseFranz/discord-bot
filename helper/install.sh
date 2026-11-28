#!/bin/sh
# Nimbus music helper, for macOS and Linux: sets the helper up, or brings it up to date, and starts
# it. (On Windows, install.ps1 does the same.) Run the line /musichelper gives you:
#
#   curl -fsSL https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/install.sh | sh -s -- <your code>
#
# and to start the helper again later, the same line without the code:
#
#   curl -fsSL https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/install.sh | sh
#
# What it does, in ~/.nimbus-music-helper (the helper's own folder):
#   1. It uses your Node.js if it is version 22 or newer. If not, it downloads one fixed version
#      from nodejs.org the first time, and checks it against the SHA-256 written below.
#   2. It downloads the latest helper, one file, from GitHub, so starting it this way also keeps
#      it up to date.
#   3. It starts the helper, which fetches yt-dlp and ffmpeg itself (see README.md).
# It needs no admin rights and changes nothing outside that folder: nothing is added to your PATH,
# and nothing is set to start by itself.
#
# Everything happens in main, called on the last line, so a download of this file that was cut
# short does nothing at all.

set -e

NODE_VERSION=26.13.1
NODE_DOWNLOADS="https://nodejs.org/dist/v$NODE_VERSION"
HELPER_DOWNLOAD=https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/nimbus-music-helper.mjs

# The SHA-256 of each Node.js download, from the SHASUMS256.txt published with it. To move to a
# newer Node.js, change NODE_VERSION and these together, and the same in install.ps1.
node_sha256() {
  case "$1" in
    darwin-arm64) echo aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735 ;;
    darwin-x64) echo 82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f ;;
    linux-arm64) echo 80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d ;;
    linux-x64) echo 518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778 ;;
  esac
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '\n%s\n\n' "$*" >&2
  exit 1
}

# The major version of a Node.js (22 for v22.4.1), or nothing if it won't run.
major_of() {
  "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*$/\1/p'
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  fi
}

download() {
  curl -fsSL --retry 2 -o "$2" "$1"
}

# Sets node to the Node.js kept in the folder, downloading it the first time (and again whenever
# NODE_VERSION changes).
set_up_node() {
  dir="$home/node-v$NODE_VERSION"
  node="$dir/node"
  if [ "$(major_of "$node")" = "${NODE_VERSION%%.*}" ]; then
    return 0
  fi
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail 'This is the line for macOS and Linux. On Windows, use the Windows line from /musichelper.' ;;
    *) os=$(uname -s) ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) arch=$(uname -m) ;;
  esac
  expected=$(node_sha256 "$os-$arch")
  if [ -z "$expected" ]; then
    fail "There's no ready-made Node.js here for $os/$arch. Install Node.js 22 or newer yourself (https://nodejs.org) and run this line again: it will use yours."
  fi
  name="node-v$NODE_VERSION-$os-$arch"

  say "Downloading Node.js $NODE_VERSION (about 60 MB, this once): the helper runs on it..."
  work=$(mktemp -d "$home/.download.XXXXXX")
  # Nothing half-done is left behind, however this ends.
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' INT TERM HUP
  if ! download "$NODE_DOWNLOADS/$name.tar.gz" "$work/node.tar.gz"; then
    fail 'Could not download Node.js from nodejs.org. Check your internet connection and try again.'
  fi
  if [ "$(sha256_of "$work/node.tar.gz")" != "$expected" ]; then
    fail 'The Node.js download did not match its known checksum, so it was not used. Try again in a minute.'
  fi
  # Only the program itself is needed.
  if ! tar -xzf "$work/node.tar.gz" -C "$work" "$name/bin/node"; then
    fail 'Could not unpack the Node.js download.'
  fi
  if [ "$(major_of "$work/$name/bin/node")" != "${NODE_VERSION%%.*}" ]; then
    fail "The Node.js that was downloaded won't start on this computer. Install Node.js 22 or newer yourself (https://nodejs.org) and run this line again: it will use yours."
  fi
  # A version set up here before isn't needed any more.
  for old in "$home"/node-v*; do
    if [ -d "$old" ] && [ "$old" != "$dir" ]; then
      rm -rf "$old"
    fi
  done
  mkdir -p "$dir"
  mv -f "$work/$name/bin/node" "$node"
  rm -rf "$work"
  trap - EXIT INT TERM HUP
  say "Node.js $NODE_VERSION is ready."
}

main() {
  home=${NIMBUS_HELPER_HOME:-"$HOME/.nimbus-music-helper"}
  mkdir -p "$home"

  # Node.js: yours, if it is new enough; otherwise the one kept in the folder.
  node=
  if command -v node >/dev/null 2>&1; then
    major=$(major_of node)
    if [ -n "$major" ] && [ "$major" -ge 22 ]; then
      node=$(command -v node)
    fi
  fi
  if [ -z "$node" ]; then
    set_up_node
  fi

  # The helper itself, the latest every time.
  helper="$home/nimbus-music-helper.mjs"
  first=
  if download "$HELPER_DOWNLOAD" "$helper.download" 2>/dev/null; then
    IFS= read -r first <"$helper.download" || true
  fi
  # Anything else (a sign-in page on a public network, say) is not the helper.
  if [ "$first" = '#!/usr/bin/env node' ]; then
    mv -f "$helper.download" "$helper"
  else
    rm -f "$helper.download"
    if [ ! -f "$helper" ]; then
      fail 'Could not download the helper from GitHub. Check your internet connection and try again.'
    fi
    say 'Could not check for a newer helper, so starting the one you have.'
  fi

  # So that it says how to start it again with this line, not with the file.
  NIMBUS_HELPER_INSTALLER=1
  export NIMBUS_HELPER_INSTALLER
  exec "$node" "$helper" "$@"
}

main "$@"
