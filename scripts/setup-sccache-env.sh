#!/usr/bin/env bash
# scripts/setup-sccache-env.sh
# Source this file to configure sccache for Shelby
export SCCACHE_BUCKET="${SCCACHE_BUCKET:-shelby}"
export SCCACHE_ENDPOINT="${SCCACHE_ENDPOINT:-http://localhost:9000}"
export SCCACHE_REGION="shelbyland"
export SCCACHE_S3_USE_SSL=false
export SCCACHE_S3_NO_CREDENTIALS=false
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set before sourcing setup-sccache-env.sh}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set before sourcing setup-sccache-env.sh}"
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export RUSTC_WRAPPER=sccache
export CC="sccache cc"
export CXX="sccache c++"
echo "sccache configured for Shelby build cache (endpoint: $SCCACHE_ENDPOINT)"
