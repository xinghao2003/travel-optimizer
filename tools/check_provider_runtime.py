"""Check an isolated provider package using its installed target-runtime dependencies."""
import argparse
import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(); root = args.package.resolve(strict=True)
    manifest = json.loads((root / "provider-manifest.json").read_text(encoding="utf-8"))
    for row in manifest["files"]:
        assert hashlib.sha256((root / row["path"]).read_bytes()).hexdigest() == row["sha256"], row["path"]
    sys.path.insert(0, str(root))
    from api.flights import app as flight_app
    from app import flight_provider
    import httpx
    import primp
    assert Path(flight_provider.__file__).resolve().is_relative_to(root)
    assert not list(root.rglob("*.sqlite3"))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b"native-http-ok")
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        with primp.Client(impersonate="chrome_145", impersonate_os="macos", timeout=2) as client:
            assert client.get(f"http://127.0.0.1:{server.server_port}/").text == "native-http-ok"
    finally: server.shutdown(); server.server_close(); thread.join()

    @dataclass
    class Row:
        price: int; flights: list; airlines: list; outbound_selection: tuple | None = None
    def segment(a, b, day, start, end):
        return SimpleNamespace(from_airport=SimpleNamespace(code=a, name=a), to_airport=SimpleNamespace(code=b, name=b),
            departure=SimpleNamespace(date=(2027, 2, day), time=(start, 0)), arrival=SimpleNamespace(date=(2027, 2, day), time=(end, 0)), flight_number="123")
    selection = (("KUL", "2027-02-10", "SIN", "MH", "123"),)
    outward = Row(999, [segment("KUL", "SIN", 10, 9, 10)], ["Fixture"], selection)
    inward = Row(120, [segment("SIN", "KUL", 12, 16, 17)], ["Fixture"])
    @contextmanager
    def session(*_, **__):
        count = 0
        def fetch(query):
            nonlocal count
            query.to_bytes(); count += 1
            return [outward] if count == 1 else [inward]
        yield fetch

    async def requests():
        leg = {"from_id": "kul", "to_id": "sin", "date": "2027-02-10", "from_code": "KUL", "to_code": "SIN", "from_airports": ["KUL"], "to_airports": ["SIN"], "timezone": "Asia/Kuala_Lumpur"}
        back = {**leg, "from_id": "sin", "to_id": "kul", "date": "2027-02-12", "from_code": "SIN", "to_code": "KUL", "from_airports": ["SIN"], "to_airports": ["KUL"]}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=flight_app), base_url="http://runtime") as client:
            assert (await client.get("/api/flights")).json()["stateless"]
            with patch.object(flight_provider, "flight_session", session):
                initial = (await client.post("/api/flights", json={"legs": [leg, back], "kind": "round-trip", "adults": 2})).json()
                assert len(initial["flight_choices"]) == 1 and initial["options"][0]["price"] is None
                result = (await client.post("/api/flights", json={"legs": [leg, back], "kind": "round-trip", "operation": "return", "selection": initial["flight_choices"][0], "adults": 2})).json()
                assert result["options"][0]["price"] == 120 and len(result["options"][0]["journeys"]) == 2
    asyncio.run(requests())
    report = {"platform": platform.system(), "machine": platform.machine(), "libc": platform.libc_ver(), "python": platform.python_version(),
        "packages": {name: importlib.metadata.version(name) for name in ("fast-flights", "primp", "fastapi", "pydantic", "airportsdata")},
        "verified_source_files": len(manifest["files"]), "native_primp_http": True, "round_trip_steps": True}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__": main()
