import { expect, test } from "@playwright/test";

test("the profile follows the traveller's values and airport transfer ways are shared by all trips", async ({ page }) => {
  await page.route("**/shared-data", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/shared-data");
  const result = await page.evaluate(async () => {
    const { BrowserPlannerApi } = await import("/src/native/api.ts"), { PlannerRepository } = await import("/src/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json(), spec = corpus.cases[5].trip.spec;
    type Trip = { id: string; revision: number; spec: typeof spec; airport_transfer_rows: { from_id: string; to_id: string }[]; airport_transfer_estimates?: { from_id: string; to_id: string; low: number }[] };
    const repository = new PlannerRepository("wayfinder-shared-" + crypto.randomUUID()), api = new BrowserPlannerApi(repository, async () => corpus.catalog);
    const read = (id: string) => api.request(`/trips/${id}`) as Promise<Trip>;
    const profile = async () => (await api.request("/profile") as { profile: { home: { id: string }; adults: number } | null }).profile;
    const before = await profile();
    const first = await api.request("/trips", "POST", spec) as Trip;
    const created = await profile();
    // A new name is not a change to the profile; another number of adults is.
    await api.request(`/trips/${first.id}`, "PUT", { spec: { ...spec, name: "Renamed", adults: 3 }, expected_revision: 1 });
    const changed = await profile();
    await api.request(`/trips/${first.id}`, "PUT", { spec: { ...spec, name: "Renamed again" }, expected_revision: 2 });
    const back = await profile();
    await repository.put("meta", "profile", { ...back, adults: 9 });
    await api.request(`/trips/${first.id}`, "PUT", { spec: { ...spec, name: "Third name" }, expected_revision: 3 });
    const kept = await profile();

    // A way saved in one trip is in effect in the other trip, which gets a new revision.
    const second = await api.request(`/trips/${first.id}/duplicate`, "POST") as Trip;
    const opened = await read(first.id), row = opened.airport_transfer_rows[0];
    const way = { mode: "taxi", duration_minutes: null, from_id: row.from_id, to_id: row.to_id, adults: spec.adults, low: 42, high: 42, currency: "MYR" };
    await api.request(`/trips/${first.id}/apply`, "POST", { expected_revision: opened.revision, transfers: [way] });
    const shared = await repository.sharedTransfers();
    const stored = await repository.requireTrip(first.id), other = await repository.requireTrip(second.id);
    const shown = await Promise.all([read(first.id), read(second.id)]);
    // The other trip saves the ways it shows, unchanged: nothing is shared again and it keeps no own way.
    await api.request(`/trips/${second.id}/apply`, "POST", { expected_revision: other.revision, transfers: shown[1].airport_transfer_estimates, exchange_rates: { USD: 4.5 } });
    const unchanged = await repository.requireTrip(second.id);
    await repository.close();

    // Data from before: the newest trip gives the profile, and the trips' own ways become the shared ways.
    const old = new PlannerRepository("wayfinder-shared-" + crypto.randomUUID());
    const record = (id: string, adults: number, own: unknown[]) => ({ id, revision: 1, spec: { ...spec, adults }, snapshot: null, latest_job_id: null, offers: [], airport_connections: [], ...(own.length ? { airport_transfer_estimates: own } : {}) });
    await old.put("trips", "older", record("older", 2, [{ ...way, adults: 2, low: 30, high: 30 }, { ...way, low: 10, high: 10 }]));
    await old.put("trips", "plain", record("plain", 2, []));
    await old.put("trips", "newest", record("newest", 4, [{ ...way, low: 11, high: 11 }]));
    await old.migrateSharedData();
    const seeded = await old.sharedTransfers(), seededProfile = await old.profile();
    const revisions = await Promise.all(["older", "plain", "newest"].map(async id => (await old.requireTrip(id)).revision));
    // A second run changes nothing.
    await old.migrateSharedData();
    const again = await old.sharedTransfers();
    await old.close();
    return {
      profiles: [before, created?.home.id === spec.home.id, created?.adults, changed?.adults, back?.adults, kept?.adults],
      shared: shared.map(item => [item.from_id === row.from_id, item.low]), own: stored.airport_transfer_estimates, otherRevision: other.revision,
      shown: shown.map(trip => trip.airport_transfer_estimates?.map(item => item.low)),
      unchanged: [unchanged.airport_transfer_estimates ?? [], unchanged.revision, (await new PlannerRepository(repository.name).sharedTransfers()).length],
      seeded: seeded.map(item => [item.adults, item.low]).sort(), seededAdults: seededProfile?.adults, revisions, again: again.length,
    };
  });
  expect(result).toEqual({
    profiles: [null, true, 1, 3, 1, 9],
    shared: [[true, 42]], own: [], otherRevision: 2, shown: [[42], [42]],
    unchanged: [[], 3, 1],
    // The newest trip's way for 1 adult wins over the older trip's; the older trip's way for 2 adults has no other source.
    seeded: [[1, 11], [2, 30]], seededAdults: 4,
    // Only the trip without an own way for its party size gets a shared way, and a new revision.
    revisions: [1, 2, 1], again: 2,
  });
});
