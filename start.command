#!/bin/bash
# Double-click to start the M40 Neck EMG Logger: serves this folder on localhost and opens Chrome.
# (Web Bluetooth and the camera only work on http://localhost or https, and only in Chrome/Edge.)
cd "$(dirname "$0")" || exit 1
PORT=8040
URL="http://localhost:$PORT/"

# An older version of this launcher used `python3 -m http.server`, which lets Chrome cache stale files.
OLD_PID=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD_PID" ] && ps -o command= -p "$OLD_PID" | grep -q "http.server"; then
  kill "$OLD_PID" 2>/dev/null
  sleep 0.5
fi

if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 serve.py $PORT >/dev/null 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  sleep 0.6
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$URL"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -a "Microsoft Edge" "$URL"
else
  echo "Chrome or Edge is required (Safari has no Web Bluetooth)."
  open "$URL"
fi

echo "M40 Neck EMG Logger running at $URL"
echo "Keep this window open while you use the app. Close it (or press Ctrl+C) to stop."
wait
