import { CircleAlert, X } from "lucide-react";
import { Button } from "./ui/button";
import type { AppError } from "../lib/present";

/** App-level errors under the header (C2), with the action that removes the cause. */
export function ErrorBanner({ error, onDismiss, onReload, onRetrySave, onSearchAgain }: {
  error: AppError | null; onDismiss: () => void; onReload: () => void; onRetrySave: () => void; onSearchAgain: () => void;
}) {
  if (!error) return null;
  const action = error.action === "retry-save" ? { label: "Retry save", run: onRetrySave }
    : error.action === "reload" ? { label: "Reload trip", run: onReload }
    : error.action === "search-again" ? { label: "Search again", run: onSearchAgain } : null;
  return <div className="p-banner" role="alert">
    <CircleAlert size={16} aria-hidden="true" />
    <p>{error.text}</p>
    {action && <Button type="button" variant="secondary" size="sm" onClick={action.run}>{action.label}</Button>}
    <button type="button" className="p-banner-close" aria-label="Dismiss error" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div>;
}
