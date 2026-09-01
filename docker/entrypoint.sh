#!/bin/sh
set -eu

umask 077

quality_guard_dir=/var/lib/grok2api-quality-guard
mkdir -p "${quality_guard_dir}" /app/data /run/grok2api
chown -R grok2api:grok2api "${quality_guard_dir}" /app/data /run/grok2api
chmod 0700 "${quality_guard_dir}"

if [ -f "${GROK2API_CONFIG_SOURCE:-/run/grok2api/config.yaml}" ]; then
  cp "${GROK2API_CONFIG_SOURCE:-/run/grok2api/config.yaml}" /app/config.yaml
fi

chown grok2api:grok2api /app/config.yaml || true
chmod 0600 /app/config.yaml || true

exec su-exec grok2api:grok2api "$@"
