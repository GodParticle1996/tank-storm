#!/usr/bin/env bash
# Headless screenshots of the renderer — see the art direction without launching
# Electron. Three of the defects listed in RENDERING.md were found this way.
#
#   npm run shots                       # all themes
#   npm run shots -- night-battle       # just one
#
# Notes that are load-bearing (see RENDERING.md):
#   • served over file://, because headless Chrome cannot always reach localhost
#   • --allow-file-access-from-files, or the ES module import is blocked by CORS
#   • WebGL runs on SwiftShader (software): a frame costs ~1.5 s, so the harness
#     renders few frames, passes a FIXED dt and disables MSAA. Bloom, the colour
#     grade and every shader are the real pipeline.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/shots"
PAGE="$HERE/dist-harness/harness.html"
mkdir -p "$OUT"

[ -f "$PAGE" ] || { echo "harness not built (npm run harness:build)"; exit 1; }

declare -A SCENES=(
  [night-battle]="theme=night&scene=battle&t=0.20"
  [storm-battle]="theme=storm&scene=battle&t=0.20"
  [lunar-battle]="theme=lunar&scene=battle&t=0.20"
  [inferno-battle]="theme=inferno&scene=battle&t=0.20"
  [night-calm]="theme=night&scene=calm&t=0.20"
)

names=("$@")
[ ${#names[@]} -eq 0 ] && names=(night-battle storm-battle lunar-battle inferno-battle night-calm)

for name in "${names[@]}"; do
  q="${SCENES[$name]:-}"
  [ -n "$q" ] || { echo "unknown scene: $name"; continue; }
  timeout "${SHOT_TIMEOUT:-300}" google-chrome --headless=new --no-sandbox \
    --disable-dev-shm-usage --allow-file-access-from-files \
    --user-data-dir=/tmp/tankstorm-harness-profile \
    --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
    --window-size="${W:-900}","${H:-506}" --hide-scrollbars \
    --virtual-time-budget=40000 \
    --screenshot="$OUT/$name.png" "file://$PAGE?$q" > /dev/null 2>&1 || true
  echo "  $name -> $(du -h "$OUT/$name.png" 2>/dev/null | cut -f1 || echo FAILED)"
done
echo "shots in $OUT"
