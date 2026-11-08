#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${1:?Usage: build-wfc-gateway.sh libslirp-source output-directory}
output=${2:?Specify an output directory}
revision=ce12dcddf710a71dc0de6450ec95edbadf8e9f66
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
mkdir -p "$output/objects"
python3 - "$source_dir" "$output" <<'PY'
from pathlib import Path
import sys
source, output = map(Path, sys.argv[1:])
version = (source / 'src/libslirp-version.h.in').read_text()
for key, value in {'MAJOR_VERSION': '4', 'MINOR_VERSION': '9', 'MICRO_VERSION': '7', 'VERSION_STRING': '"4.9.7"'}.items():
    version = version.replace('@SLIRP_' + key + '@', value)
(output / 'libslirp-version.h').write_text(version)
PY
read -ra glib_cflags <<< "$(pkg-config --cflags glib-2.0)"
read -ra glib_libs <<< "$(pkg-config --static --libs glib-2.0)"
for file in "$source_dir"/src/*.c; do
    "${CC:-cc}" -O2 -D_GNU_SOURCE -DBUILDING_LIBSLIRP -I"$source_dir/src" -I"$output" "${glib_cflags[@]}" -c "$file" -o "$output/objects/$(basename "$file" .c).o"
done
link_options=()
if [[ "${WFC_STATIC:-0}" == 1 ]]; then link_options+=(-static); fi
"${CC:-cc}" -O2 "${link_options[@]}" -I"$source_dir/src" -I"$output" "$repo/wfc/slirp-gateway.c" "$output"/objects/*.o "${glib_libs[@]}" -o "$output/wfc-slirp"
cp "$source_dir/COPYRIGHT" "$output/libslirp-COPYRIGHT"
