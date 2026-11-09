import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { api, installPlannerTransport, plannerConfig } = await loadTs("../src/lib/planner.ts");

test("api() needs the installed browser service", async () => {
  await assert.rejects(api("/trips"), { message: "The planner service is not installed.", path: "/trips" });
  await assert.rejects(plannerConfig(), { message: "The planner service is not installed." });
});

test("api() forwards requests to the browser service and tags rejections with their path", async () => {
  const requests = [];
  installPlannerTransport(async (path, method, body) => {
    requests.push({ path, method, body });
    if (path === "/trips/t1") throw Object.assign(new Error("This trip changed. Reload it before saving."), { status: 409 });
    return { ok: true };
  }, async () => ({ transit_routing_configured: true }));
  assert.deepEqual(await api("/trips", "POST", { name: "A" }), { ok: true });
  assert.deepEqual(requests, [{ path: "/trips", method: "POST", body: { name: "A" } }]);
  await assert.rejects(api("/trips/t1", "PUT", {}), { message: "This trip changed. Reload it before saving.", status: 409, path: "/trips/t1" });
  assert.deepEqual(await plannerConfig(), { transit_routing_configured: true });
});
