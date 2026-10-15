#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ é necessário para iniciar o CMS."
  exit 1
fi
if curl -fsS http://127.0.0.1:4173/api/admin/status >/dev/null 2>&1; then
  echo "Portfolio CMS já está rodando: http://127.0.0.1:4173"
  echo "Painel: http://127.0.0.1:4173/admin"
  exit 0
fi
mkdir -p data assets/uploads
nohup node server.cjs >> data/server.log 2>&1 < /dev/null &
PID=$!
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/api/admin/status >/dev/null 2>&1; then
    echo "Portfolio CMS iniciado (PID $PID)."
    echo "Site: http://127.0.0.1:4173"
    echo "Painel administrativo: http://127.0.0.1:4173/admin"
    exit 0
  fi
  sleep 0.25
done
echo "O servidor não iniciou. Consulte data/server.log."
exit 1
