"""Replay a saved trip without provider calls or writes to the planner database."""
from __future__ import annotations

import argparse
import asyncio
import copy
import cProfile
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import platform
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import planner_discovery as discovery
from app.planner_results import expand_trip


def peak_memory_bytes():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD),
                        *[(name, ctypes.c_size_t) for name in
                          ("peak_working_set", "working_set", "peak_paged", "paged", "peak_nonpaged",
                           "nonpaged", "pagefile", "peak_pagefile")]]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        api = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        api.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        api.restype = wintypes.BOOL
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not api(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return counters.peak_working_set

    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--trip-id", help="Defaults to the most recently saved trip.")
    parser.add_argument("--optimizer-source", type=Path, default=ROOT / "backend/app/planner_optimizer.py")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--label-limit", type=int)
    parser.add_argument("--include-dominated", action="store_true")
    parser.add_argument("--profile", type=Path, help="Save cProfile data; profiling affects timings.")
    parser.add_argument("--output", type=Path, help="Save JSON results in addition to stdout.")
    options = parser.parse_args()
    if options.repeat < 1 or (options.label_limit is not None and options.label_limit < 1):
        parser.error("repeat and label-limit must be positive")
    if options.profile and options.repeat != 1:
        parser.error("use one repeat when profiling")
    logging.getLogger("uvicorn.error").setLevel(logging.ERROR)

    # Read trip settings, graph, fares, and rules from one consistent transaction.
    db = sqlite3.connect(options.database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("BEGIN")
        if options.trip_id:
            row = db.execute("SELECT payload FROM records WHERE collection='trips' AND id=?", (options.trip_id,)).fetchone()
        else:
            row = db.execute("SELECT payload FROM records WHERE collection='trips' ORDER BY updated DESC LIMIT 1").fetchone()
        if row is None:
            parser.error("saved trip not found")
        trip = expand_trip(json.loads(row[0]))
        rules = [json.loads(row[0]) for row in db.execute("SELECT payload FROM records WHERE collection='rules' ORDER BY updated DESC")]
    finally:
        db.close()
    if not trip.get("snapshot"):
        parser.error("the trip has no saved movement graph")

    class Inputs:
        def get(self, collection, id):
            assert collection == "trips" and id == trip["id"]
            return copy.deepcopy(trip)

        def list(self, collection):
            assert collection == "rules"
            return copy.deepcopy(rules)

        def load_optimizer_checkpoint(self, trip_id, version):
            return None

        def put(self, *args):
            raise AssertionError("benchmark attempted to persist a trip")

    class Captured(Exception):
        pass

    captured = {}

    def capture(*args, **kwargs):
        captured.update(args=list(args), kwargs=kwargs)
        raise Captured()

    original = discovery.optimize
    discovery.optimize = capture
    try:
        asyncio.run(discovery.DiscoveryManager(Inputs()).recalculate(trip["id"]))
    except Captured:
        pass
    finally:
        discovery.optimize = original
    # This tool compares fresh solves, including older optimizer sources.
    captured["kwargs"].pop("checkpoint", None)
    if options.label_limit is not None:
        captured["args"][7] = options.label_limit
    captured["kwargs"]["include_dominated"] = options.include_dominated

    source = options.optimizer_source.resolve()
    module_spec = importlib.util.spec_from_file_location("app.benchmark_variant", source)
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[module_spec.name] = module
    module_spec.loader.exec_module(module)
    output = {"trip_id": trip["id"], "python": sys.version, "platform": platform.platform(),
              "hash_seed": os.environ.get("PYTHONHASHSEED", "random"),
              "source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "label_limit": captured["args"][7], "profiled": bool(options.profile), "runs": []}
    for _ in range(options.repeat):
        profiler = cProfile.Profile() if options.profile else None
        start, cpu = time.perf_counter(), time.process_time()
        result = (profiler.runcall(module.optimize, *captured["args"], **captured["kwargs"]) if profiler
                  else module.optimize(*captured["args"], **captured["kwargs"]))
        row = {"wall_seconds": time.perf_counter()-start, "cpu_seconds": time.process_time()-cpu,
               "peak_process_bytes": peak_memory_bytes(), "expanded_labels": result["expanded_labels"],
               "pruned_labels": result["pruned_labels"], "feasible_count": result["feasible_count"],
               "optimization_complete": result["optimization_complete"], "routes": len(result["routes"])}
        row["result_sha256"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        solution = {key: value for key, value in result.items()
                    if key not in {"expanded_labels", "pruned_labels", "remaining_labels", "label_limit"}}
        row["solution_sha256"] = hashlib.sha256(json.dumps(solution, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        output["runs"].append(row)
        if profiler:
            profiler.dump_stats(str(options.profile))
    encoded = json.dumps(output, indent=2)
    if options.output:
        options.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
