from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import planner_places
from app.planner_places import catalog_path, nearest_places


class NearestPlacesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # sqlite3 connections stay open until collected, so Windows can refuse to delete the file.
        cls.folder = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        # Airports only, so the test does not depend on the GeoNames download.
        cls.patches = [patch.dict(os.environ, {"PLANNER_PLACES_PATH": str(Path(cls.folder.name) / "places.sqlite3")}),
                       patch.object(planner_places, "ROOT", Path(cls.folder.name))]
        for item in cls.patches:
            item.start()
        catalog_path.cache_clear()

    @classmethod
    def tearDownClass(cls):
        for item in cls.patches:
            item.stop()
        catalog_path.cache_clear()
        cls.folder.cleanup()

    def test_nearest_first_with_distance(self):
        found = nearest_places(3.14, 101.69, 5)  # Central Kuala Lumpur
        self.assertEqual(len(found), 5)
        self.assertEqual(found[0]["country_code"], "MY")
        self.assertIn("KUL", [code for item in found for code in item["airport_codes"]])
        distances = [item["distance_km"] for item in found]
        self.assertEqual(distances, sorted(distances))

    def test_point_near_the_antimeridian(self):
        found = nearest_places(-17.8, 179.9, 3)  # East of Fiji
        self.assertEqual(len(found), 3)
        self.assertTrue(all(item["distance_km"] < 1500 for item in found))

    def test_remote_point_still_returns_places(self):
        found = nearest_places(-48.9, -123.4, 2)  # Point Nemo
        self.assertEqual(len(found), 2)


if __name__ == "__main__":
    unittest.main()
