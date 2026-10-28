import { useTheme } from "./theme-provider";
import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, ScatterChart, CustomChart } from "echarts/charts";
import { GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Route } from "../lib/planner";
import { cityHourCost, money } from "../lib/planner";
import { axisBounds } from "../lib/chartView";

echarts.use([LineChart, ScatterChart, CustomChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

export function ParetoExplorer({ routes, dominated = [], selected, onSelect }: { routes: Route[]; dominated?: Route[]; selected: string | null; onSelect: (id: string) => void }) {
  const { resolved } = useTheme();
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>(null);
  const previousView = useRef("");
  const [logCost, setLogCost] = useState(false);
  const [logHours, setLogHours] = useState(false);
  const [fit, setFit] = useState(true);
  const allRoutes = [...routes, ...dominated];
  const plottable = allRoutes.filter(r => r.cost_high_myr !== null);
  const costs = plottable.flatMap(r => [r.cost_low_myr, r.cost_high_myr!]);
  const hours = plottable.map(r => r.stay_hours);
  const canLogCost = costs.length > 0 && costs.every(v => Number.isFinite(v) && v > 0);
  const canLogHours = hours.length > 0 && hours.every(v => Number.isFinite(v) && v > 0);
  const useLogCost = logCost && canLogCost, useLogHours = logHours && canLogHours;
  const callback = useRef(onSelect);
  callback.current = onSelect;
  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current);
    chart.current = instance;
    instance.on("click", params => {
      const data = params.data as { routeId?: string } | undefined;
      if (data?.routeId) callback.current(data.routeId);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const priced = routes.filter(r => r.total_cost_myr !== null);
    const ranges = routes.filter(r => r.total_cost_myr === null && r.cost_high_myr !== null);
    const signature = JSON.stringify([allRoutes.map(r => [r.id, r.cost_low_myr, r.cost_high_myr, r.stay_hours]), useLogCost, useLogHours, fit, resolved]);
    const changed = signature !== previousView.current;
    previousView.current = signature;
    chart.current?.setOption({
      animationDuration: 200,
      textStyle: { color: token("--muted-foreground") },
      grid: { left: 72, right: 30, top: 28, bottom: 80 },
      xAxis: { type: useLogCost ? "log" : "value", logBase: 10, ...axisBounds(costs, useLogCost, fit), name: `Total party cost · MYR${useLogCost ? " (log)" : ""}`, nameLocation: "middle", nameGap: 35, nameTextStyle: { color: token("--muted-foreground") }, axisLabel: { color: token("--muted-foreground"), showMinLabel: true, showMaxLabel: true, formatter: (v: number) => v.toLocaleString("en-MY", { maximumFractionDigits: 0 }) }, splitLine: { lineStyle: { color: token("--border") } } },
      yAxis: { type: useLogHours ? "log" : "value", logBase: 10, ...axisBounds(hours, useLogHours, fit), name: `City-stay hours${useLogHours ? " (log)" : ""}`, nameTextStyle: { color: token("--muted-foreground") }, axisLabel: { color: token("--muted-foreground"), showMinLabel: true, showMaxLabel: true, formatter: (v: number) => v.toLocaleString("en-MY", { maximumFractionDigits: 1 }) }, splitLine: { lineStyle: { color: token("--border") } } },
      tooltip: { backgroundColor: token("--card"), borderColor: token("--border"), textStyle: { color: token("--foreground") }, trigger: "item", formatter: (p: unknown) => {
        const value = p as { data?: { value?: number[]; routeId?: string } };
        const route = allRoutes.find(r => r.id === value.data?.routeId);
        return route ? `${money(route.cost_low_myr)}${route.cost_high_myr !== route.cost_low_myr ? ` – ${money(route.cost_high_myr)}` : ""}<br/>${route.stay_hours.toFixed(1)} city hours · ${cityHourCost(route)}${route.estimated ? "<br/>Includes estimates" : ""}` : "";
      } },
      dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "slider", xAxisIndex: 0, height: 15, bottom: 10 }],
      series: [
        { type: "scatter", z: 1, data: dominated.filter(r => r.cost_high_myr !== null).map(r => ({ value: [r.total_cost_myr ?? (r.cost_low_myr+r.cost_high_myr!)/2, r.stay_hours], routeId: r.id, symbolSize: r.id === selected ? 16 : 8, itemStyle: { color: r.id === selected ? "#e28b3c" : "#9ba9ae", opacity: r.id === selected ? 1 : .6 } })) },
        { type: "line", silent: true, symbol: "none", lineStyle: { color: token("--chart"), type: "dashed", width: 1.5 }, data: [...priced].sort((a, b) => a.cost_low_myr - b.cost_low_myr).map(r => [r.cost_low_myr, r.stay_hours]) },
        { type: "scatter", data: priced.map(r => ({ value: [r.total_cost_myr, r.stay_hours], routeId: r.id, symbol: r.estimated ? "diamond" : "circle", symbolSize: r.id === selected ? 19 : 12, itemStyle: { color: r.id === selected ? "#e28b3c" : token("--chart"), borderWidth: 2, borderColor: token("--card") } })) },
        { type: "line", silent: true, symbol: "none", lineStyle: { color: "#b58a46", width: 5, opacity: .35 }, data: ranges.flatMap(r => [[r.cost_low_myr, r.stay_hours], [r.cost_high_myr, r.stay_hours], [null, null]]), connectNulls: false },
        { type: "scatter", symbol: "emptyCircle", data: ranges.map(r => ({ value: [(r.cost_low_myr + (r.cost_high_myr as number)) / 2, r.stay_hours], routeId: r.id, symbolSize: r.id === selected ? 18 : 12, itemStyle: { color: "#b58a46" } })) },
      ],
    }, { notMerge: changed, replaceMerge: ["series"] });
  }, [routes, dominated, selected, useLogCost, useLogHours, fit, resolved]);
  return <div>
    <details className="p-chart-scale-details"><summary>Chart settings</summary><div className="p-inline p-chart-controls" role="group" aria-label="Chart scales">
      <label className="p-check"><input type="checkbox" checked={useLogCost} disabled={!canLogCost} onChange={e => setLogCost(e.target.checked)} />Logarithmic cost</label>
      <label className="p-check"><input type="checkbox" checked={useLogHours} disabled={!canLogHours} onChange={e => setLogHours(e.target.checked)} />Logarithmic city hours</label>
      <label className="p-check"><input type="checkbox" checked={fit} onChange={e => setFit(e.target.checked)} />Fit axes to data</label>
      <button type="button" className="p-text-button" onClick={() => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}>Reset zoom</button>
    </div>
    <p className="p-hint">Fitted axes highlight small differences and may not start at zero. Log scales compare proportional changes and require positive values.</p>
    </details>
    {!plottable.length && <p className="p-notice">No complete fare totals or bounded fare ranges to plot. Resolve missing fares to show these alternatives here.</p>}
    <div ref={element} className="pareto-chart" role="img" aria-label={`Pareto frontier with ${plottable.length} plotted alternatives: ${useLogCost ? "logarithmic" : "linear"} cost versus ${useLogHours ? "logarithmic" : "linear"} city-stay hours`} />
  </div>;
}
