#!/usr/bin/env bash
# scripts/setup-sccache-env.sh
# Source this file to configure sccache for Shelby.
#
# POSIX sh compatible: can be sourced from bash, dash, or /bin/sh (e.g.
# `RUN . scripts/setup-sccache-env.sh` in a Dockerfile or an sh-based Make
# recipe), and can also be executed directly.

# Validate credentials BEFORE exporting anything, so a failed source leaves
# the caller's shell untouched. All missing variables are reported at once.
# The helper variable is underscore-prefixed to resist collisions with the
# caller's own variables and is unset before returning, so nothing leaks.
_sccache_missing_vars=""
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || _sccache_missing_vars="$_sccache_missing_vars AWS_ACCESS_KEY_ID"
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || _sccache_missing_vars="$_sccache_missing_vars AWS_SECRET_ACCESS_KEY"
if [ -n "$_sccache_missing_vars" ]; then
  printf 'setup-sccache-env.sh: required environment variable(s) not set:%s\n' "$_sccache_missing_vars" >&2
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
