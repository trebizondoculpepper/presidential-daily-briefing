#!/bin/sh
# Thin POSIX launcher; the build definition remains in package.json.
set -eu
cd -- "$(dirname -- "$0")"
exec npm run build
