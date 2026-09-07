#!/bin/sh
# Regenerates the build-log fixtures in test/ninja from a real ninja build.
#
#   needs cmake, ninja, and any C++ compiler
#
# The checked-in logs are the output of this script, so the parser tests run
# anywhere without a toolchain -- the same arrangement as test/mapgen.
#
# Two files, because they exercise different things:
#
#   mingw-full          one clean build. Every target appears once, and
#                       librender_core.dll / .dll.a share a single edge.
#   mingw-incremental   the same log after touching one source and building
#                       again. Two runs in one file, with engine.cpp.obj
#                       appearing twice: 203 ms cold, 90 ms warm.
#
# The second is the first plus four lines, which is exactly what ninja does --
# it appends and never clears. Regenerating changes every number in
# test/time-test.js, so update the assertions from the new output.

set -e
cd "$(dirname "$0")"

BUILD="$(mktemp -d)/build"
mkdir -p "$BUILD"

cmake -G Ninja -DCMAKE_BUILD_TYPE=Debug -S ../sample-project -B "$BUILD" > /dev/null

# A clean build: this is what the log looks like after configure + one build.
ninja -C "$BUILD" > /dev/null
cp "$BUILD/.ninja_log" mingw-full.ninja_log

# Touching a source that several targets depend on gives a second run whose
# edges overlap the first, which is the case the "last line wins" rule exists
# for. Touch rather than edit: the sample project is a fixture too.
touch ../sample-project/libs/engine/engine.cpp
ninja -C "$BUILD" > /dev/null
cp "$BUILD/.ninja_log" mingw-incremental.ninja_log

rm -rf "$(dirname "$BUILD")"

echo "wrote mingw-full.ninja_log and mingw-incremental.ninja_log"
