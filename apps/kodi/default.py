from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "resources", "lib"))

from archivist.plugin import run


if __name__ == "__main__":
    run(sys.argv)
