#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${1:?Usage: build-melonds-ds-web.sh core-source frontend-source emsdk output-directory}
frontend=${2:?Specify an EmulatorJS RetroArch checkout}
emsdk=${3:?Specify Emscripten SDK 3.1.74}
output=${4:?Specify an output directory}
test "$(git -C "$source_dir" rev-parse HEAD)" = f394adbacb5722ee97c1b37c8064da9a25818310
patch_file="$repo/core-patches/melonds-ds-web-wfc.patch"
if git -C "$source_dir" apply --check "$patch_file" 2>/dev/null; then
    git -C "$source_dir" apply "$patch_file"
else
    git -C "$source_dir" apply --reverse --check "$patch_file"
fi
export EM_CONFIG="$emsdk/.emscripten" EMCC_CORES=2 BINARYEN_CORES=2
export PATH="$emsdk/upstream/emscripten:$emsdk/upstream/bin:$PATH"
emcmake cmake -S "$source_dir" -B "$source_dir/web-build" -DCMAKE_BUILD_TYPE=Release \
    -DMELONDS_REPOSITORY_TAG=16f127dbb587a73371827ce79689c5d237c4b59b \
    -DCMAKE_CXX_FLAGS=-fexceptions \
    -DFETCHCONTENT_UPDATES_DISCONNECTED=ON -DENABLE_JIT=OFF -DENABLE_OPENGL=OFF \
    -DENABLE_COMPUTE_RENDERER=OFF -DENABLE_THREADED_RENDERER=OFF -DENABLE_DYNAMIC=OFF -DBUILD_TESTING=OFF
cmake --build "$source_dir/web-build" --target melondsds_libretro -j2
python3 - "$frontend" "$output/frontend" <<'PY'
from pathlib import Path
import re, shutil, sys
source, target = map(Path, sys.argv[1:])
if not target.exists():
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('.git', 'obj-emscripten', '*.wasm', '*_libretro.js', 'libretro_emscripten.*', 'obj-emscripten-*'))
p = target / 'Makefile.emulatorjs'
s = p.read_text().replace('ERROR_ON_UNDEFINED_SYMBOLS=0', 'ERROR_ON_UNDEFINED_SYMBOLS=1')
flags = '\nLDFLAGS += -sDISABLE_EXCEPTION_CATCHING=0 -sMAXIMUM_MEMORY=1073741824 --emit-symbol-map\n'
s = re.sub(r'\nLDFLAGS \+= -sDISABLE_EXCEPTION_CATCHING=0 -sMAXIMUM_MEMORY=1073741824[^\n]*\n', '\n', s)
if flags not in s:
    s += flags
p.write_text(s)
PY
core_build="$source_dir/web-build"
cp "$core_build/src/libretro/melondsds_libretro.a" "$output/frontend/libretro_emscripten.a"
libraries="$core_build/_deps/melonds-build/src/libcore.a $core_build/_deps/melonds-build/src/teakra/src/libteakra.a $core_build/_deps/fmt-build/libfmt.a $core_build/_deps/glm-build/glm/libglm.a $core_build/libretro-common.a"
emmake make -C "$output/frontend" -f Makefile.emulatorjs -j2 LD=em++ \
    TARGET=melondsds_libretro.js HAVE_THREADS=0 HAVE_OPENGLES3=1 HAVE_CHD=0 HAVE_7ZIP=1 \
    HAVE_AL=0 HAVE_RWEBAUDIO=1 ASYNC=0 additional_libs="$libraries"
mkdir -p "$output/web"
cp "$output/frontend/melondsds_libretro.js" "$output/frontend/melondsds_libretro.wasm" "$output/web/"
cp "$source_dir/LICENSE" "$output/web/license.txt"
python3 - "$output/web" "$patch_file" <<'PY'
from pathlib import Path
import hashlib, json, sys
from datetime import datetime, timezone
out, patch = map(Path, sys.argv[1:])
core = {'name': 'melondsds', 'extensions': ['nds'], 'options': {'defaultWebGL2': True, 'supportsMouse': True, 'supportsThreads': False}, 'save': 'srm',
        'repo': 'https://github.com/JesseTG/melonds-ds', 'supportsMouse': True}
build = {'core': 'melondsds', 'buildStart': datetime.now(timezone.utc).isoformat(),
         'options': core['options'], 'minimumEJSVersion': '4.3.0', 'version': 'melondsds-f394adb-wfc1',
         'source': 'f394adbacb5722ee97c1b37c8064da9a25818310',
         'melonDS': '16f127dbb587a73371827ce79689c5d237c4b59b',
         'emscripten': '3.1.74', 'wfcTransport': 'ethernet-websocket-v1',
         'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest()}
for name, value in [('core.json', core), ('build.json', build)]:
    (out / name).write_text(json.dumps(value, indent=2) + '\n')
PY
(cd "$output/web" && 7z a -t7z -mx=5 melondsds-wasm.data melondsds_libretro.js melondsds_libretro.wasm core.json build.json license.txt)
