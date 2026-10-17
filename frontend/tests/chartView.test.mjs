import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "../node_modules/typescript/lib/typescript.js";
async function load(path) {
 const source=readFileSync(new URL(path,import.meta.url),"utf8");
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
}
const {axisBounds}=await load("../src/lib/chartView.ts");
const {cityHourCost}=await load("../src/lib/planner.ts");
test("fitted axes enclose the observed frontier without starting at zero",()=>{
 const values=[2848,3727,3757,4205,4581,5029];
 const b=axisBounds(values,false,true);
 assert.ok(b.min>0&&b.min<Math.min(...values));assert.ok(b.max>Math.max(...values));
 assert.deepEqual(axisBounds(values,false,false),{min:0,max:undefined});
});
test("log bounds enclose close positive values and handle a single/tied point",()=>{
 for(const values of [[153.3,177.0],[150],[150,150],[0.001,0.002]]) {
  const b=axisBounds(values,true,true);
  assert.ok(Number.isFinite(b.min)&&b.min>0&&b.min<Math.min(...values));
  assert.ok(Number.isFinite(b.max)&&b.max>Math.max(...values));
 }
 assert.throws(()=>axisBounds([0,100],true,true));
 assert.throws(()=>axisBounds([-1,100],true,true));
 assert.ok(axisBounds([],true,true).min>0);
});
test("city-hour cost supports exact fares, ranges, unknown fares and zero stay",()=>{
 assert.match(cityHourCost({stay_hours:153.3326,cost_per_stay_hour_myr:18.57}),/18\.57.*city h/);
 const range=cityHourCost({stay_hours:10,cost_per_stay_hour_myr:null,cost_low_myr:100,cost_high_myr:200});
 assert.match(range,/10\.00/);assert.match(range,/20\.00/);
 assert.match(cityHourCost({stay_hours:10,cost_per_stay_hour_myr:null,cost_high_myr:null}),/unknown/);
 assert.match(cityHourCost({stay_hours:0}),/unavailable/);
});
