#!/usr/bin/env bash
# Build the crypto core to WASM (pkg/, ES-module target for a Web Worker).
# wasm-opt runs separately because wasm-pack's binaryen download is blocked
# in some environments — install it via `apt-get install binaryen` or brew.
set -euo pipefail
cd "$(dirname "$0")"

wasm-pack build --target web --release

# binaryen < 116 miscompiles modules from current rustc (breaks table
# growth at runtime) — only optimize with a recent wasm-opt.
version=$(wasm-opt --version 2>/dev/null | grep -o '[0-9]\+' | head -1 || echo 0)
if [ "$version" -ge 116 ]; then
    wasm-opt -Os -o pkg/crypto_core_bg.wasm.opt pkg/crypto_core_bg.wasm
    mv pkg/crypto_core_bg.wasm.opt pkg/crypto_core_bg.wasm
    echo "wasm-opt: $(du -h pkg/crypto_core_bg.wasm | cut -f1)"
else
    echo "wasm-opt >= 116 not found; shipping unoptimized wasm ($(du -h pkg/crypto_core_bg.wasm | cut -f1))" >&2
fi
