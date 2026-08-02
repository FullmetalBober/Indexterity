#!/usr/bin/env bash
# podman-compose, with the two things that break it in this repo handled.
#
#   npm run up      npm run down      npm run compose -- logs -f api
#
# 1. node_modules/.bin shadows nftables' `nft` with @vercel/nft, and podman's
#    network backend shells out to `nft`. It then reads JavaScript where it
#    expects nftables JSON and every container fails to start with
#    "netavark: nftables error: got invalid json".
#
# 2. If XDG_RUNTIME_DIR is cleaned while podman still has containers recorded as
#    created — a logout, a reboot, a systemd tmpfiles run — their crun state
#    goes missing and `up` fails with "cannot open .../exec.fifo". The
#    containers cannot be started or stopped, only removed. Named volumes are
#    untouched by that, so the database survives; recreate and carry on.
set -euo pipefail

_clean_path=""
IFS=: read -ra _parts <<< "$PATH"
for _p in "${_parts[@]}"; do
  case "$_p" in */node_modules/.bin) continue ;; esac
  _clean_path="${_clean_path:+$_clean_path:}$_p"
done
export PATH="$_clean_path"

compose() { podman-compose "$@"; }

if [ "${1:-}" = "up" ]; then
  shift
  if ! compose up -d "$@" 2>/tmp/compose-err.$$; then
    if grep -q "exec.fifo" /tmp/compose-err.$$; then
      echo "stale container runtime state — recreating (named volumes are kept)" >&2
      compose down --remove-orphans >/dev/null 2>&1 || true
      compose up -d "$@"
    else
      cat /tmp/compose-err.$$ >&2
      rm -f /tmp/compose-err.$$
      exit 1
    fi
  fi
  rm -f /tmp/compose-err.$$
  compose ps
else
  compose "$@"
fi
