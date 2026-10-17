import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "../node_modules/typescript/lib/typescript.js";
const source = readFileSync(new URL("../src/lib/missingFares.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {groupMissingFares} = await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
const charge = id => ({id,kind:"Airport access",mode:"taxi",from_id:"city",to_id:"airport:KUL"});
const movement = (id,charges=[]) => ({id,from_id:"city",to_id:"foreign-city",mode:"flight",departure:"2027-02-05T10:00:00Z",charges});
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
test("standalone flight fares remain separate even for matching city pairs",()=>{
 const groups=groupMissingFares([fare("f1",{label:"flight"}),fare("f2",{label:"flight"})],[route("r1",[movement("f1")]),route("r2",[movement("f2")])]);
 assert.equal(groups.length,2);
});
test("duplicate diagnostics and duplicate route references do not inflate counts",()=>{
 const r=route("r1",[movement("f1",[charge("c1")])]);
 const groups=groupMissingFares([fare("c1"),fare("c1")],[r,r]);
 assert.equal(groups[0].components.length,1);assert.equal(groups[0].affected_itineraries,1);
});

