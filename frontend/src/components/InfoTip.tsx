import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { useDismiss } from "../lib/useDismiss";

/**
 * A secondary explanation behind an info button (C11). It opens on click, tap, Enter or Space and closes on Esc
 * (focus goes back to the button), on a click outside it and when focus leaves it. Never put it inside a <label>
 * or <summary>, and never make it the only place of a warning, a value or an instruction.
 * `align="end"` opens the bubble to the left, for tips near the right edge.
 */
export function InfoTip({ topic, children, align }: { topic: string; children: ReactNode; align?: "end" }) {
  const tip = useDismiss();
  return <details className="p-tip" data-align={align} {...tip}>
    <summary aria-label={`About ${topic}`}><Info size={14} aria-hidden="true" /></summary>
    <div className="p-tip-body" role="note">{children}</div>
  </details>;
}
