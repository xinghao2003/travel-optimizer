"""Copy only provider sources and locked dependencies for isolated runtime checks."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ["api/flights.py", "api/transit.py", "backend/app/__init__.py", "backend/app/planner_providers.py",
         "backend/app/flight_search.py", "backend/app/places.py", "backend/app/provider_functions.py", "backend/app/provider_http.py", "pyproject.toml", "uv.lock"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data/diagnostics/provider-package")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / "data/diagnostics"):
        raise ValueError("Place validation packages under ignored data/diagnostics.")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a new or empty validation directory.")
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for name in FILES:
        source = ROOT / name; target = output / name
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
        records.append({"path": name, "bytes": source.stat().st_size, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    (output / "provider-manifest.json").write_text(json.dumps({"schema_version": 1, "files": records}, indent=2), encoding="utf-8")
    print(json.dumps({"package": str(output), "source_files": len(records), "source_bytes": sum(r["bytes"] for r in records)}))


if __name__ == "__main__": main()
