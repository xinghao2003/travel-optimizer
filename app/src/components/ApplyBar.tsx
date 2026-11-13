import { useLayoutEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";

const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * Saving changes (C9): fixed at the bottom of the page while drafts are saving, after a failed save, or while a
 * value needs fixing, in every tab. Drafts otherwise save on their own. It sets
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
  return <div ref={bar} className="p-apply-bar" role="region" aria-label="Saving changes">
    <div className="p-container p-apply-row">
      <div className="p-apply-text">
        <p aria-live="polite">{applying ? "Saving your changes and updating options…" : invalid > 0 ? `Fix ${count(invalid, "value")} to save your changes.` : `${count(total, "change")} not saved: ${parts.join(", ")}`}</p>
        {searchActive && applying && <small>The search pauses to include your changes, then continues within the remaining round allowance.</small>}
        {error && <div className="p-apply-error" role="alert">
          <p>{error.text}</p>
          {error.reload && <Button type="button" size="sm" variant="secondary" onClick={onReload}>Reload trip</Button>}
        </div>}
      </div>
      <div className="p-apply-buttons">
        {invalid > 0 && !applying && <button type="button" className="p-link-button p-apply-fix" onClick={onFocusInvalid}>Fix {count(invalid, "value")}</button>}
        <Button type="button" variant="ghost" size="sm" disabled={!!applying} onClick={onDiscard}>Discard</Button>
        {(applying || error) && <Button type="button" size="sm" disabled={busy || invalid > 0} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={onApply}>
          {applying && <LoaderCircle size={15} className="p-spin" aria-hidden="true" />}{applying ? "Saving…" : "Try again"}
        </Button>}
      </div>
    </div>
  </div>;
}
