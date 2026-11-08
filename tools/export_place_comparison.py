"""Capture public place-search results from the unchanged Python reference."""
import argparse
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app import planner_places


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path)
    args = parser.parse_args()
    source = args.database.resolve(strict=True) if args.database else planner_places.catalog_path()
    searches = ["ku", "KUL", "Kuala Lumpur", " New York ", "London", "York", "São", "Sao", "İs", "Mün", "MUN", "Straße", "straẞe", "ß", "ﬀ", "Å", "a_", "a%", "a\\", "  ", "東京", "Zürich", "Singapore", "Paris"]
    searches = [s for s in searches if len(s) >= 2]
    cases = []
    with patch.object(planner_places, "catalog_path", return_value=source):
        for query in searches:
            for limit in (1, 16, 30):
                cases.append({"operation": "search", "query": query, "limit": limit, "expected": planner_places.search_places(query, limit)})
        for latitude, longitude in ((3.139, 101.687), (51.507, -.128), (0, 179.99), (0, -179.99), (89.9, 180), (-89.9, -180), (0, 0), (-33.9, 151.2), (35.68, 139.69)):
            for limit in (1, 5, 10):
                cases.append({"operation": "nearest", "latitude": latitude, "longitude": longitude, "limit": limit, "expected": planner_places.nearest_places(latitude, longitude, limit)})
    output = ROOT / "frontend/tests/fixtures/native-places.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"cases": cases}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Captured {len(cases)} public place-search comparisons.")


if __name__ == "__main__":
    main()
