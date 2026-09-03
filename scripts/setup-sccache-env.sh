#!/usr/bin/env bash
# scripts/setup-sccache-env.sh
# Source this file to configure sccache for Shelby.
#
# POSIX sh compatible: can be sourced from bash, dash, or /bin/sh (e.g.
# `RUN . scripts/setup-sccache-env.sh` in a Dockerfile or an sh-based Make
# recipe). Running it directly only validates credentials -- the exports
# cannot reach an already-running parent shell.

# Validate credentials BEFORE exporting anything, so a failed source leaves
# the calling shell untouched. Placeholder values left over from older
# versions of this script (CHANGE_ME_*) are rejected as well, and every
# missing or placeholder variable is reported at once. The helper variable
# is underscore-prefixed to resist collisions with the caller's own
# variables and is unset before returning, so nothing leaks.
_sccache_missing_vars=""
case ${AWS_ACCESS_KEY_ID:-} in
  ''|CHANGE_ME*) _sccache_missing_vars="$_sccache_missing_vars AWS_ACCESS_KEY_ID" ;;
esac
case ${AWS_SECRET_ACCESS_KEY:-} in
  ''|CHANGE_ME*) _sccache_missing_vars="$_sccache_missing_vars AWS_SECRET_ACCESS_KEY" ;;
esac
if [ -n "$_sccache_missing_vars" ]; then
  printf 'setup-sccache-env.sh: required environment variable(s) not set (or still a CHANGE_ME placeholder - unset them and export real credentials):%s\n' "$_sccache_missing_vars" >&2
  unset _sccache_missing_vars
  # `return` only works when sourced; fall back to `exit` when executed.
  if (return 0) 2>/dev/null; then return 1; else exit 1; fi
fi
unset _sccache_missing_vars

export SCCACHE_BUCKET="${SCCACHE_BUCKET:-shelby}"
export SCCACHE_ENDPOINT="${SCCACHE_ENDPOINT:-http://localhost:9000}"
export SCCACHE_REGION="shelbyland"
export SCCACHE_S3_USE_SSL=false
export SCCACHE_S3_NO_CREDENTIALS=false
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export RUSTC_WRAPPER=sccache
export CC="sccache cc"
export CXX="sccache c++"
echo "sccache configured for Shelby build cache (endpoint: $SCCACHE_ENDPOINT)"
# Direct execution is a no-op for the caller: the exports above died with
# this child process. Say so instead of letting anyone walk away believing
# their shell is configured.
if ! (return 0) 2>/dev/null; then
  printf 'NOTE: file was executed, not sourced - the exports above did NOT modify your shell. Source it instead: . scripts/setup-sccache-env.sh\n' >&2
fi
