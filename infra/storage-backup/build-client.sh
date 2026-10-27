#!/bin/sh
# Reproducible mc build for local initialization and the Alpha backup runner.
set -eu
source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
wget -q -O "$source_dir/source.tar.gz" https://codeload.github.com/minio/mc/tar.gz/7394ce0dd2a80935aded936b09fa12cbb3cb8096
printf '%s  %s\n' 95cd293c7119f16921a6dc515a1fb74a2227f19fd994b9c8b770a154e802ac44 "$source_dir/source.tar.gz" | sha256sum -c -
tar -xzf "$source_dir/source.tar.gz" --strip-components=1 -C "$source_dir"
mkdir -p /out
cd "$source_dir"
CGO_ENABLED=0 go build -p 2 -trimpath -ldflags='-s -w' -o /out/mc .
cp LICENSE /out/LICENSE.mc
