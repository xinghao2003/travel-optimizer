import { useTheme } from "./theme-provider";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import type { Route } from "../lib/planner";
import { axisBounds, chartLabel, chartPoints, chartSeries, legendItems, priceAxisValues, priceRange, tailEnd, type ChartPoint, type LegendItem } from "../lib/chartView";
import { useDismiss } from "../lib/useDismiss";
import { InfoTip } from "./InfoTip";

echarts.use([LineChart, ScatterChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, LabelLayout, CanvasRenderer]);

const legendText: Record<LegendItem, string> = {
  priced: "Priced (filled circle)",
  estimated: "Includes estimates (diamond)",
  range: "Price range (band; the marker is the middle, not an expected price)",
  lower: "At least this price: some items not priced (hollow circle with arrow)",
  weaker: "More option (grey)",
  budget: "Your budget (dashed line)",
  selected: "Selected",
  compared: "Compared (dashed ring)",
};

/** The legend mark of an item, drawn like the chart mark with the same tokens. */
function Swatch({ item, hollow }: { item: LegendItem; hollow: boolean }) {
  const ring = (color: string, dashed = false) => ({ fill: "var(--card)", stroke: color, strokeWidth: 2, strokeDasharray: dashed ? "2 2" : undefined });
  return <svg className="p-swatch" width="24" height="14" viewBox="0 0 24 14" aria-hidden="true">
    {item === "priced" && <circle cx="12" cy="7" r="5" style={{ fill: "var(--chart)" }} />}
    {item === "estimated" && <path d="M12 1 18 7 12 13 6 7Z" style={{ fill: "var(--chart)" }} />}
    {item === "range" && <><line x1="2" y1="7" x2="22" y2="7" style={{ stroke: "var(--chart-range)", strokeWidth: 6, strokeOpacity: .35 }} /><circle cx="12" cy="7" r="4" style={ring("var(--chart-range)")} /></>}
    {item === "lower" && <><line x1="9" y1="7" x2="17" y2="7" style={{ stroke: "var(--chart-range)", strokeWidth: 1.5, strokeDasharray: "3 2" }} /><path d="M17 3.5 22 7 17 10.5Z" style={{ fill: "var(--chart-range)" }} /><circle cx="5" cy="7" r="4" style={ring("var(--chart-range)")} /></>}
    {item === "weaker" && <circle cx="12" cy="7" r="3.5" style={{ fill: "var(--chart-muted)", opacity: .7 }} />}
    {item === "budget" && <line x1="12" y1="0" x2="12" y2="14" style={{ stroke: "var(--muted-foreground)", strokeWidth: 1.5, strokeDasharray: "3 2" }} />}
    {item === "selected" && (hollow ? <circle cx="12" cy="7" r="5.5" style={ring("var(--chart-selected)")} /> : <circle cx="12" cy="7" r="6" style={{ fill: "var(--chart-selected)" }} />)}
    {item === "compared" && <circle cx="12" cy="7" r="5" style={ring("var(--chart-selected)", true)} />}
  </svg>;
}

/**
 * Price vs. time in cities (E2): every best option (and weaker options when shown) as a mark in its price state, the
 * staircase of fully priced best options, the budget line, "×N" stacks, a legend of the marks present and Chart options.
 * Over-budget options are not plotted. Colours come from the theme tokens and are read again on a theme change.
 */
export function ParetoExplorer({ routes, weaker, numbers, selectedId, comparedId, budget, adults, rates, onSelect }: {
  routes: Route[]; weaker?: Route[]; numbers: Map<string, number>; selectedId: string | null; comparedId: string | null;
  budget: number | null; adults: number; rates: Record<string, number>; onSelect: (id: string) => void;
}) {
  const { resolved } = useTheme();
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>(null);
  const previousView = useRef("");
  const options = useDismiss();
  const reasonId = useId();
  const [logCost, setLogCost] = useState(false);
  const [logHours, setLogHours] = useState(false);
  const [fit, setFit] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const points = useMemo(() => chartPoints(routes, weaker ?? [], numbers, rates), [routes, weaker, numbers, rates]);
  const { values: costs, budgetShown } = useMemo(() => priceAxisValues(points, budget), [points, budget]);
  const hours = useMemo(() => points.map(point => point.y), [points]);
  const canLogCost = costs.length > 0 && costs.every(v => Number.isFinite(v) && v > 0);
  const canLogHours = hours.length > 0 && hours.every(v => Number.isFinite(v) && v > 0);
  const useLogCost = logCost && canLogCost, useLogHours = logHours && canLogHours;
  const shownCompared = comparedId !== selectedId ? comparedId : null;
  const legend = legendItems(points, { budgetShown, selectedId, comparedId: shownCompared });
  const selectedPoint = points.find(point => selectedId !== null && point.routeIds.includes(selectedId));
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
    instance.on("datazoom", () => setZoomed(true));
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    // The theme provider sets the dark class in a layout effect, so the tokens here are the current theme's.
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const color = { chart: token("--chart"), range: token("--chart-range"), muted: token("--chart-muted"), selected: token("--chart-selected"), card: token("--card"), text: token("--muted-foreground"), border: token("--border"), foreground: token("--foreground") };
    // Zoom is kept while only the selection or the comparison changes.
    const signature = JSON.stringify([points.map(p => [p.kind, p.weaker, p.x, p.y, p.low, p.high]), budgetShown && budget, useLogCost, useLogHours, fit, resolved]);
    const changed = signature !== previousView.current;
    previousView.current = signature;
    if (changed) setZoomed(false);
    const range = priceRange(costs, useLogCost, fit);
    const series = chartSeries(points, low => tailEnd(low, range, useLogCost));
    // A card-coloured halo keeps a label readable over a nearby mark or arrow.
    const stack = (point: ChartPoint) => point.routeIds.length > 1 ? { show: true, formatter: `×${point.routeIds.length}`, position: "right", fontSize: 11, color: color.text, textBorderColor: color.card, textBorderWidth: 3 } : undefined;
    // Stack labels of close marks move apart vertically instead of running together ("×3×2"). ECharts lays out the
    // labels of every series with this option together.
    const labelLayout = { moveOverlap: "shiftY" } as const;
    // A mark: selected marks are 1.5 × larger in --chart-selected (hollow marks keep their hollow centre); a compared mark has a dashed ring.
    const mark = (point: ChartPoint, size: number, tone: string, opacity = 1, label = true) => {
      const selected = selectedId !== null && point.routeIds.includes(selectedId);
      const compared = !selected && shownCompared !== null && point.routeIds.includes(shownCompared);
      const edge = selected ? color.selected : tone;
      return {
        value: [point.x, point.y], routeId: point.routeId, lines: point.lines, symbol: point.symbol, symbolSize: selected ? size * 1.5 : size,
        itemStyle: {
          color: point.hollow ? color.card : edge, opacity: selected || compared ? 1 : opacity,
          borderColor: compared ? color.selected : point.hollow ? edge : color.card, borderWidth: point.hollow && point.weaker && !compared ? 1.5 : 2, borderType: compared ? "dashed" : "solid",
        },
        label: label ? stack(point) : undefined,
      };
    };
    const axisLabel = (digits: number) => ({ color: color.text, showMinLabel: true, showMaxLabel: true, formatter: (v: number) => v.toLocaleString("en-MY", { maximumFractionDigits: digits }) });
    const axisLine = { lineStyle: { color: color.border } };
    const line = { type: "line", silent: true, symbol: "none", connectNulls: false } as const;
    chart.current?.setOption({
      animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationDuration: 200,
      textStyle: { color: color.text },
      grid: { left: 72, right: 30, top: 32, bottom: 80 },
      xAxis: { type: useLogCost ? "log" : "value", logBase: 10, ...axisBounds(costs, useLogCost, fit), name: `Total price for ${adults} ${adults === 1 ? "adult" : "adults"} (MYR)${useLogCost ? " (log)" : ""}`, nameLocation: "middle", nameGap: 35, nameTextStyle: { color: color.text }, axisLabel: axisLabel(0), axisLine, axisTick: axisLine, splitLine: { lineStyle: { color: color.border } } },
      yAxis: { type: useLogHours ? "log" : "value", logBase: 10, ...axisBounds(hours, useLogHours, fit), name: `Time in cities (h)${useLogHours ? " (log)" : ""}`, nameTextStyle: { color: color.text, align: "left" }, axisLabel: axisLabel(1), axisLine, axisTick: axisLine, splitLine: { lineStyle: { color: color.border } } },
      tooltip: { trigger: "item", confine: true, backgroundColor: color.card, borderColor: color.border, textStyle: { color: color.foreground },
        formatter: (p: unknown) => ((p as { data?: { lines?: string[] } }).data?.lines ?? []).join("<br/>") },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0, filterMode: "none", height: 15, bottom: 10, showDataShadow: false, borderColor: color.border, textStyle: { color: color.text }, handleStyle: { color: color.card, borderColor: color.text }, moveHandleStyle: { color: color.text } },
      ],
      series: [
        { ...line, id: "weaker-band", z: 1, lineStyle: { color: color.muted, width: 4, opacity: .35 }, data: series.weakerBand },
        { id: "weaker", type: "scatter", z: 2, labelLayout, data: series.weaker.map(point => mark(point, 7, color.muted, .7)) },
        { ...line, id: "frontier", z: 3, step: "end", lineStyle: { color: color.chart, type: "dashed", width: 1.5 }, data: series.frontier,
          markLine: budgetShown ? { silent: true, symbol: "none", lineStyle: { color: color.text, type: "dashed", width: 1.5 }, label: { formatter: "Budget", color: color.text }, data: [{ xAxis: budget }] } : undefined },
        { ...line, id: "range-band", z: 3, lineStyle: { color: color.range, width: 6, opacity: .35 }, data: series.rangeBand },
        { ...line, id: "lower-tail", z: 3, lineStyle: { color: color.range, type: "dashed", width: 1.5 }, data: series.lowerTail },
        { id: "lower-head", type: "scatter", silent: true, z: 4, symbol: "triangle", symbolRotate: -90, symbolSize: 7, itemStyle: { color: color.range }, labelLayout,
          // The "×N" label of a lower bound sits after its arrow.
          data: series.lowerHead.map(({ point, value }) => ({ value, label: stack(point) })) },
        { id: "exact", type: "scatter", z: 5, labelLayout, data: series.exact.map(point => mark(point, 11, color.chart)) },
        { id: "range-mid", type: "scatter", z: 5, labelLayout, data: series.rangeMid.map(point => mark(point, 11, color.range)) },
        { id: "lower-point", type: "scatter", z: 5, data: series.lowerPoint.map(point => mark(point, 11, color.range, 1, false)) },
      ],
    }, { notMerge: changed, replaceMerge: ["series"] });
  }, [points, costs, hours, budget, budgetShown, adults, selectedId, shownCompared, useLogCost, useLogHours, fit, resolved]);

  const check = (key: string, label: string, checked: boolean, set: (value: boolean) => void, enabled = true) => <div className="p-chart-option">
    <label className="p-check"><input type="checkbox" checked={checked} disabled={!enabled} aria-describedby={enabled ? undefined : `${reasonId}-${key}`} onChange={e => set(e.target.checked)} />{label}</label>
    {!enabled && <span id={`${reasonId}-${key}`} className="p-hint p-chart-reason">Needs all values above 0</span>}
  </div>;
  return <div className="p-chart">
    <div className="p-chart-head">
      <h3>Price vs. time in cities</h3>
      <InfoTip topic="the chart">Each mark is an option. Further right costs more; higher gives more time in your cities. The dashed steps join fully priced best options.</InfoTip>
      <div className="p-chart-tools">
        {zoomed && <button type="button" className="p-text-button" onClick={event => {
          chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
          setZoomed(false);
          // The button goes away: focus moves to Chart options next to it.
          event.currentTarget.parentElement?.querySelector<HTMLElement>(".p-chart-options > summary")?.focus();
        }}>Reset zoom</button>}
        <details className="p-chart-options" {...options}>
          <summary>Chart options</summary>
          <div className="p-chart-options-body">
            {check("price", "Log scale for price", useLogCost, setLogCost, canLogCost)}
            {check("hours", "Log scale for time in cities", useLogHours, setLogHours, canLogHours)}
            {check("fit", "Fit axes to data", fit, setFit)}
          </div>
        </details>
        <InfoTip topic="chart options" align="end">Fitted axes show small differences and may not start at 0. Log scales compare proportional changes.</InfoTip>
      </div>
    </div>
    <div ref={element} className="p-chart-canvas" role="img" aria-label={chartLabel([...routes, ...weaker ?? []])} />
    <ul className="p-chart-legend">
      {legend.map(item => <li key={item}><Swatch item={item} hollow={!!selectedPoint?.hollow} />{legendText[item]}</li>)}
    </ul>
  </div>;
}
