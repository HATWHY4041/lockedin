set -e
mkdir -p public
if python3 -m pip install --quiet ziglang==0.17.1 2>/dev/null || python3 -m pip install --quiet --break-system-packages ziglang==0.17.1 || python3 -m pip install --quiet --user ziglang==0.17.1; then
  python3 -m ziglang build-exe ../contract/src/contract.zig -target wasm32-freestanding -mcpu mvp -O ReleaseSmall -fno-entry -rdynamic -fsingle-threaded -femit-bin=public/bounty_escrow.wasm
else
  echo 'zig install failed; skipping wasm build'
fi
npx vite build
