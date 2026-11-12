import { Select, SelectItem } from "./ui/select";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { CircleAlert, Info } from "lucide-react";
import { Button } from "./ui/button";
import { InfoTip } from "./InfoTip";
import { ModeIcon } from "./ModeIcon";
import { hoursText, moneyShort, optionChips, optionNumber, perCityHourText, priceEstimated, priceText, routeChain, sortRoutes, type EmptyState, type NextStep, type OptionChip, type OptionsTarget } from "../lib/present";
import type { Result, Route } from "../lib/planner";
import { compareRoute, marginalComparisons, type RouteComparison } from "../lib/routeComparison";

const LazyPareto = lazy(() => import("./ParetoExplorer").then(m => ({ default: m.ParetoExplorer })));
function ParetoExplorer(props: ComponentProps<typeof LazyPareto>) {
  return <Suspense fallback={<div className="p-chart-loading" role="status">Loading chart…</div>}><LazyPareto {...props} /></Suspense>;
}

/** Next steps rows visible before "Show {k} more" (F1). */
const visibleSteps = 3;

/**
 * One option in the list (C6): number, price and time in cities; the route; the price per city hour and the chips.
 * `name` is read before the number ("Over-budget option 1"), as in the itinerary heading.
 */
function OptionRow({ route, number, name = "Option", selected, chips, placeName, onSelect, comparison }: {
  route: Route; number: number; name?: string; selected: boolean; chips: OptionChip[]; placeName: (id: string) => string; onSelect: () => void;
  comparison?: { baseline: string; value: RouteComparison; marginal?: { label: string; value: RouteComparison } };
}) {
  const chain = routeChain(route);
  const perHour = perCityHourText(route);
  return <li className="p-option-row">
    <button type="button" id={selected ? "selected-option" : undefined} className="p-option" aria-pressed={selected} onClick={onSelect}>
      <span className="p-option-line">
        <span className="p-option-number"><span className="sr-only">{name} </span>{optionNumber(number)}</span>
        <span className="p-option-price">{priceText(route)}</span>
        <span className="p-option-aside">{hoursText(route.stay_hours)} h in cities</span>
      </span>
      <span className="p-option-line">
        <span className="p-option-chain">{placeName(chain.from)}{chain.steps.map((step, index) => <span className="p-chain-step" key={index}>
          <ModeIcon mode={step.mode} />{placeName(step.to)}{step.hours !== null && <span className="p-chain-hours">{hoursText(step.hours)} h</span>}
        </span>)}</span>
        <span className="p-option-aside">{hoursText(route.travel_hours)} h travel</span>
      </span>
      {(perHour || chips.length > 0 || selected || comparison) && <span className="p-option-line p-option-meta">
        {perHour && <span className="p-option-per-hour">{perHour}</span>}
        {chips.map(chip => <span className="p-chip" data-tone={chip.tone} key={chip.text}>{chip.tone === "warn" && <CircleAlert size={12} aria-hidden="true" />}{chip.text}</span>)}
        {!selected && comparison && <span className="p-option-comparison p-option-comparison-details">
          {comparison.value.summary}{comparison.value.rate && <> · {comparison.value.rate}</>}
        </span>}
      </span>}
    </button>
    {comparison && !selected && <span className="p-option-comparison-tip"><InfoTip topic={`comparison for ${name} ${optionNumber(number)}`} align="end">
      <p><strong>Compared with {comparison.baseline}</strong></p>
      {comparison.value.details.map(line => <p key={line}>{line}</p>)}
      {comparison.marginal && <>
        <p><strong>From the next cheaper option without a price range ({comparison.marginal.label})</strong></p>
        <p>{comparison.marginal.value.summary}{comparison.marginal.value.rate && <> · {comparison.marginal.value.rate}</>}</p>
      </>}
      <p>City time includes nights. Differences use the shown prices and estimates.</p>
    </InfoTip></span>}
  </li>;
}

const pickLabels = { cheapest: "Cheapest", stay: "Most time in cities", balanced: "Best balance" } as const;
/**
 * The recommended picks above the list: the first best option for each ranking. Cheapest and Best balance use only
 * options with a known highest price, so a missing price never makes an option look cheap. One option that wins
 * several rankings shows once with all its labels. None with fewer than 2 best options or no priced option.
 */
function Picks({ routes, priceWeight, numbers, selectedId, placeName, onSelect }: {
  routes: Route[]; priceWeight: number; numbers: Map<string, number>; selectedId: string | null;
  placeName: (id: string) => string; onSelect: (id: string) => void;
}) {
  const priced = routes.filter(route => (route.total_cost_myr ?? route.cost_high_myr) !== null);
  if (routes.length < 2 || !priced.length) return null;
  const picks = new Map<string, { route: Route; labels: string[] }>();
  for (const key of Object.keys(pickLabels) as (keyof typeof pickLabels)[]) {
    const route = sortRoutes(key === "stay" ? routes : priced, key, { priceWeight })[0];
    const pick = picks.get(route.id) ?? { route, labels: [] };
    pick.labels.push(pickLabels[key]); picks.set(route.id, pick);
  }
  return <ul className="p-picks" aria-label="Recommended options">{[...picks.values()].map(({ route, labels }) => {
    const chain = routeChain(route);
    return <li key={route.id}>
      <button type="button" className="p-pick" aria-pressed={route.id === selectedId} onClick={() => onSelect(route.id)}>
        <span className="p-pick-label">{labels.join(" · ")}</span>
        <span className="p-pick-price">{priceText(route)}</span>
        <span className="p-pick-line">{hoursText(route.stay_hours)} h in cities · {hoursText(route.travel_hours)} h travel</span>
        <span className="p-pick-line">{[chain.from, ...chain.steps.map(step => step.to)].map(placeName).join(" → ")}</span>
        <span className="sr-only">Option {optionNumber(numbers.get(route.id) ?? 0)}</span>
      </button>
    </li>;
  })}</ul>;
}

/**
 * The Options column (C6): Next steps, the chart, the list toolbar, the option rows with Show more, the Over budget
 * group and the empty states (C12). Planner owns the order (`displayRoutes`, `numbers`), the selection and the actions.
 */
export function OptionsPanel({ result, displayRoutes, numbers, refinement, selectedId, comparedId, ranking, onRanking, timePreference, onTimePreference, showDominated, onToggleDominated,
  loadingWeaker, busy, visibleCount, onShowMore, onSelect, nextSteps, emptyState, onAction, budget, adults, rates, placeName }: {
  result: Result | null; displayRoutes: Route[]; numbers: Map<string, number>; refinement: Route[];
  selectedId: string | null; comparedId: string | null;
  ranking: string; onRanking: (ranking: string) => void;
  timePreference: number; onTimePreference: (value: number) => void;
  showDominated: boolean; onToggleDominated: (show: boolean) => void; loadingWeaker: boolean; busy: boolean;
  visibleCount: number; onShowMore: () => void;
  onSelect: (id: string, source: "row" | "chart") => void;
  nextSteps: NextStep[]; emptyState: EmptyState | null; onAction: (target: OptionsTarget) => void;
  budget: number | null; adults: number; rates: Record<string, number>; placeName: (id: string) => string;
}) {
  const sortId = useId(), balanceId = useId();
  const [allSteps, setAllSteps] = useState(false);
  const [view, setView] = useState<"list" | "chart">("list");
  const stepList = useRef<HTMLUListElement>(null);
  const optionList = useRef<HTMLOListElement>(null);
  // After "Show more", focus goes to the first row it added: the button itself can go away.
  const firstNewRow = useRef<number | null>(null);
  useEffect(() => {
    if (firstNewRow.current === null) return;
    optionList.current?.children[firstNewRow.current]?.querySelector("button")?.focus();
    firstNewRow.current = null;
  }, [visibleCount]);

  const weaker = new Set((showDominated ? result?.dominated_routes ?? [] : []).map(route => route.id));
  // Said once above the list instead of a chip on every row (C6).
  const estimatedOnce = displayRoutes.length > 0 && displayRoutes.every(priceEstimated);
  const chips = (route: Route, overBudget: boolean) => optionChips(route, { budget, rates, estimatedOnce: estimatedOnce && !overBudget, weaker: weaker.has(route.id), overBudget, compared: route.id === comparedId && comparedId !== selectedId });
  const best = result?.routes.length ?? 0;
  const left = displayRoutes.length - visibleCount;
  const hiddenSteps = allSteps ? 0 : Math.max(0, nextSteps.length - visibleSteps);
  const baseline = [...displayRoutes, ...refinement].find(route => route.id === selectedId);
  const label = (id: string) => numbers.has(id) ? `Option ${optionNumber(numbers.get(id)!)}` : `Over-budget option ${optionNumber(refinement.findIndex(route => route.id === id) + 1)}`;
  const marginal = marginalComparisons(result?.routes ?? []);
  const comparison = (route: Route) => {
    if (!baseline || route.id === baseline.id) return undefined;
    const step = marginal.get(route.id);
    return { baseline: label(baseline.id), value: compareRoute(route, baseline),
      marginal: step ? { label: label(step.baselineId), value: step.comparison } : undefined };
  };

  // Best options and, when shown, weaker options. Over-budget options are not plotted (E5).
  const chart = result && <ParetoExplorer routes={result.routes} weaker={showDominated ? result.dominated_routes : undefined} numbers={numbers}
    selectedId={selectedId} comparedId={comparedId} budget={budget} adults={adults} rates={rates} onSelect={id => onSelect(id, "chart")} />;
  const actionButton = (action: { label: string; target: OptionsTarget }) => <Button type="button" size="sm" variant="secondary" onClick={() => onAction(action.target)}>{action.label}</Button>;

  return <>
    {nextSteps.length > 0 && <section className="p-next" aria-labelledby="next-steps-title">
      <h2 id="next-steps-title">Next steps</h2>
      <ul ref={stepList} className="p-next-list">
        {nextSteps.slice(0, nextSteps.length - hiddenSteps).map(step => <li key={step.id} data-tone={step.tone} tabIndex={-1}>
          {step.tone === "warn" ? <CircleAlert size={16} className="p-next-icon" aria-hidden="true" /> : <Info size={16} className="p-next-icon" aria-hidden="true" />}
          <p>{step.text}</p>
          {step.action && actionButton(step.action)}
        </li>)}
      </ul>
      {hiddenSteps > 0 && <button type="button" className="p-text-button p-more-button" onClick={() => {
        setAllSteps(true);
        // The button goes away: focus the first row it shows.
        requestAnimationFrame(() => (stepList.current?.children[visibleSteps] as HTMLElement | undefined)?.focus());
      }}>Show {hiddenSteps} more</button>}
    </section>}

    <div className="p-options-heading">
      <h2 id="options-title" tabIndex={-1}>Options</h2>
      <InfoTip topic="options">Each option is a complete trip from home and back, or one way to or from home. An option is shown when no other option found is both cheaper and gives more time in your cities. Best means best among the transport found and your settings, not every ticket on sale.</InfoTip>
    </div>

    {displayRoutes.length > 0 && <>
      <Picks routes={result?.routes ?? []} priceWeight={1 - timePreference / 100} numbers={numbers} selectedId={selectedId} placeName={placeName} onSelect={id => onSelect(id, "row")} />

      <div className="p-options-toolbar">
        <p className="p-options-count">{best} best option{best === 1 ? "" : "s"}{weaker.size > 0 && ` · ${weaker.size} more`}</p>
        <div className="p-view-toggle" role="group" aria-label="View">
          {(["list", "chart"] as const).map(item => <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item === "list" ? "List" : "Chart"}</button>)}
        </div>
        <div className="p-options-sort">
          <label htmlFor={sortId}>Sort</label>
          <Select id={sortId} value={ranking} onValueChange={value => onRanking(value)}>
            <SelectItem value="cheapest">Lowest price</SelectItem>
            <SelectItem value="stay">Most time in cities</SelectItem>
            <SelectItem value="balanced">Best balance</SelectItem>
          </Select>
          <InfoTip topic="sorting" align="end">Lowest price uses the highest possible price. Best balance uses weighted distance to the cheapest price and most city time, scaled using priced best options. Options without an upper price come last. Showing more options and changing chart axes do not change that scale. Sorting does not change which options are best.</InfoTip>
        </div>
        <div className="p-check-row">
          <label className="p-check"><input type="checkbox" checked={showDominated} disabled={busy} onChange={event => onToggleDominated(event.target.checked)} />Show more options</label>
          <InfoTip topic="more options" align="end">Other complete itineraries from this search. Each one has a best option that costs the same or less, even at its highest price, and gives at least as much time in cities. Loading them recalculates saved data; no new search. Some were removed earlier in the search.</InfoTip>
        </div>
        <span className="p-hint" role="status">{loadingWeaker && "Loading more options…"}</span>
        {ranking === "balanced" && <div className="p-balance-preference">
          <label htmlFor={balanceId}>Balance preference <span>{100 - timePreference}% price · {timePreference}% city time</span></label>
          <div><span>Lower price</span><input id={balanceId} type="range" min={0} max={100} step={5} value={timePreference}
            aria-valuetext={`${100 - timePreference}% price, ${timePreference}% city time`}
            onChange={event => onTimePreference(Number(event.target.value))} /><span>More city time</span></div>
        </div>}
      </div>
      {view === "chart" && chart}
      {estimatedOnce && <p className="p-hint p-options-note">All options include estimated prices.</p>}
      {baseline && <p className="p-hint p-options-note">Differences compare with selected {label(baseline.id)}.</p>}

      {view === "list" && <>
      <ol ref={optionList} className="p-options">
        {displayRoutes.slice(0, visibleCount).map(route => <OptionRow key={route.id} route={route} number={numbers.get(route.id) ?? 0} selected={route.id === selectedId}
          chips={chips(route, false)} comparison={comparison(route)} placeName={placeName} onSelect={() => onSelect(route.id, "row")} />)}
      </ol>
      {left > 0 && <button type="button" className="p-show-more" onClick={() => { firstNewRow.current = visibleCount; onShowMore(); }}>
        {left > 40 ? `Show 40 more (${left} left)` : `Show ${left} more`}
      </button>}
      </>}
    </>}

    {emptyState && <div className="p-options-empty" data-state={emptyState.id}>
      {emptyState.title && <h3>{emptyState.title}</h3>}
      {emptyState.lines.length === 1 && !emptyState.title
        ? <div className="p-options-empty-line"><p>{emptyState.lines[0].text}</p>{emptyState.lines[0].action && actionButton(emptyState.lines[0].action)}</div>
        : <ul>{emptyState.lines.map(line => <li key={line.text} className="p-options-empty-line"><p>{line.text}</p>{line.action && actionButton(line.action)}</li>)}</ul>}
    </div>}

    {refinement.length > 0 && <div className="p-over-budget">
      <details>
        <summary id="over-budget-summary">Over budget ({refinement.length}) · from {moneyShort(Math.min(...refinement.map(route => route.cost_low_myr)))}</summary>
        <ol className="p-options">
          {refinement.map((route, index) => <OptionRow key={route.id} route={route} number={index + 1} name="Over-budget option" selected={route.id === selectedId}
            chips={chips(route, true)} comparison={comparison(route)} placeName={placeName} onSelect={() => onSelect(route.id, "row")} />)}
        </ol>
      </details>
      <InfoTip topic="over-budget options" align="end">These cost more than your budget even at their lowest price. Up to 10 are shown. A combined ticket price can make one cheaper.</InfoTip>
    </div>}
  </>;
}
