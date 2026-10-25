#!/bin/sh
# Gera a pasta www de release.  Uso:
#   tools/build-www.sh server https://api.SEU-DOMINIO.com.br   -> app ligado ao servidor (PRODUÇÃO)
#   tools/build-www.sh demo                                    -> protótipo de demonstração (sem rede)
set -eu
MODE="${1:-}"; API="${2:-}"; SRC="$(dirname "$0")/../www"; OUT="$(dirname "$0")/../dist/www"
rm -rf "$OUT"; mkdir -p "$OUT"; cp -r "$SRC"/. "$OUT"/
case "$MODE" in
  server)
    case "$API" in https://*) ;; *) echo "API deve começar com https://"; exit 1;; esac
    ORIGIN="$(printf '%s' "$API" | sed -E 's#^(https://[^/]+).*#\1#')"
    printf "window.TOBUS_CONFIG = { MODO_DEMO: false, API_URL: '%s', TERMS_VERSION: '2026-10' };\n" "$ORIGIN" > "$OUT/config.js"
    sed -i "s#__API_ORIGIN__#$ORIGIN#" "$OUT/index.html" ;;
  demo)
    sed -i "s# __API_ORIGIN__##" "$OUT/index.html" ;;
  *) echo "uso: build-www.sh server <https://api...> | demo"; exit 1;;
esac
# Verificações de release
grep -q "__API_ORIGIN__" "$OUT/index.html" && { echo "placeholder de CSP não substituído"; exit 1; }
[ "$MODE" = server ] && grep -q "MODO_DEMO: true" "$OUT/config.js" && { echo "release com MODO_DEMO=true!"; exit 1; }
echo "OK: $OUT ($MODE)"
