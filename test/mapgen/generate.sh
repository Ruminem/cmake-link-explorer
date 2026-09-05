#!/bin/sh
# Regenerates the linker map fixtures in test/maps from real linkers.
#
#   GNU ld  needs arm-none-eabi-binutils  (brew install arm-none-eabi-binutils)
#   ld64    needs Apple's toolchain, so those two are skipped elsewhere
#
# The checked-in maps in test/maps are the output of this script, so the parser
# tests run anywhere without either toolchain installed.

set -e
cd "$(dirname "$0")"
mkdir -p ../maps

if command -v arm-none-eabi-as > /dev/null 2>&1; then
  echo "GNU ld (arm-none-eabi)"
  for f in startup app map_engine geo_utils nds_reader unused; do
    arm-none-eabi-as -mcpu=cortex-m4 -o "$f.o" "$f.s"
  done
  arm-none-eabi-ar rcs libnavicore.a geo_utils.o nds_reader.o unused.o

  # Everything kept: the full picture, including sections nothing references.
  arm-none-eabi-ld -T link.ld -Map=../maps/gnu-ld-full.map -o navicore.elf \
    startup.o app.o map_engine.o libnavicore.a 2> /dev/null || true

  # With --gc-sections: smaller, and the pair makes a real diff to test against.
  arm-none-eabi-ld -T link.ld --gc-sections -Map=../maps/gnu-ld-gc.map -o navicore-gc.elf \
    startup.o app.o map_engine.o libnavicore.a 2> /dev/null || true

  rm -f ./*.o ./*.a ./*.elf
else
  echo "skipping GNU ld maps: arm-none-eabi-as not found"
fi

if command -v c++ > /dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
  echo "Apple ld64"
  c++ -std=c++17 -O0 -o big_O0 big.cpp -Wl,-map,../maps/ld64-O0.map
  c++ -std=c++17 -O2 -o big_O2 big.cpp -Wl,-map,../maps/ld64-O2.map
  rm -f big_O0 big_O2
  rm -rf ./*.dSYM
else
  echo "skipping ld64 maps: not on macOS"
fi

echo "done -> test/maps"
