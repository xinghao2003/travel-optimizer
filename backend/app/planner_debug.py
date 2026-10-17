"""Opt-in planner timings and stack traces when the API event loop stalls."""
from __future__ import annotations

import asyncio
import faulthandler
import logging
import os
import threading
import time
from contextlib import asynccontextmanager, suppress
from logging.handlers import RotatingFileHandler
from pathlib import Path


@asynccontextmanager
async def planner_debug_monitor():
    if os.environ.get("PLANNER_DEBUG", "").lower() not in {"1", "true", "yes"}:
        yield
        return
    logger = logging.getLogger("uvicorn.error")
    previous_level = logger.level
    logger.setLevel(logging.DEBUG)
    path = Path(__file__).resolve().parents[1] / "data" / "planner-debug.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(message)s"))
    logger.addHandler(handler)
    stack_file = path.with_name("planner-stacks.log").open("a", encoding="utf-8")
    stop = threading.Event()
    heartbeat = [time.monotonic()]

    async def beat():
        while True:
            heartbeat[0] = time.monotonic()
            await asyncio.sleep(1)

    def watch():
        last_dump = 0.0
        while not stop.wait(5):
            now = time.monotonic()
            if now - heartbeat[0] >= 30 and now - last_dump >= 30:
                last_dump = now
                logger.warning("planner event_loop_stalled lag_seconds=%.1f; dumping all thread stacks to %s", now-heartbeat[0], stack_file.name)
                stack_file.write(f"\n{time.strftime('%Y-%m-%d %H:%M:%S')} event loop lag {now-heartbeat[0]:.1f}s\n")
                stack_file.flush()
                faulthandler.dump_traceback(file=stack_file, all_threads=True)

    task = asyncio.create_task(beat())
    thread = threading.Thread(target=watch, name="planner-watchdog", daemon=True)
    thread.start()
    logger.info("planner diagnostics enabled log=%s stall_threshold=30s", path)
    try:
        yield
    finally:
        stop.set()
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await asyncio.to_thread(thread.join)
        stack_file.close()
        logger.removeHandler(handler)
        handler.close()
        logger.setLevel(previous_level)
