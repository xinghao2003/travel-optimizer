from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx
from app.planner_discovery import DiscoveryManager
from app.planner_models import Charge, FareOffer
from app.planner_optimizer import price_path
from app.planner_store import PlannerStore
from test_planner import trip, movement, fare, dt, HOME, A

class SharedFareTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_fare_saves_per_component_once_and_survives_restart(self):
        import app.planner_api as endpoints
        from app.main import app
        with tempfile.TemporaryDirectory() as folder:
            db=PlannerStore(Path(folder)/"planner.sqlite3")
            spec=trip()
            record=db.new_trip(spec.model_dump(mode="json"));id=record["id"]
            path=[movement("out",HOME,A,dt(10),dt(10,10)),movement("back",A,HOME,dt(12,17),dt(12,18))]
            for i,m in enumerate(path): m.charges=[Charge(id=f"c{i}",kind="Airport access",from_id=HOME.id,to_id="airport:KUL")]
            record["snapshot"]={"revision":1,"movements":[m.model_dump(mode="json") for m in path],"offers":[],"coverage":{}}
            db.put("trips",id,record)
            manager=DiscoveryManager(db);manager.recalculate=AsyncMock(return_value={"routes":[]})
            payload={"component_ids":["c0","c1"],"low":20,"high":20,"currency":"myr","label":"Shared transfer estimate","expected_revision":1}
            with patch.object(endpoints,"store",db),patch.object(endpoints,"manager",manager):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                    response=await client.post(f"/api/v2/trips/{id}/fares/batch",json=payload)
                    self.assertEqual(response.status_code,200,response.text)
                    self.assertEqual(manager.recalculate.await_count,1)
                    saved=PlannerStore(db.path).get("trips",id)
                    self.assertEqual(saved["revision"],2)
                    self.assertEqual(len(saved["offers"]),2)
                    self.assertTrue(all(len(o["movement_ids"])==1 and o["kind"]=="charge" for o in saved["offers"]))
                    offers=[fare("out",10),fare("back",10),*[FareOffer.model_validate(o) for o in saved["offers"]]]
                    self.assertEqual(price_path(path,offers,spec,[])["total_cost_myr"],60)
                    response=await client.post(f"/api/v2/trips/{id}/fares/batch",json=payload)
                    self.assertEqual(response.status_code,409)
                    for invalid in ({"component_ids":["c0","unknown"]},{"component_ids":["c0","c0"]},{"high":19}):
                        response=await client.post(f"/api/v2/trips/{id}/fares/batch",json={**payload,"expected_revision":2,**invalid})
                        self.assertEqual(response.status_code,422,response.text)
                    self.assertEqual(db.get("trips",id)["revision"],2)
                    self.assertEqual(manager.recalculate.await_count,1)
                    response=await client.post(f"/api/v2/trips/{id}/fares/batch",json={**payload,"expected_revision":2,"low":0,"high":15})
                    self.assertEqual(response.status_code,200,response.text)
                    saved=db.get("trips",id)
                    self.assertEqual(len(saved["offers"]),2)
                    offers=[fare("out",10),fare("back",10),*[FareOffer.model_validate(o) for o in saved["offers"]]]
                    price=price_path(path,offers,spec,[])
                    self.assertEqual(price["cost_low_myr"],20)
                    self.assertEqual(price["cost_high_myr"],50)
                    response=await client.post(f"/api/v2/trips/{id}/fares/estimates",json={"expected_revision":3,"estimates":[
                        {"component_ids":["c0"],"low":4,"high":4},
                        {"component_ids":["c1"],"low":5,"high":8}]})
                    self.assertEqual(response.status_code,200,response.text)
                    self.assertEqual(manager.recalculate.await_count,3)
                    saved=PlannerStore(db.path).get("trips",id)
                    self.assertEqual(saved["revision"],4)
                    self.assertEqual(len(saved["offers"]),2)
                    offers=[fare("out",10),fare("back",10),*[FareOffer.model_validate(o) for o in saved["offers"]]]
                    price=price_path(path,offers,spec,[])
                    self.assertEqual(price["cost_low_myr"],29)
                    self.assertEqual(price["cost_high_myr"],32)
                    for invalid in ([{"component_ids":["c0"],"low":1},{"component_ids":["c0"],"low":2}],
                                    [{"component_ids":["c0"],"low":1},{"component_ids":["missing"],"low":2}]):
                        response=await client.post(f"/api/v2/trips/{id}/fares/estimates",json={"expected_revision":4,"estimates":invalid})
                        self.assertEqual(response.status_code,422,response.text)
                    self.assertEqual(db.get("trips",id)["revision"],4)
                    self.assertEqual(manager.recalculate.await_count,3)
