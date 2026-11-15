#!/bin/bash
# Opens the whole live demo on this Mac:
#   - one Terminal window per tractor, printing telemetry every second (type dead / stuck / ok into it)
#   - one Terminal window running the coordinator (type: break T1 | repair T1 | fault T2 stuck | quit)
#   - a browser page with every tractor's state and each AgOpenWeb view
# Usage: agopen/start-demo.sh        agopen/start-demo.sh stop
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MULTI="${AGOPEN_MULTI:-$REPO/../agopen-multi}"
if [ "$1" = "stop" ]; then
  pkill -f "agopen/tractor-node.js"; pkill -f "agopen/live.js"; echo "tractor processes and coordinator stopped (AgOpenWeb copies left running)"; exit 0
fi
pkill -f "agopen/tractor-node.js" 2>/dev/null; pkill -f "agopen/live.js" 2>/dev/null
"$MULTI/start-fleet.sh" 3
for P in 5175 5176 5177; do for k in $(seq 1 20); do curl -s -o /dev/null "http://localhost:$P/" && break; sleep 0.5; done; done

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
win "Tractor T1 telemetry" 0   560 640 300 "node agopen/tractor-node.js T1 5175"
win "Tractor T2 telemetry" 640 560 640 300 "node agopen/tractor-node.js T2 5176"
win "Tractor T3 telemetry" 1280 560 640 300 "node agopen/tractor-node.js T3 5177"
for P in 6175 6176 6177; do for k in $(seq 1 30); do curl -s -m 1 -o /dev/null http://127.0.0.1:$P/telemetry && break; sleep 0.5; done; done
win "Fleet coordinator" 0 40 960 500 "node agopen/live.js --sec ${SEC:-9}"
for k in $(seq 1 20); do curl -s -m 1 -o /dev/null http://127.0.0.1:5190/state && break; sleep 0.5; done
open "http://localhost:5190/"
echo "Demo running. Status page: http://localhost:5190/"
