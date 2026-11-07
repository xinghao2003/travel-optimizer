import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { api } = await loadTs("../src/lib/planner.ts");

// api() calls the global fetch. Each test replaces it with a stub that records the requests.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function respond(body, status = 200) {
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(body, { status }); };
  return requests;
}
const unreachable = "Can't reach the planner server. Check that it is running, then try again.";

test("a trip read asks for the compact record, and optimize sends compact: true", async () => {
  const requests = respond(JSON.stringify({ id: "t1" }));
  assert.deepEqual(await api("/trips/t1"), { id: "t1" });
  await api("/trips/t1/optimize", "POST", { expand: true });
  assert.equal(requests[0].url, "/api/v2/trips/t1?compact=true");
  assert.equal(requests[1].url, "/api/v2/trips/t1/optimize");
  assert.deepEqual(JSON.parse(requests[1].init.body), { expand: true, compact: true });
});

test("one Apply request carries every category and expands its nested compact result", async () => {
  const body = { expected_revision: 3, connections: [], transfers: [],
    estimates: [{ component_ids: ["previously-weaker"], low: 1, high: 1, currency: "MYR" }] };
  const requests = respond(JSON.stringify({ trip: { id: "t1", revision: 4, result: {
    routes: [{ id: "new-best", movements: [0], purchases: [0], extra_charges: [] }],
    _shared_route_data: { version: 1, movements: [{ id: "previously-weaker" }], purchases: [{ id: "corrected", low: 1 }], extra_charges: [] },
  } }, job: { id: "j", status: "queued", updating_options: true }, updating: true }), 202);
  const response = await api("/trips/t1/apply", "POST", body);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v2/trips/t1/apply");
  assert.deepEqual(JSON.parse(requests[0].init.body), body);
  assert.deepEqual(response.trip.result.routes[0].movements, [{ id: "previously-weaker" }]);
  assert.deepEqual(response.trip.result.routes[0].purchases, [{ id: "corrected", low: 1 }]);
  assert.equal(response.trip.result._shared_route_data, undefined);
  assert.equal(response.updating, true);
});

test("an error page that is not JSON gives the status, not a SyntaxError", async () => {
  respond("<html><body>502 Bad Gateway</body></html>", 502);
  await assert.rejects(api("/trips/t1", "PUT", {}), { message: "Request failed (502)", status: 502, path: "/trips/t1" });
});

test("the server's detail becomes the message", async () => {
  respond(JSON.stringify({ detail: [{ msg: "a" }, { msg: "b" }] }), 422);
  await assert.rejects(api("/trips", "POST", {}), { message: "a · b", status: 422, path: "/trips" });
  respond(JSON.stringify({ detail: "This trip changed. Reload it before saving." }), 409);
  await assert.rejects(api("/trips/t1", "PUT", {}), { message: "This trip changed. Reload it before saving.", status: 409 });
});

test("a server that can't be reached gives the network message without a status", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const error = await api("/trips").catch(err => err);
  assert.equal(error.message, unreachable);
  assert.equal(error.path, "/trips");
  assert.equal(error.status, undefined);
  // The connection drops while the body arrives.
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("terminated"); } });
  await assert.rejects(api("/trips"), { message: unreachable, path: "/trips" });
});
