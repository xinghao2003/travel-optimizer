import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const {groupMissingFares} = await loadTs("../src/lib/missingFares.ts");
const charge = id => ({id,kind:"Airport access",mode:"taxi",from_id:"city",to_id:"airport:KUL"});
const movement = (id,charges=[]) => ({id,from_id:"city",to_id:"foreign-city",mode:"flight",departure:"2027-02-05T10:00:00Z",segments:[],charges});
const route = (id,movements) => ({id,movements,extra_charges:[]});
const fare = (id,extra={}) => ({component_id:id,movement_id:"flight",label:"Airport access",from_id:"city",to_id:"foreign-city",currency:"MYR",reason:"missing_fare",affected_itineraries:2,break_even_myr:null,...extra});
test("groups actual transfer endpoints and counts distinct routes, not component sums",()=>{
 const groups=groupMissingFares([fare("c1"),fare("c2")],[route("r1",[movement("f1",[charge("c1"),charge("c2")])]),route("r2",[movement("f2",[charge("c1")])])]);
 assert.equal(groups.length,1);assert.equal(groups[0].to_id,"airport:KUL");assert.equal(groups[0].affected_itineraries,2);assert.equal(groups[0].components.length,2);
});
test("does not combine different currencies, modes, or directions",()=>{
 const charges=[charge("c1"),{...charge("c2"),mode:"rail"},{...charge("c3"),from_id:"airport:KUL",to_id:"city"},charge("c4")];
 assert.equal(groupMissingFares([fare("c1"),fare("c2"),fare("c3"),fare("c4",{currency:"USD"})],[route("r1",[movement("f",charges)])]).length,4);
});
test("repeated flights on one city pair share a row with individual components",()=>{
 const groups=groupMissingFares([fare("f1",{label:"flight"}),fare("f2",{label:"flight"})],[route("r1",[movement("f1")]),route("r2",[movement("f2")])]);
 assert.equal(groups.length,1);assert.equal(groups[0].components.length,2);assert.equal(groups[0].affected_itineraries,2);
});
test("duplicate diagnostics and duplicate route references do not inflate counts",()=>{
 const r=route("r1",[movement("f1",[charge("c1")])]);
 const groups=groupMissingFares([fare("c1"),fare("c1")],[r,r]);
 assert.equal(groups[0].components.length,1);assert.equal(groups[0].affected_itineraries,1);
});


test("repeated journeys share one estimate across departures and count distinct alternatives", () => {
 // README: same endpoints, fare type, mode, currency, and reason share one row.
 const rail = id => ({...movement(id), mode:"rail", template_id:"assumed:rail"});
 const groups = groupMissingFares([fare("a",{label:"rail"}),fare("b",{label:"rail"}),fare("c",{label:"rail"})], [
  route("r1",[rail("a"),rail("b")]), route("r2",[rail("b")]),
  route("r3",[{...rail("c"),template_id:"assumed:other"}])
 ]);
 assert.equal(groups.length,1);
 assert.equal(groups[0].affected_itineraries,3);
 assert.deepEqual(groups[0].components.map(c => c.component_id),["a","b","c"]);
});
