# SPDX-License-Identifier: MIT
# Puts python/ on the path so tests run from the repository root.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "python"))
