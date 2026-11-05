#!/bin/sh
# Syntax-check every generated C file with a real cross compiler.
#
#   sh tools/ctest/compile_check.sh [cc] [dist_dir]
#
# `cc` defaults to the RISC-V ESP toolchain that ships with the Arduino ESP32 core.
# The LVGL fonts are compiled twice, once against LVGL 8's structures and once
# against LVGL 9's, since the generated file claims to support both.

set -e
HERE=$(cd "$(dirname "$0")" && pwd)
CC=${1:-"$LOCALAPPDATA/Arduino15/packages/m5stack/tools/riscv32-esp-elf-gcc/esp-2021r2-patch5-8.4.0/bin/riscv32-esp-elf-gcc.exe"}
DIST=${2:-"$HERE/../../dist"}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL=0

echo "compiler: $("$CC" -dumpversion 2>&1)"

echo "-- u8g2"
"$CC" -fsyntax-only -std=c99 -Wall -Wextra -I"$DIST/u8g2" "$DIST/u8g2/deflect_stencil_u8g2.c" || FAIL=1

echo "-- embedded TTFs"
"$CC" -fsyntax-only -std=c99 -Wall -Wextra -I"$DIST/ttf_c" "$DIST/ttf_c/deflect_stencil_ttf.c" || FAIL=1

echo "-- Adafruit_GFX headers"
for f in "$DIST"/gfx/*.h; do
  name=$(basename "$f" .h)
  printf '#include "%s.h"\nconst GFXfont *p = &%s;\n' "$name" "$name" > "$TMP/g.c"
  "$CC" -fsyntax-only -std=c99 -Wall -Wextra -I"$HERE" -I"$DIST/gfx" "$TMP/g.c" || FAIL=1
done

echo "-- LVGL fonts (v8 and v9)"
for f in "$DIST"/lvgl/*.c; do
  for major in 8 9; do
    "$CC" -fsyntax-only -std=c99 -Wall -Wextra -Wno-missing-field-initializers \
      -DLV_LVGL_H_INCLUDE_SIMPLE -DLVGL_MAJOR=$major -I"$HERE" "$f" || FAIL=1
  done
done

if [ "$FAIL" = 0 ]; then echo "ALL GENERATED C COMPILES"; else echo "COMPILE PROBLEMS"; fi
exit $FAIL
