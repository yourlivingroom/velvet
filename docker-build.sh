#!/bin/sh
# Build the velvet image, tagged with the package.json version and `latest`.
#   ./docker-build.sh                      -> velvet:<version>, velvet:latest
#   IMAGE=ghcr.io/me/velvet ./docker-build.sh
set -eu
cd "$(dirname "$0")"

IMAGE="${IMAGE:-velvet}"
VERSION="$(node -p 'require("./package.json").version')"

docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" "$@" .
