import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { Route } from "../lib/planner";
import { hoursText, optionNumber, priceText } from "../lib/present";

const pageSize = 40;

/** Keep every comparison accessible without mounting an item for every route. */
export function ComparisonPicker({ id, routes, numbers, value, onChange }: {
  id: string; routes: Route[]; numbers: Map<string, number>; value: string; onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const searchId = useId();
  const label = (route: Route) => `Option ${optionNumber(numbers.get(route.id) ?? 0)} · ${priceText(route)} · ${hoursText(route.stay_hours)} h`;
  const selected = routes.find(route => route.id === value);
  const choices = useMemo(() => {
    if (!open) return [];
    const text = query.trim().toLowerCase();
    return text ? routes.filter(route => label(route).toLowerCase().includes(text)) : routes;
    // Labels depend on the route data and its current displayed number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, routes, numbers]);
  const start = Math.min(page * pageSize, Math.max(0, Math.ceil(choices.length / pageSize) - 1) * pageSize);
  const choose = (id: string | null) => { onChange(id); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setPage(0); } }}>
    <Popover.Trigger asChild><button id={id} type="button" className="p-select-trigger">
      <span>{selected ? label(selected) : "None"}</span><ChevronDown size={15} aria-hidden="true" />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="p-control-popup p-comparison-picker" sideOffset={5} collisionPadding={12} align="start" aria-label="Choose comparison option">
      <label htmlFor={searchId}>Find an option</label>
      <input id={searchId} type="search" placeholder="Option number, price or hours" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <button type="button" className="p-menu-item" onClick={() => choose(null)}>None</button>
      <div className="p-comparison-choices">{choices.slice(start, start + pageSize).map(route => <button type="button" className="p-menu-item" key={route.id}
        aria-pressed={route.id === value} onClick={() => choose(route.id)}>{label(route)}</button>)}</div>
      <div className="p-comparison-pages">
        <button type="button" disabled={!start} onClick={() => setPage(start / pageSize - 1)}>Previous</button>
        <span role="status">{choices.length ? `${start + 1}–${Math.min(start + pageSize, choices.length)} of ${choices.length}` : "No matching options"}</span>
        <button type="button" disabled={start + pageSize >= choices.length} onClick={() => setPage(start / pageSize + 1)}>Next</button>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
