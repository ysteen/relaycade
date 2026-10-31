#!/usr/bin/env bash
# Build mGBA Splitscreen with only its serialization initialization declaration.
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPAT_PATCH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../patches" && pwd)/mgba-must-initialize.patch"
COMPAT_WORK="${COMPAT_WORK:-$TASK_ROOT/result/netplay-interop/mgba-rebuild}"
COMPAT_FRONTEND="${COMPAT_FRONTEND:-$TASK_ROOT/build/compile/retroarch-netplay}"
COMPAT_EMSDK="${COMPAT_EMSDK:-$TASK_ROOT/build/emsdk}"
COMPAT_ARCHIVE="${COMPAT_ARCHIVE:-$TASK_ROOT/result/netplay-interop/stock-core/downloads/mgba-splitscreen-f1d5975.tar.gz}"
COMPAT_REVISION=f1d5975d77285f77affbfe64b7050ebd5c4b6a77
COMPAT_ARCHIVE_SHA256=8374542f8a042a1ad661a5e886083f3cfcf84fe79c1e471dae5eb6c432b88958
if [[ -e "$COMPAT_WORK" ]]; then
  printf '%s\n' "Refusing to reuse existing work directory: $COMPAT_WORK" >&2
  exit 1
fi
test -f "$COMPAT_FRONTEND/Makefile.emulatorjs"
test -f "$COMPAT_FRONTEND/ejs-input-netplay.inc"
test -x "$COMPAT_EMSDK/upstream/emscripten/emcc"
if [[ ! -f "$COMPAT_ARCHIVE" ]]; then
  mkdir -p -- "$(dirname -- "$COMPAT_ARCHIVE")"
  curl --fail --location --retry 2 --max-time 180 \
    "https://codeload.github.com/Spuds0588/mgba-splitscreen/tar.gz/$COMPAT_REVISION" \
    --output "$COMPAT_ARCHIVE"
fi
printf '%s  %s\n' "$COMPAT_ARCHIVE_SHA256" "$COMPAT_ARCHIVE" | sha256sum --check --status
mkdir -p -- "$COMPAT_WORK/source" "$COMPAT_WORK/wasm-source" "$COMPAT_WORK/web"
tar -xzf "$COMPAT_ARCHIVE" --strip-components=1 -C "$COMPAT_WORK/source"
tar -xzf "$COMPAT_ARCHIVE" --strip-components=1 -C "$COMPAT_WORK/wasm-source"
patch -d "$COMPAT_WORK/source" -p1 --input "$COMPAT_PATCH"
patch -d "$COMPAT_WORK/wasm-source" -p1 --input "$COMPAT_PATCH"
python3 - "$COMPAT_FRONTEND" "$COMPAT_WORK/frontend" "$COMPAT_WORK/wasm-source/CMakeLists.txt" <<'PY'
from pathlib import Path
import shutil, sys
source, target, cmake = map(Path, sys.argv[1:])
shutil.copytree(source, target, ignore=shutil.ignore_patterns('.git'))
shim = target / 'ejs-input-netplay.inc'
text = shim.read_text()
assert 'ejs_sync_buttons[2]' in text
text = text.replace('ejs_sync_buttons[2]', 'ejs_sync_buttons[4]').replace('port >= 2', 'port >= 4')
text = text.replace('EMSCRIPTEN_KEEPALIVE int ejs_sync_step(unsigned p1, unsigned p2, int present)',
                    'EMSCRIPTEN_KEEPALIVE int ejs_sync_step_multi(unsigned p1, unsigned p2, unsigned p3, unsigned p4, int present)')
text = text.replace('   ejs_sync_buttons[1] = p2;\n',
                    '   ejs_sync_buttons[1] = p2;\n   ejs_sync_buttons[2] = p3;\n   ejs_sync_buttons[3] = p4;\n')
text = text.replace('EMSCRIPTEN_KEEPALIVE size_t ejs_sync_state_size(void)',
                    'EMSCRIPTEN_KEEPALIVE int ejs_sync_step(unsigned p1, unsigned p2, int present)\n{\n   return ejs_sync_step_multi(p1, p2, 0, 0, present);\n}\n\nEMSCRIPTEN_KEEPALIVE size_t ejs_sync_state_size(void)')
shim.write_text(text)
(target / 'retroarch.c').touch()
text = cmake.read_text()
old = 'add_library(mgba_splitscreen_libretro SHARED ${CORE_SRC} ${SP_SRC} ${SP_SIO_SRC} ${CORE_VFS_SRC})'
assert text.count(old) == 1
cmake.write_text(text.replace(old, 'if(EMSCRIPTEN)\n\t\tset(SP_LIBRARY_TYPE STATIC)\n\telse()\n\t\tset(SP_LIBRARY_TYPE SHARED)\n\tendif()\n\tadd_library(mgba_splitscreen_libretro ${SP_LIBRARY_TYPE} ${CORE_SRC} ${SP_SRC} ${SP_SIO_SRC} ${CORE_VFS_SRC})'))
PY
COMPAT_CMAKE_FLAGS=(
  -DCMAKE_BUILD_TYPE=Release -DLIBMGBA_ONLY=ON -DBUILD_LIBRETRO_SPLITSCREEN=ON
  -DBUILD_SHARED=OFF -DBUILD_STATIC=OFF -DENABLE_DEBUGGERS=OFF -DENABLE_SCRIPTING=OFF
  -DUSE_ELF=OFF -DUSE_LIBZIP=OFF -DUSE_LZMA=OFF -DUSE_MINIZIP=OFF
  -DUSE_PNG=OFF -DUSE_SQLITE3=OFF -DUSE_ZLIB=OFF
)
cmake -S "$COMPAT_WORK/source" -B "$COMPAT_WORK/native" "${COMPAT_CMAKE_FLAGS[@]}"
cmake --build "$COMPAT_WORK/native" --target mgba_splitscreen_libretro -j2
export EM_CONFIG="$COMPAT_EMSDK/.emscripten"
export PATH="$COMPAT_EMSDK/upstream/emscripten:$COMPAT_EMSDK/upstream/bin:$PATH"
emcmake cmake -S "$COMPAT_WORK/wasm-source" -B "$COMPAT_WORK/wasm" \
  "${COMPAT_CMAKE_FLAGS[@]}" -DCMAKE_C_FLAGS=-D_GNU_SOURCE
cmake --build "$COMPAT_WORK/wasm" --target mgba_splitscreen_libretro -j2
cp -- "$COMPAT_WORK/wasm/mgba_splitscreen_libretro.a" "$COMPAT_WORK/frontend/libretro_emscripten.a"
emmake make -C "$COMPAT_WORK/frontend" -f Makefile.emulatorjs -j2 \
  TARGET=mgba_link_libretro.js HAVE_THREADS=0 HAVE_OPENGLES3=1 HAVE_CHD=0 \
  HAVE_7ZIP=1 HAVE_AL=0 HAVE_RWEBAUDIO=1 ASYNC=0
cp -- "$COMPAT_WORK/frontend/mgba_link_libretro.js" "$COMPAT_WORK/frontend/mgba_link_libretro.wasm" "$COMPAT_WORK/web/"
cp -- "$COMPAT_WORK/source/LICENSE" "$COMPAT_WORK/web/license.txt"
python3 - "$COMPAT_WORK/web" <<'PY'
from pathlib import Path
import hashlib, json, sys
out = Path(sys.argv[1])
documents = {
    'core.json': {'name': 'mgba_splitscreen', 'extensions': ['gba'], 'options': {}, 'save': 'srm', 'repo': 'https://github.com/Spuds0588/mgba-splitscreen'},
    'build.json': {'minimumEJSVersion': '4.3.0', 'version': 'retroarch-compat-mgba-f1d5975-init-only-4p', 'mgba_splitscreen': 'f1d5975d77285f77affbfe64b7050ebd5c4b6a77', 'corePatch': 'MUST_INITIALIZE only', 'frontendInputs': 4},
}
for filename, value in documents.items():
    (out / filename).write_text(json.dumps(value) + '\n')
PY
(
  cd -- "$COMPAT_WORK/web"
  7z a -t7z -mx=7 mgba_splitscreen-wasm.data mgba_link_libretro.js mgba_link_libretro.wasm core.json build.json license.txt
  sha256sum mgba_link_libretro.wasm mgba_splitscreen-wasm.data
)
python3 - "$COMPAT_WORK/web" <<'PY'
from pathlib import Path
import hashlib, json, sys
out = Path(sys.argv[1])
report = {'core': 'mgba_splitscreen', 'buildStart': hashlib.sha256((out / 'mgba_splitscreen-wasm.data').read_bytes()).hexdigest(), 'options': {'defaultWebGL2': True}}
(out / 'mgba_splitscreen.json').write_text(json.dumps(report) + '\n')
PY
printf 'Native core: %s\nWeb artifacts: %s\n' "$COMPAT_WORK/native/mgba_splitscreen_libretro.so" "$COMPAT_WORK/web"
