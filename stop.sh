#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/data/server.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "PID do CMS não encontrado. Ele pode já estar parado."
  exit 0
fi
PID="$(tr -dc '0-9' < "$PID_FILE")"
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Arquivo PID antigo removido."
  exit 0
fi
kill "$PID"
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.2
done
rm -f "$PID_FILE"
echo "Portfolio CMS parado."
