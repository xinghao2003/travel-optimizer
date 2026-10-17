import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart, ScatterChart, CustomChart } from "echarts/charts";
import { GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Route } from "../lib/planner";
import { money } from "../lib/planner";

echarts.use([LineChart, ScatterChart, CustomChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

export function ParetoExplorer({ routes, selected, onSelect }: { routes: Route[]; selected: string | null; onSelect: (id: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>(null);
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
    const priced = routes.filter(r => r.total_cost_myr !== null);
    const ranges = routes.filter(r => r.total_cost_myr === null && r.cost_high_myr !== null);
    chart.current?.setOption({
      animationDuration: 200,
      grid: { left: 72, right: 30, top: 28, bottom: 80 },
      xAxis: { type: "value", name: "Total party cost · MYR", nameLocation: "middle", nameGap: 35, min: 0, axisLabel: { color: "#60767a" }, splitLine: { lineStyle: { color: "#edf1f1" } } },
      yAxis: { type: "value", name: "City-stay hours", nameTextStyle: { color: "#60767a" }, axisLabel: { color: "#60767a" }, splitLine: { lineStyle: { color: "#edf1f1" } } },
      tooltip: { trigger: "item", formatter: (p: unknown) => {
        const value = p as { data?: { value?: number[]; routeId?: string } };
        const route = routes.find(r => r.id === value.data?.routeId);
        return route ? `${money(route.cost_low_myr)}${route.cost_high_myr !== route.cost_low_myr ? ` – ${money(route.cost_high_myr)}` : ""}<br/>${route.stay_hours.toFixed(1)} city hours${route.estimated ? "<br/>Includes estimates" : ""}` : "";
      } },
      dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "slider", xAxisIndex: 0, height: 15, bottom: 10 }],
      series: [
        { type: "line", silent: true, symbol: "none", lineStyle: { color: "#167e78", type: "dashed", width: 1.5 }, data: [...priced].sort((a, b) => a.cost_low_myr - b.cost_low_myr).map(r => [r.cost_low_myr, r.stay_hours]) },
        { type: "scatter", data: priced.map(r => ({ value: [r.total_cost_myr, r.stay_hours], routeId: r.id, symbol: r.estimated ? "diamond" : "circle", symbolSize: r.id === selected ? 19 : 12, itemStyle: { color: r.id === selected ? "#e28b3c" : "#167e78", borderWidth: 2, borderColor: "#fff" } })) },
        { type: "line", silent: true, symbol: "none", lineStyle: { color: "#b58a46", width: 5, opacity: .35 }, data: ranges.flatMap(r => [[r.cost_low_myr, r.stay_hours], [r.cost_high_myr, r.stay_hours], [null, null]]), connectNulls: false },
        { type: "scatter", symbol: "emptyCircle", data: ranges.map(r => ({ value: [(r.cost_low_myr + (r.cost_high_myr as number)) / 2, r.stay_hours], routeId: r.id, symbolSize: r.id === selected ? 18 : 12, itemStyle: { color: "#b58a46" } })) },
      ],
    }, true);
  }, [routes, selected]);
  return <div ref={element} className="pareto-chart" role="img" aria-label={`Pareto frontier with ${routes.filter(r => r.cost_high_myr !== null).length} plotted alternatives: cost in MYR versus city-stay hours`} />;
}
