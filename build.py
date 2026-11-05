"""Build and check everything, then redraw the proof sheets.

    python build.py

Runs, in order: the vector fonts, the bitmap fonts in all four formats, the TTF C
arrays, both verification passes, and the proof sheets. The generated C is also
syntax-checked if a cross compiler is on hand -- see tools/ctest/compile_check.sh.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(HERE, "tools")

STEPS = [
    ("vector fonts (OTF + TTF)", "build_vector.py"),
    ("bitmap fonts (BDF, GFX, u8g2, LVGL)", "build_bitmap.py"),
    ("TTF as C arrays", "embed_ttf.py"),
    ("verify the vector fonts", "verify_vector.py"),
    ("verify the bitmap fonts", "verify_bitmap.py"),
    ("proof sheets", "proof.py"),
]


def main():
    for label, script in STEPS:
        print("\n=== %s ===" % label, flush=True)
        r = subprocess.run([sys.executable, os.path.join(TOOLS, script)], cwd=HERE)
        if r.returncode:
            print("\n%s failed." % label)
            return r.returncode
    print("\nAll built and verified. Output is in dist/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
