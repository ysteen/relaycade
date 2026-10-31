#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_REVISION=becfa4bad25132b6cb8068a0da463f67eefee44e
if [[ $# != 2 ]]; then
  printf 'Usage: %s <RetroArch source checkout> <new prepared directory>\n' "$0" >&2
  exit 1
fi
FRONTEND_SOURCE="$1"
FRONTEND_DESTINATION="$2"
if [[ -e "$FRONTEND_DESTINATION" ]]; then
  printf 'Refusing to reuse existing directory: %s\n' "$FRONTEND_DESTINATION" >&2
  exit 1
fi
git -C "$FRONTEND_SOURCE" cat-file -e "$FRONTEND_REVISION^{commit}"
mkdir -p -- "$FRONTEND_DESTINATION"
git -C "$FRONTEND_SOURCE" archive "$FRONTEND_REVISION" | tar -x -C "$FRONTEND_DESTINATION"
cp -- "$PROJECT_ROOT/frontend/ejs-input-netplay.inc" "$FRONTEND_DESTINATION/ejs-input-netplay.inc"
python3 - "$FRONTEND_DESTINATION/retroarch.c" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
source = p.read_text()
assert '#include "ejs-input-netplay.inc"' not in source
p.write_text(source + '\n#ifdef EMULATORJS\n#include "ejs-input-netplay.inc"\n#endif\n')
PY
printf '%s\n' "$FRONTEND_REVISION" > "$FRONTEND_DESTINATION/NETPLAY_SOURCE_REVISION"
printf 'Prepared frontend: %s\nSet COMPAT_FRONTEND to this directory for core builds.\n' "$FRONTEND_DESTINATION"
