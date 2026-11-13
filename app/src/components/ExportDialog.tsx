import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { Button } from "./ui/button";
import type { ExportScope } from "../lib/tripExport";

export function ExportDialog({ canSelect, canCurrent, hasDrafts, onClose, onExport }: {
  canSelect: boolean; canCurrent: boolean; hasDrafts: boolean; onClose: () => void;
  onExport: (scope: ExportScope, format: "pdf" | "html") => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<ExportScope>(canSelect ? "selected" : canCurrent ? "current" : "all");
  const [format, setFormat] = useState<"pdf" | "html">("pdf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  async function submit() {
    setBusy(true); setError(""); setMessage("");
    try {
      await onExport(scope, format);
      setMessage(format === "pdf" ? "Report opened in a new tab. Use Print / Save as PDF to save it." : "HTML report downloaded. You can send this file to your friends.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="p-export-dialog" aria-labelledby="export-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="p-export-heading"><h2 id="export-title">Export trips</h2><Button type="button" variant="ghost" size="sm" aria-label="Close export" disabled={busy} onClick={onClose}><X size={18} aria-hidden="true" /></Button></div>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}><legend>Include</legend>
        <label><input type="radio" name="export-scope" checked={scope === "selected"} disabled={!canSelect} onChange={() => setScope("selected")} />Selected itinerary</label>
        <label><input type="radio" name="export-scope" checked={scope === "current"} disabled={!canCurrent} onChange={() => setScope("current")} />Current trip · all calculated options</label>
        <label><input type="radio" name="export-scope" checked={scope === "all"} onChange={() => setScope("all")} />All saved trips · all calculated options</label>
      </fieldset>
      <fieldset disabled={busy}><legend>Format</legend>
        <label><input type="radio" name="export-format" checked={format === "pdf"} onChange={() => setFormat("pdf")} />PDF <small>Opens a print-ready report. Choose Save as PDF.</small></label>
        <label><input type="radio" name="export-format" checked={format === "html"} onChange={() => setFormat("html")} />HTML <small>Download a file that opens in any browser, without this app.</small></label>
      </fieldset>
      <p>Includes comparison tables, schedules and group transport prices. All options can make a long report.</p>
      {hasDrafts && <p className="p-export-warning">You have pending edits. This export uses saved settings and calculated prices. Wait for your edits to save to include them.</p>}
      {error && <p role="alert" className="p-export-warning">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="p-export-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Close</Button><Button type="submit" disabled={busy || (scope === "selected" && !canSelect) || (scope === "current" && !canCurrent)}>{busy ? <LoaderCircle size={15} className="p-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{busy ? "Preparing…" : format === "pdf" ? "Open PDF report" : "Download HTML"}</Button></div>
    </form>
  </dialog>;
}
