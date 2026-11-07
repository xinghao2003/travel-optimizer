"""Publish the shared Python sources and airport metadata as static assets."""
import json
from pathlib import Path
import shutil

import airportsdata

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/public/browser-python"
MODULES = ["__init__", "planner_models", "planner_positioning", "planner_optimizer", "planner_windows", "planner_journeys", "browser_runtime"]


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in MODULES:
        shutil.copyfile(ROOT / "backend/app" / f"{name}.py", OUTPUT / f"{name}.py")
    airports = airportsdata.load("IATA")
    (OUTPUT / "airports.json").write_text(json.dumps({code: {key: row[key] for key in ("lat", "lon", "tz")} for code, row in airports.items()}, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(MODULES)} Python modules and {len(airports)} airport coordinates in {OUTPUT}")


if __name__ == "__main__":
    main()
