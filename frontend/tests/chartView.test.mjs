import assert from "node:assert/strict";
import {test} from "node:test";
import {loadTs} from "./loadTs.mjs";
const {axisBounds}=await loadTs("../src/lib/chartView.ts");
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

// Price vs. time chart (E2). Fixtures follow the demo trips, cut down to what each rule reads.
const {priceKind,chartPoints,tooltipLines,priceAxisValues,priceRange,tailEnd,chartSeries,legendItems,chartLabel}=await loadTs("../src/lib/chartView.ts");
// Intl writes a no-break space between a currency and its amount.
const plain=text=>text.replace(/ /g," ");
const fare=(id,low,high=low,extra={})=>({id:`fare:${id}`,movement_ids:[id],kind:"one-way",low,high,currency:"MYR",source:"provider",estimated:false,label:"Google Flights",validated:true,...extra});
const option=(id,extra={})=>({id,departure_gateway:"KUL",arrival_gateway:"KUL",movements:[],stays:[],stay_hours:220,travel_hours:30,total_cost_myr:null,cost_low_myr:0,cost_high_myr:null,cost_per_stay_hour_myr:null,purchases:[],extra_charges:[],...extra});
const exact=(id,total,stay_hours,extra={})=>option(id,{total_cost_myr:total,cost_low_myr:total,cost_high_myr:total,stay_hours,cost_per_stay_hour_myr:total/stay_hours,purchases:[fare("f",total)],...extra});
const range=(id,low,high,stay_hours,extra={})=>option(id,{cost_low_myr:low,cost_high_myr:high,stay_hours,purchases:[fare("f",low,high)],...extra});
const partial=(id,low,stay_hours,unpriced=1,extra={})=>option(id,{cost_low_myr:low,stay_hours,purchases:[fare("f",low),...Array.from({length:unpriced},(_,i)=>fare(`u${i}`,null,null,{source:"unknown"}))],...extra});
const numbered=routes=>new Map(routes.map((r,i)=>[r.id,i+1]));
// The demo trip: 9 lower bounds on 5 distinct points.
const demo=[partial("a",2480,218.25,10),partial("b",3460,218.25,9),partial("c",3460,218.25,9),partial("d",5400,221.1333,6,{travel_hours:29.6833}),
 partial("e",5630,220.2167,8),partial("f",5630,220.2167,8),partial("g",5630,220.2167,8),partial("h",5710,220.2167,8),partial("i",5710,220.2167,8)];

test("price kinds follow the E1 states",()=>{
 assert.equal(priceKind(exact("x",5395,218.25)),"exact");
 assert.equal(priceKind(range("x",6187,6227,221.1)),"range");
 assert.equal(priceKind(partial("x",2480,218.25)),"lower");
});
test("stacks join options of one class at one rounded position, first option in list order",()=>{
 const points=chartPoints(demo,[],numbered(demo),{});
 assert.equal(points.length,5);
 assert.deepEqual(points.map(p=>p.routeIds.length),[1,2,1,3,2]);
 const stack=points.find(p=>p.x===5630);
 assert.equal(stack.routeId,"e");assert.equal(stack.kind,"lower");assert.equal(stack.hollow,true);
 // List order decides the routeId, not the input order.
 const reversed=new Map([["e",3],["f",2],["g",1]]);
 assert.deepEqual(chartPoints(demo.slice(4,7),[],reversed,{})[0].routeIds,["g","f","e"]);
 assert.equal(chartPoints(demo.slice(4,7),[],reversed,{})[0].routeId,"g");
 // Hours key at 0.1 h: 220.21 and 220.24 share a mark, 220.26 does not.
 assert.equal(chartPoints([partial("p",100,220.21),partial("q",100,220.24),partial("r",100,220.26)],[],new Map(),{}).length,2);
 // Classes do not mix: exact and estimated, best and weaker; ranges also key on the high.
 const mixed=chartPoints([exact("p",100,10),exact("q",100,10,{purchases:[fare("f",100,100,{source:"rule"})]}),range("r",90,110,10),range("s",90,120,10)],[exact("w",100,10)],new Map(),{});
 assert.deepEqual(mixed.map(p=>[p.kind,p.symbol,p.weaker,p.x]),[["exact","circle",false,100],["exact","diamond",false,100],["range","circle",false,100],["range","circle",false,105],["exact","circle",true,100]]);
});
test("tooltip lines per option and per stack",()=>{
 const numbers=new Map([["d",4],["e",5],["f",6],["g",7]]);
 assert.deepEqual(tooltipLines([demo[3]],numbers,{}).map(plain),["Option 04","From RM 5,400 (at least)","221.1 h in cities · 29.7 h travel","6 not priced"]);
 assert.deepEqual(tooltipLines(demo.slice(4,7),numbers,{}).map(plain),["Options 05, 06, 07","From RM 5,630 (at least)","220.2 h in cities · 30.0 h travel","8 not priced"]);
 // A line that differs inside a stack is left out.
 const mixed=[partial("e",5630,220.2167,8),partial("f",5630,220.2167,7,{travel_hours:28})];
 assert.deepEqual(tooltipLines(mixed,numbers,{}).map(plain),["Options 05, 06","From RM 5,630 (at least)","220.2 h in cities"]);
 const priced=exact("p",5395,218.25,{purchases:[fare("f",5395,5395,{source:"user",estimated:true})]});
 assert.deepEqual(tooltipLines([priced],new Map([["p",1]]),{}).map(plain),["Option 01","RM 5,395","218.3 h in cities · 30.0 h travel","RM 24.72 per city hour","Includes estimates"]);
 assert.deepEqual(tooltipLines([range("q",6187,6227,221.1333)],new Map([["q",2]]),{}).map(plain).slice(0,2),["Option 02","RM 6,187 – 6,227"]);
});
test("axis values include lows, range highs, exact totals and a near budget",()=>{
 const points=chartPoints([exact("p",5395,218.25),range("q",6187,6227,221.1),partial("r",2480,218.25)],[],new Map(),{});
 assert.deepEqual(priceAxisValues(points,null),{values:[5395,5395,6187,6227,2480],budgetShown:false});
 // The budget counts when it is at most 1.25 × the largest other value (6227 × 1.25 = 7783.75).
 assert.deepEqual(priceAxisValues(points,7783),{values:[5395,5395,6187,6227,2480,7783],budgetShown:true});
 assert.equal(priceAxisValues(points,12000).budgetShown,false);
 assert.equal(priceAxisValues([],5000).budgetShown,false);
});
test("the arrow of a lower bound is 6 % of the axis span and stops at the axis end",()=>{
 const values=[2480,5710];
 const fitted=priceRange(values,false,true);
 assert.ok(Math.abs(tailEnd(2480,fitted,false)-(2480+.06*(fitted[1]-fitted[0])))<1e-9);
 assert.deepEqual(priceRange(values,false,false),[0,5710*1.08]);
 assert.ok(Math.abs(tailEnd(2480,[0,5710*1.08],false)-(2480+.06*5710*1.08))<1e-9);
 const log=priceRange(values,true,true);
 assert.ok(Math.abs(tailEnd(2480,log,true)-2480*(log[1]/log[0])**.06)<1e-6);
 assert.equal(tailEnd(5700,[0,5710],false),5710);
});
test("series data for each price state",()=>{
 const best=[exact("p",5000,220),exact("q",4000,210,{purchases:[fare("f",4000,4000,{source:"rule"})]}),range("r",6187,6227,221),partial("s",2480,218.25),partial("t",2480,218.25)];
 const weaker=[exact("w",5500,200),range("v",5000,5600,190),partial("u",3000,205)];
 const points=chartPoints(best,weaker,numbered([...best,...weaker]),{});
 const s=chartSeries(points,low=>low+100);
 assert.deepEqual(s.frontier,[[4000,210],[5000,220]]);
 assert.deepEqual(s.exact.map(p=>[p.routeId,p.symbol]),[["p","circle"],["q","diamond"]]);
 assert.deepEqual(s.rangeBand,[[6187,221],[6227,221],[null,null]]);
 assert.deepEqual(s.rangeMid.map(p=>[p.x,p.y,p.hollow]),[[6207,221,true]]);
 assert.deepEqual(s.lowerTail,[[2480,218.25],[2580,218.25],[null,null]]);
 assert.deepEqual(s.lowerHead.map(h=>[h.value,h.point.routeIds]),[[[2580,218.25],["s","t"]]]);
 assert.deepEqual(s.lowerPoint.map(p=>[p.x,p.routeId]),[[2480,"s"]]);
 // Weaker options use the same shapes without the arrow.
 assert.deepEqual(s.weaker.map(p=>[p.routeId,p.kind,p.hollow]),[["w","exact",false],["v","range",true],["u","lower",true]]);
 assert.deepEqual(s.weakerBand,[[5000,190],[5600,190],[null,null]]);
});
test("the legend lists only the items present",()=>{
 const points=chartPoints(demo,[],numbered(demo),{});
 assert.deepEqual(legendItems(points,{budgetShown:false,selectedId:"a",comparedId:null}),["lower","selected"]);
 assert.deepEqual(legendItems(points,{budgetShown:true,selectedId:"zz",comparedId:"f"}),["lower","budget","compared"]);
 const priced=chartPoints([exact("p",5395,218.25,{purchases:[fare("f",5395,5395,{source:"rule"})]}),range("q",6187,6227,221.1)],[exact("w",7000,200)],new Map(),{});
 assert.deepEqual(legendItems(priced,{budgetShown:false,selectedId:null,comparedId:null}),["estimated","range","weaker"]);
});
test("the text alternative of the chart",()=>{
 assert.equal(plain(chartLabel(demo)),"Price versus time in cities for 9 options: 0 fully priced, 0 price ranges, 9 not fully priced. Known prices RM 2,480 to RM 5,710. Time in cities 218 to 221 hours. The option list has every option.");
 assert.equal(plain(chartLabel([exact("p",5395,218.25),range("q",6187,6227,221.1333)])),"Price versus time in cities for 2 options: 1 fully priced, 1 price range, 0 not fully priced. Known prices RM 5,395 to RM 6,227. Time in cities 218 to 221 hours. The option list has every option.");
});
