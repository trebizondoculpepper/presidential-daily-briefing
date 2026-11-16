#!/bin/sh
# Thin POSIX launcher; the build definition remains in package.json.
set -eu
cd -- "$(dirname -- "$0")"
npm run build
exec npm install -g .
