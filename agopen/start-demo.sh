#!/bin/bash
# The whole live demo, from a clean state, in one command (macOS):
#   - three AgOpenWeb copies (one per tractor), with the farm and implement profiles freshly written
#   - one Terminal window per tractor, printing telemetry every second (type dead / stuck / ok into it)
#   - one Terminal window running the coordinator
#   - the status page in your browser, then a preflight check
# Usage: agopen/start-demo.sh        agopen/start-demo.sh stop
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MULTI="${AGOPEN_MULTI:-$REPO/../agopen-multi}"
stop_all() {
  pkill -f "agopen/tractor-node.js" 2>/dev/null; pkill -f "agopen/live.js" 2>/dev/null
  "$MULTI/start-fleet.sh" stop >/dev/null 2>&1
  rm -f "$REPO"/agopen/out/lock-*.json
}
if [ "$1" = "stop" ]; then stop_all; echo "Everything stopped."; exit 0; fi
if [ ! -x "$MULTI/bin/AgOpenWeb.Desktop" ]; then echo "No patched AgOpenWeb build in $MULTI/bin. See agopen/README.md, Set up once."; exit 1; fi

echo "1/5 Stopping anything left from an earlier run..."
stop_all
echo "2/5 Writing the farm and implement profiles into each AgOpenWeb copy..."
(cd "$REPO" && node agopen/build-farm.js) || exit 1
echo "3/5 Starting three AgOpenWeb copies..."
"$MULTI/start-fleet.sh" 3 >/dev/null 2>&1 </dev/null
for P in 5175 5176 5177; do
  for k in $(seq 1 40); do curl -s -o /dev/null -m 1 "http://localhost:$P/" && break; sleep 0.5; done
  curl -s -o /dev/null -m 1 "http://localhost:$P/" || { echo "AgOpenWeb did not start on port $P. See $MULTI/tractor-$P.log"; exit 1; }
done
sleep 2

win() { # title, x, y, width, height, command
  osascript >/dev/null <<OSA
tell application "Terminal"
  activate
  set w to do script "clear; printf '\\\\e]0;$1\\\\a'; cd '$REPO' && $6"
  delay 0.3
  set bounds of front window to {$2, $3, $(($2 + $4)), $(($3 + $5))}
end tell
OSA
}
echo "4/5 Opening a Terminal window per tractor, then the coordinator..."
win "Tractor T1 telemetry" 0    560 640 300 "node agopen/tractor-node.js T1 5175 --depot"
win "Tractor T2 telemetry" 640  560 640 300 "node agopen/tractor-node.js T2 5176 --depot"
win "Tractor T3 telemetry" 1280 560 640 300 "node agopen/tractor-node.js T3 5177 --depot"
for P in 6175 6176 6177; do for k in $(seq 1 40); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$P/telemetry" && break; sleep 0.5; done; done
win "Fleet coordinator" 0 40 960 500 "node agopen/live.js ${LIVE_ARGS:-}"
for k in $(seq 1 30); do curl -s -m 1 -o /dev/null http://127.0.0.1:5190/state && break; sleep 0.5; done
open "http://localhost:5190/"
echo "5/5 Preflight:"
(cd "$REPO" && node agopen/preflight.js)
