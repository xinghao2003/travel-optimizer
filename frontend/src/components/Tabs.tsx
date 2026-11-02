import { useRef, type KeyboardEvent, type ReactNode } from "react";

/** One tab. `badge` is visible only; `badgeText` completes the accessible name ("Options" + ", 9 best options"). */
export type TabItem<T extends string> = { id: T; label: string; badge?: ReactNode; badgeText?: string };

/**
 * WAI-ARIA tabs with automatic activation (C5, C11). Only the selected tab is in the tab sequence;
 * Left and Right move to the previous and next tab, Home and End to the first and last.
 * Tab "x" has the id "tab-x" and controls the element "panel-x".
 */
export function Tabs<T extends string>({ id, className, label, tabs, selected, onSelect }: {
  id?: string; className?: string; label: string; tabs: TabItem<T>[]; selected: T; onSelect: (id: T) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = tabs.length - 1, index = tabs.findIndex(tab => tab.id === selected);
    const next = event.key === "ArrowLeft" ? (index > 0 ? index - 1 : last)
      : event.key === "ArrowRight" ? (index < last ? index + 1 : 0)
      : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  }
  return <div id={id} ref={list} className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
    {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={`tab-${tab.id}`} className="p-tab" aria-selected={tab.id === selected}
      aria-controls={`panel-${tab.id}`} tabIndex={tab.id === selected ? 0 : -1} onClick={() => onSelect(tab.id)}>
      {tab.label}
      {tab.badge !== undefined && <span className="p-tab-badge" aria-hidden="true">{tab.badge}</span>}
      {tab.badgeText && <span className="sr-only">, {tab.badgeText}</span>}
    </button>)}
  </div>;
}
