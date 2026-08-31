#!/usr/bin/env bash
# scripts/setup-sccache-env.sh
# Source this file to configure sccache for Shelby

# Validate credentials BEFORE exporting anything, so a failed source leaves
# the caller's shell untouched. All missing variables are reported at once.
missing=()
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || missing+=(AWS_ACCESS_KEY_ID)
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || missing+=(AWS_SECRET_ACCESS_KEY)
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'setup-sccache-env.sh: required environment variable(s) not set: %s\n' "${missing[*]}" >&2
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    exit 1
  else
    return 1
  fi
fi

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
