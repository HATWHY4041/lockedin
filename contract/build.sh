#!/bin/sh
# Builds the escrow contract to WebAssembly for ME Network (wasmvm 1.4: MVP wasm, no floats).
# Needs Zig 0.17.1:  pip install ziglang==0.17.1
set -e
cd "$(dirname "$0")"
python3 -m ziglang build-exe src/contract.zig -target wasm32-freestanding -mcpu mvp -O ReleaseSmall \
  -fno-entry -rdynamic -fsingle-threaded -femit-bin=bounty_escrow.wasm
echo "built contract/bounty_escrow.wasm"
