import { useLayoutEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";

const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * Changes not applied (C9): fixed at the bottom of the page while the trip has drafts, in every tab. It sets
 * --apply-h on the root to its height, so the page, the side panel and the settings footer keep clear of it.
 * With invalid drafts, Apply is off and "Fix {k} values" goes to the first one.
 */
export function ApplyBar({ counts, invalid, applying, error, busy, searchActive, onApply, onDiscard, onReload, onFocusInvalid }: {
  counts: { airportChanges: number; transfers: number; prices: number; rates: number; deletions: number }; invalid: number; applying: boolean;
  error: { text: string; reload: boolean } | null; busy: boolean;
  searchActive: boolean;
  onApply: () => void; onDiscard: () => void; onReload: () => void; onFocusInvalid: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement, element = bar.current!;
    const update = () => root.style.setProperty("--apply-h", `${element.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty("--apply-h"); };
  }, []);
  const total = counts.airportChanges + counts.transfers + counts.prices + counts.rates + counts.deletions;
  const parts = [count(counts.airportChanges, "airport change"), count(counts.transfers, "airport transfer"), count(counts.prices, "price"), count(counts.rates, "exchange rate"), count(counts.deletions, "deletion")].filter(part => !part.startsWith("0 "));
  return <div ref={bar} className="p-apply-bar" role="region" aria-label="Changes not applied">
    <div className="p-container p-apply-row">
      <div className="p-apply-text">
        <p aria-live="polite">{applying ? "Applying changes…" : `${count(total, "change")} not applied: ${parts.join(", ")}`}</p>
        {searchActive && !applying && <small>The search pauses to apply your changes, then continues within the remaining round allowance.</small>}
        {error && <div className="p-apply-error" role="alert">
          <p>{error.text}</p>
          {error.reload && <Button type="button" size="sm" variant="secondary" onClick={onReload}>Reload trip</Button>}
        </div>}
      </div>
      <div className="p-apply-buttons">
        {invalid > 0 && !applying && <button type="button" className="p-link-button p-apply-fix" onClick={onFocusInvalid}>Fix {count(invalid, "value")}</button>}
        <Button type="button" variant="ghost" size="sm" disabled={!!applying} onClick={onDiscard}>Discard</Button>
        <Button type="button" size="sm" disabled={busy || invalid > 0} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={onApply}>
          {applying && <LoaderCircle size={15} className="p-spin" aria-hidden="true" />}{applying ? "Applying…" : searchActive ? "Apply and continue" : "Apply"}
        </Button>
        <kbd className="p-apply-hint" aria-hidden="true">Ctrl+Enter</kbd>
      </div>
    </div>
  </div>;
}
