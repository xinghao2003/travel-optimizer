import { useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, CirclePause, CircleX, Info, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import { InfoTip } from "./InfoTip";
import type { SearchState, StripAction } from "../lib/present";

const toneIcons = { busy: LoaderCircle, info: Info, ok: CircleCheck, warn: CircleAlert, error: CircleX };

/** The search status of a saved trip (C3.1): the state row with its action and Details, and the line that checks more combinations. */
export function StatusStrip({ state, details, busyAction, settingsOpen, onStop, onSearch, onCheckMore, onStopChecking }: {
  state: SearchState; details: { lines: string[]; messages: string[] }; busyAction: string | null; settingsOpen: boolean;
  onStop: () => void; onSearch: (continuation: boolean) => void; onCheckMore: () => void;
  onStopChecking: () => void;
}) {
  // Screen readers hear the sentence when the state changes, not on every counter update.
  const [live, setLive] = useState(state);
  if (live.id !== state.id) setLive(state);
  // While trip settings are open, their footer has the search button.
  const actions = state.id === "not-searched" && settingsOpen ? [] : state.actions;
  const hasDetails = details.lines.length > 0 || details.messages.length > 0;
  const showRow = !!state.text || actions.length > 0 || hasDetails;
  const Icon = state.id === "paused" || state.id === "stopped" ? CirclePause : toneIcons[state.tone];
  const run = (action: StripAction) => action.run === "stop-optimization" ? onStopChecking() : action.run === "stop" ? onStop() : action.run === "optimize" ? onCheckMore() : onSearch(action.run === "continue");
  const button = (action: StripAction, variant: "default" | "secondary") => <Button type="button" size="sm" variant={variant} disabled={busyAction !== null || action.disabled} onClick={() => run(action)}>
    {busyAction === action.run && <LoaderCircle size={14} className="p-spin" aria-hidden="true" />}{action.label}
  </Button>;
  return <div className="p-strip">
    <span className="sr-only" aria-live="polite">{live.text}</span>
    {(showRow || state.secondary) && <div className="p-strip-box" data-quiet={!state.text && !actions.length && !state.secondary || undefined}>
      {showRow && <div className="p-strip-row" data-tone={state.tone}>
        {state.text && <><Icon size={16} className={state.tone === "busy" ? "p-strip-icon p-spin" : "p-strip-icon"} aria-hidden="true" /><p className="p-strip-text">{state.text}</p></>}
        {state.tip && <InfoTip topic="search batches">{state.tip}</InfoTip>}
        {state.progress && <><progress value={state.progress.value} max={state.progress.max} aria-label="Search progress" aria-valuetext={state.progress.text} /><InfoTip topic="the search total">{state.progress.tip}</InfoTip></>}
        {actions.map(action => <span className="p-strip-action" key={action.label}>{button(action, action.run === "stop" || action.run === "stop-optimization" ? "secondary" : "default")}{action.tip && <InfoTip topic={action.label}>{action.tip}</InfoTip>}</span>)}
        {hasDetails && <details className="p-strip-details">
          <summary>Details<ChevronDown size={14} className="p-chevron" aria-hidden="true" /></summary>
          <div className="p-strip-details-body">
            {details.lines.map(line => <p key={line}>{line}</p>)}
            {details.messages.length > 0 && <><p className="p-strip-subhead">Messages from data providers ({details.messages.length})</p><ul>{details.messages.map(message => <li key={message}>{message}</li>)}</ul></>}
          </div>
        </details>}
      </div>}
      {state.secondary && <div className="p-strip-row">
        <p className="p-strip-text">{state.secondary.text}</p>
        {button(state.secondary.action, "secondary")}<InfoTip topic="checking more combinations">{state.secondary.tip}</InfoTip>
      </div>}
    </div>}
  </div>;
}
