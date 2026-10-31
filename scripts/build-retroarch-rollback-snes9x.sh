#!/usr/bin/env bash
# Build a pinned, unmodified Snes9x core and matching native/WASM probes.
set -euo pipefail
export EMCC_CORES=2 BINARYEN_CORES=2
COMPAT_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_ROOT="$(cd -- "$COMPAT_REPO/.." && pwd)"
COMPAT_WORK="${COMPAT_WORK:-$TASK_ROOT/result/netplay-interop/snes-rollback-build}"
COMPAT_EMSDK="${COMPAT_EMSDK:-$TASK_ROOT/build/emsdk}"
COMPAT_SOURCE="${COMPAT_SOURCE:-$TASK_ROOT/build/compile/snes9x}"
COMPAT_FRONTEND="${COMPAT_FRONTEND:-$TASK_ROOT/build/compile/retroarch-netplay}"
COMPAT_REVISION=2d4cce69f4fe1c53a2c1423cdc06f2dea8b870a1
COMPAT_PROBE="$COMPAT_REPO/test/snes-core-probe.c"
if [[ -e "$COMPAT_WORK" ]]; then
  printf 'Refusing to reuse existing work directory: %s\n' "$COMPAT_WORK" >&2
  exit 1
fi
test -x "$COMPAT_EMSDK/upstream/emscripten/emcc"
test "$(git -C "$COMPAT_SOURCE" rev-parse "$COMPAT_REVISION")" = "$COMPAT_REVISION"
mkdir -p -- "$COMPAT_WORK/native-source" "$COMPAT_WORK/wasm-source"
git -C "$COMPAT_SOURCE" archive --format=tar "$COMPAT_REVISION" > "$COMPAT_WORK/source.tar"
for kind in native wasm; do
  tar -xf "$COMPAT_WORK/source.tar" -C "$COMPAT_WORK/$kind-source"
done
make -C "$COMPAT_WORK/native-source/libretro" -j2 GIT_VERSION=2d4cce69 LTO=
cc -O2 -fPIC -shared "$COMPAT_PROBE" "$COMPAT_WORK/native-source/libretro/snes9x_libretro.so" \
  -I "$COMPAT_WORK/native-source/libretro" -o "$COMPAT_WORK/native-probe.so" \
  "-Wl,-rpath,$COMPAT_WORK/native-source/libretro"
export EM_CONFIG="$COMPAT_EMSDK/.emscripten"
export PATH="$COMPAT_EMSDK/upstream/emscripten:$COMPAT_EMSDK/upstream/bin:$PATH"
make -C "$COMPAT_WORK/wasm-source/libretro" -j2 platform=emscripten \
  GIT_VERSION=2d4cce69 LTO= CC=emcc CXX=em++ AR=emar EMULATORJS_THREADS=0
cp -- "$COMPAT_WORK/wasm-source/libretro/snes9x_libretro_emscripten.bc" "$COMPAT_WORK/snes9x_libretro.a"
emcc -c "$COMPAT_PROBE" -I "$COMPAT_WORK/wasm-source/libretro" -O2 -o "$COMPAT_WORK/probe.o"
em++ "$COMPAT_WORK/probe.o" "$COMPAT_WORK/snes9x_libretro.a" \
  -O2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_probe_init","_probe_step","_probe_size","_probe_save","_probe_load","_probe_close","_probe_memory","_probe_memory_size","_probe_version"]' \
  -o "$COMPAT_WORK/core-probe.mjs"
if [[ "${COMPAT_BUILD_WEB:-0}" == 1 ]]; then
  python3 - "$COMPAT_FRONTEND" "$COMPAT_WORK/frontend" <<'PY'
import shutil, sys
shutil.copytree(sys.argv[1], sys.argv[2], ignore=shutil.ignore_patterns('.git'))
PY
  cp -- "$COMPAT_WORK/snes9x_libretro.a" "$COMPAT_WORK/frontend/libretro_emscripten.a"
  emmake make -C "$COMPAT_WORK/frontend" -f Makefile.emulatorjs -j2 \
    TARGET=snes9x_libretro.js HAVE_THREADS=0 HAVE_OPENGLES3=1 HAVE_CHD=0 \
    HAVE_7ZIP=1 HAVE_AL=0 HAVE_RWEBAUDIO=1 ASYNC=0
  mkdir -p -- "$COMPAT_WORK/web"
  cp -- "$COMPAT_WORK/frontend/snes9x_libretro.js" "$COMPAT_WORK/frontend/snes9x_libretro.wasm" "$COMPAT_WORK/web/"
  cp -- "$COMPAT_WORK/native-source/LICENSE" "$COMPAT_WORK/web/license.txt"
  python3 - "$COMPAT_WORK/web" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
core = {'name': 'snes9x', 'extensions': ['sfc', 'smc'], 'options': {}, 'save': 'srm', 'repo': 'https://github.com/snes9xgit/snes9x'}
build = {'minimumEJSVersion': '4.3.0', 'version': 'snes9x-2d4cce69', 'sourceRevision': '2d4cce69f4fe1c53a2c1423cdc06f2dea8b870a1', 'corePatched': False}
for name, value in [('core.json', core), ('build.json', build)]:
    (out / name).write_text(json.dumps(value) + '\n')
PY
  (
    cd -- "$COMPAT_WORK/web"
    7z a -t7z -mx=7 snes9x-wasm.data snes9x_libretro.js snes9x_libretro.wasm core.json build.json license.txt
  )
fi
python3 - "$COMPAT_WORK" "$COMPAT_REVISION" <<'PY'
from pathlib import Path
import ctypes, hashlib, json, sys
root = Path(sys.argv[1])
core = ctypes.CDLL(str(root / 'native-probe.so'))
core.probe_version.restype = ctypes.c_char_p
paths = ['source.tar', 'native-source/libretro/snes9x_libretro.so', 'native-probe.so', 'snes9x_libretro.a', 'core-probe.mjs', 'core-probe.wasm']
paths += [str(p.relative_to(root)) for p in (root / 'web').glob('*')] if (root / 'web').exists() else []
manifest = {'core': 'Snes9x', 'version': core.probe_version().decode(), 'sourceRevision': sys.argv[2],
            'corePatched': False, 'sha256': {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in paths}}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
printf 'Native core: %s\nWASM probe: %s\n' "$COMPAT_WORK/native-source/libretro/snes9x_libretro.so" "$COMPAT_WORK/core-probe.mjs"
