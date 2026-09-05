#!/bin/sh
# Regenerates everything the test suites need that is not checked in.
#
#   test/fixture/               synthetic CMake File API reply  (needs python3)
#   test/sample-project/build/  a real CMake build tree         (needs cmake)
#   test/maps/                  linker map fixtures             (checked in;
#                               regenerate with test/mapgen/generate.sh)

set -e
cd "$(dirname "$0")/.."

echo "synthetic File API fixture"
python3 test/make-fixture.py

if command -v cmake > /dev/null 2>&1; then
  echo "real CMake build tree"
  BUILD=test/sample-project/build
  mkdir -p "$BUILD/.cmake/api/v1/query/client-cmake-link-explorer"
  touch "$BUILD/.cmake/api/v1/query/client-cmake-link-explorer/codemodel-v2"
  cmake -S test/sample-project -B "$BUILD" > /dev/null
  echo "  -> $BUILD"
else
  echo "skipping the real build tree: cmake not found"
fi

echo ""
echo "now run:"
echo "  node test/run.js"
echo "  node test/run.js \$PWD/test/sample-project/build"
echo "  node test/tree-test.js"
echo "  node test/map-test.js"
