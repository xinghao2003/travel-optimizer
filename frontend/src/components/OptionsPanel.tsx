import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { CircleAlert, Info } from "lucide-react";
import { Button } from "./ui/button";
import { InfoTip } from "./InfoTip";
import { ModeIcon } from "./ModeIcon";
import { hoursText, moneyShort, optionChips, optionNumber, perCityHourText, priceEstimated, priceText, routeChain, type EmptyState, type NextStep, type OptionChip, type OptionsTarget } from "../lib/present";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { Result, Route } from "../lib/planner";

const LazyPareto = lazy(() => import("./ParetoExplorer").then(m => ({ default: m.ParetoExplorer })));
function ParetoExplorer(props: ComponentProps<typeof LazyPareto>) {
  return <Suspense fallback={<div className="p-chart-loading" role="status">Loading chart…</div>}><LazyPareto {...props} /></Suspense>;
}

/** Next steps rows visible before "Show {k} more" (F1). */
const visibleSteps = 3;

/** One option in the list (C6): number, price and time in cities; the route; the price per city hour and the chips. */
function OptionRow({ route, number, selected, chips, placeName, onSelect }: {
  route: Route; number: number; selected: boolean; chips: OptionChip[]; placeName: (id: string) => string; onSelect: () => void;
}) {
  const chain = routeChain(route);
  const perHour = perCityHourText(route);
  return <li>
    <button type="button" id={selected ? "selected-option" : undefined} className="p-option" aria-pressed={selected} onClick={onSelect}>
      <span className="p-option-line">
        <span className="p-option-number"><span className="sr-only">Option </span>{optionNumber(number)}</span>
        <span className="p-option-price">{priceText(route)}</span>
        <span className="p-option-aside">{hoursText(route.stay_hours)} h in cities</span>
      </span>
      <span className="p-option-line">
        <span className="p-option-chain">{placeName(chain.from)}{chain.steps.map((step, index) => <span className="p-chain-step" key={index}>
          <ModeIcon mode={step.mode} />{placeName(step.to)}{step.hours !== null && <span className="p-chain-hours">{hoursText(step.hours)} h</span>}
        </span>)}</span>
        <span className="p-option-aside">{hoursText(route.travel_hours)} h travel</span>
      </span>
      {(perHour || chips.length > 0) && <span className="p-option-line p-option-meta">
        {perHour && <span className="p-option-per-hour">{perHour}</span>}
        {chips.map(chip => <span className="p-chip" data-tone={chip.tone} key={chip.text}>{chip.tone === "warn" && <CircleAlert size={12} aria-hidden="true" />}{chip.text}</span>)}
      </span>}
    </button>
  </li>;
}

/**
 * The Options column (C6): Next steps, the chart, the list toolbar, the option rows with Show more, the Over budget
 * group and the empty states (C12). Planner owns the order (`displayRoutes`, `numbers`), the selection and the actions.
 */
export function OptionsPanel({ result, displayRoutes, numbers, refinement, selectedId, comparedId, ranking, onRanking, showDominated, onToggleDominated,
  loadingWeaker, busy, visibleCount, onShowMore, onSelect, nextSteps, emptyState, onAction, budget, adults, rates, placeName }: {
  result: Result | null; displayRoutes: Route[]; numbers: Map<string, number>; refinement: Route[];
  selectedId: string | null; comparedId: string | null;
  ranking: string; onRanking: (ranking: string) => void;
  showDominated: boolean; onToggleDominated: (show: boolean) => void; loadingWeaker: boolean; busy: boolean;
  visibleCount: number; onShowMore: () => void;
  onSelect: (id: string, source: "row" | "chart") => void;
  nextSteps: NextStep[]; emptyState: EmptyState | null; onAction: (target: OptionsTarget) => void;
  budget: number | null; adults: number; rates: Record<string, number>; placeName: (id: string) => string;
}) {
  const sortId = useId();
  const narrow = useMediaQuery("(max-width: 599.98px)");
  const [allSteps, setAllSteps] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
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
  const chips = (route: Route, overBudget: boolean) => optionChips(route, { budget, rates, estimatedOnce: estimatedOnce && !overBudget, weaker: weaker.has(route.id), overBudget, compared: route.id === comparedId });
  const best = result?.routes.length ?? 0;
  const left = displayRoutes.length - visibleCount;
  const hiddenSteps = allSteps ? 0 : Math.max(0, nextSteps.length - visibleSteps);

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
      <InfoTip topic="options">Each option is a complete trip from home and back. An option is shown when no other option found is both cheaper and gives more time in your cities. Best means best among the transport found and your settings, not every ticket on sale.</InfoTip>
    </div>

    {displayRoutes.length > 0 && <>
      {narrow ? <details className="p-chart-toggle" onToggle={event => setChartOpen(event.currentTarget.open)}>
        <summary>Show chart</summary>
        {chartOpen && chart}
      </details> : chart}

      <div className="p-options-toolbar">
        <p className="p-options-count">{best} best option{best === 1 ? "" : "s"}{weaker.size > 0 && ` · ${weaker.size} weaker`}</p>
        <div className="p-options-sort">
          <label htmlFor={sortId}>Sort</label>
          <select id={sortId} value={ranking} onChange={event => onRanking(event.target.value)}>
            <option value="cheapest">Lowest price</option>
            <option value="stay">Most time in cities</option>
            <option value="balanced">Best balance</option>
          </select>
          <InfoTip topic="sorting" align="end">Lowest price ranks options by their highest possible price. Options without a complete price come last, by their known part. Sorting does not change which options are best.</InfoTip>
        </div>
        <div className="p-check-row">
          <label className="p-check"><input type="checkbox" checked={showDominated} disabled={busy} onChange={event => onToggleDominated(event.target.checked)} />Show weaker options</label>
          <InfoTip topic="weaker options" align="end">Other complete itineraries from this search. Another option costs the same or less, even at its highest price, and gives at least as much time in cities. Loading them recalculates saved data; no new search. Some were removed earlier in the search.</InfoTip>
        </div>
        <span className="p-hint" role="status">{loadingWeaker && "Loading weaker options…"}</span>
      </div>
      {estimatedOnce && <p className="p-hint p-options-note">All options include estimated prices.</p>}

      <ol ref={optionList} className="p-options">
        {displayRoutes.slice(0, visibleCount).map(route => <OptionRow key={route.id} route={route} number={numbers.get(route.id) ?? 0} selected={route.id === selectedId}
          chips={chips(route, false)} placeName={placeName} onSelect={() => onSelect(route.id, "row")} />)}
      </ol>
      {left > 0 && <button type="button" className="p-show-more" onClick={() => { firstNewRow.current = visibleCount; onShowMore(); }}>
        {left > 40 ? `Show 40 more (${left} left)` : `Show ${left} more`}
      </button>}
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
          {refinement.map((route, index) => <OptionRow key={route.id} route={route} number={index + 1} selected={route.id === selectedId}
            chips={chips(route, true)} placeName={placeName} onSelect={() => onSelect(route.id, "row")} />)}
        </ol>
      </details>
      <InfoTip topic="over-budget options" align="end">These cost more than your budget even at their lowest price. Up to 10 are shown. A combined ticket price can make one cheaper.</InfoTip>
    </div>}
  </>;
}
