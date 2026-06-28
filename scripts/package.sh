#!/usr/bin/env bash
#
# Build an upload-ready add-on package (a .zip with manifest.json at the root).
# Usage: npm run package   (or: bash scripts/package.sh)
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./manifest.json').version")"
OUT_DIR="dist"
OUT="${OUT_DIR}/folder-filter-scheduler-${VERSION}.zip"

# Only the files the add-on needs at runtime — no tests, CI, docs, or secrets.
INCLUDE=(manifest.json src options _locales icons LICENSE)

mkdir -p "$OUT_DIR"
rm -f "$OUT"

zip -r -X "$OUT" "${INCLUDE[@]}" -x '*.DS_Store' >/dev/null

# Fail loudly if manifest.json is not at the archive root (the #1 upload error).
# Capture the listing first: piping straight into `grep -q` makes grep close the
# pipe on first match, which SIGPIPEs `unzip` and — under `set -o pipefail` —
# reports a false failure.
listing="$(unzip -l "$OUT")"
if ! printf '%s\n' "$listing" | grep -qE ' manifest\.json$'; then
  echo "ERROR: manifest.json is not at the ZIP root." >&2
  exit 1
fi

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
