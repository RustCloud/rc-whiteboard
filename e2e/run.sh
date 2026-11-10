#!/bin/sh
# End-to-end check of the plugin, the service and a real cloud, in Docker:
#   e2e/run.sh <plugin zip>
# The cloud (ghcr.io/rustcloud/server:latest) and the service image
# (rc-whiteboard-service:dev, `docker build -t rc-whiteboard-service:dev .`)
# run in compose; Chromium runs in a node:22-alpine container on their network.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
zip=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$here"
mkdir -p out
docker compose down -v >/dev/null 2>&1 || true
docker compose up -d --quiet-pull 2>&1 | grep -v -E "Running|Starting|Started|Created|Creating" || true
sleep 3
trap 'docker compose logs cloud > out/cloud.log 2>&1; docker compose down -v >/dev/null 2>&1' EXIT
docker run --rm --network rc-whiteboard-e2e_default \
  -v "$here":/e2e -v "$zip":/plugin.zip:ro -w /e2e node:22-alpine sh -c '
    apk add --no-cache -q chromium font-noto >/dev/null &&
    npm install --no-audit --no-fund --silent >/dev/null &&
    node board.mjs http://cloud:8080'
