#!/usr/bin/env bash
# Start hosting-service in local dev mode
cd "$(dirname "$0")"
export NODE_ENV=development
exec node server.js "$@"
