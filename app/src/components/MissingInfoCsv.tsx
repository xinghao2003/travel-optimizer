import { useEffect, useRef, useState } from "react";
import { Copy, ClipboardPaste, X } from "lucide-react";
import { Button } from "./ui/button";
import { exportMissingInfoCsv, missingInfoCsvRules, missingInfoCsvTargets, previewMissingInfoCsv, type CsvChange, type CsvContext, type CsvPreview } from "../lib/missingInfoCsv";

/** CSV is an editing template for Missing info; importing only stages drafts. */
export function MissingInfoCsv({ context, busy, onStage, onUndoRate, onUndoDeletion }: {
  context: CsvContext; busy: boolean; onStage: (changes: CsvChange[]) => void; onUndoRate: (currency: string) => void; onUndoDeletion: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const rulesEditor = useRef<HTMLTextAreaElement>(null);
  const [rulesFallback, setRulesFallback] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  useEffect(() => {
    if (rulesFallback) { rulesEditor.current?.focus(); rulesEditor.current?.select(); }
  }, [rulesFallback]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, [open]);
  function resetText() {
    setError(""); setMessage(""); setCopyMessage("");
    try {
      setText(exportMissingInfoCsv(missingInfoCsvTargets(context)));
      setPreview(null); setPage(0);
      return true;
    } catch (error) { setError((error as Error).message); return false; }
  }
  function showEditor() {
    setPreview(null); setCopyMessage(""); setMessage(""); setRulesFallback(false);
    if (text || resetText()) setOpen(true);
  }
  async function copy(kind: "csv" | "rules") {
    try {
      await navigator.clipboard.writeText(kind === "rules" ? missingInfoCsvRules : text);
      setRulesFallback(false);
      setCopyMessage(kind === "rules" ? "Rules/schema copied. Paste them alongside the CSV." : "CSV copied. Paste the edited rows back into this box.");
    } catch {
      const target = kind === "rules" ? rulesEditor : editor;
      setRulesFallback(kind === "rules");
      target.current?.focus(); target.current?.select();
      setCopyMessage(`Automatic copy is unavailable. The ${kind === "rules" ? "rules/schema" : "CSV"} is selected; press Ctrl+C or Command+C to copy.`);
    }
  }
  function check() { setPreview(previewMissingInfoCsv(text, context)); setPage(0); }
  function stage() {
    // Revalidate against the current trip and scopes after any intervening search or edit.
    const latest = previewMissingInfoCsv(text, context);
    setPreview(latest);
    if (busy || latest.errors.length || !latest.changes.length) return;
    onStage(latest.changes);
    setMessage(`Imported ${latest.changes.length} rows as drafts. Select Apply to save and update options.`);
    setOpen(false); setText(""); setPreview(null);
  }
  const rates = Object.entries(context.drafts.exchangeRates ?? {});
  const deletions = Object.entries(context.drafts.deletions ?? {});
  return <>
    <div className="p-csv-actions">
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={showEditor}><ClipboardPaste size={14} aria-hidden="true" />Edit as CSV</Button>
    </div>
    {message && <p className="p-mi-meta" role="status">{message}</p>}
    {error && !open && <p className="p-field-error" role="alert">{error}</p>}
    {rates.length > 0 && <ul className="p-csv-rates">{rates.map(([currency, rate]) => <li key={currency}>
      1 {currency} = {rate} MYR <span className="p-staged">Not applied</span>
      <button type="button" className="p-link-button" disabled={busy} onClick={() => onUndoRate(currency)}>Undo<span className="sr-only"> rate for {currency}</span></button>
    </li>)}</ul>}
    {deletions.length > 0 && <ul className="p-csv-rates">{deletions.map(([key, deletion]) => <li key={key}>
      Delete {deletion.label} <span className="p-staged">Not applied</span>
      <button type="button" className="p-link-button" disabled={busy} onClick={() => onUndoDeletion(key)}>Undo<span className="sr-only"> deletion of {deletion.label}</span></button>
    </li>)}</ul>}
    {open && <dialog ref={dialog} className="p-export-dialog p-csv-dialog" aria-labelledby="csv-title" onCancel={event => { event.preventDefault(); setOpen(false); }}
      onKeyDown={event => {
        // Unstaged CSV must not trigger the page's Apply shortcut.
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); }
      }}>
      <div className="p-export-heading"><h2 id="csv-title">Edit Missing info as CSV</h2><Button type="button" variant="ghost" size="sm" aria-label="Close CSV editor" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></Button></div>
      <p>Copy the CSV, fill it in, then paste it back into this box with its header. You can also edit here or paste spreadsheet cells. Blank cells leave values unchanged. Prices are for the whole party.</p>
      <details><summary>Which cells can I edit?</summary>
        <p>Edit price, max_price, currency, minutes and myr_per_unit where relevant. Airport changes also accept mode: taxi, rail, bus, coach, subway, tram or car. Airport transfers have a row for each mode; fill the rows you want.</p>
        <p>Leave max_price blank for a new fixed price. Enter a maximum for a range, or open for a journey price with no upper limit. To change an existing range to a fixed price, set max_price equal to price.</p>
        <p>Use the new-currency row to add an exchange rate. Copy that row for more currencies. Keep IDs, trip revision, party size and matching scope unchanged. New connections, combined tickets and global pricing rules use their existing forms.</p>
        <p>Set action to delete to remove a user-entered value. Missing rows stay unchanged. Removing a manual price allows provider prices or rules to apply again. Preview deletions before importing; Apply saves them.</p>
      </details>
      <div className="p-csv-editor-heading"><label htmlFor="csv-paste">CSV or spreadsheet rows</label>
        <Button type="button" size="sm" variant="secondary" disabled={!text.trim()} onClick={() => void copy("csv")}><Copy size={14} aria-hidden="true" />Copy CSV</Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void copy("rules")}><Copy size={14} aria-hidden="true" />Copy rules/schema</Button>
        <button type="button" className="p-link-button" disabled={busy} onClick={resetText}>Reset to current values</button>
      </div>
      <textarea ref={editor} id="csv-paste" rows={10} spellCheck={false} value={text} onChange={event => { setText(event.target.value); setPreview(null); setPage(0); setCopyMessage(""); }} />
      {copyMessage && <p role="status">{copyMessage}</p>}
      {rulesFallback && <><label htmlFor="csv-rules">Rules/schema</label><textarea ref={rulesEditor} id="csv-rules" rows={8} readOnly value={missingInfoCsvRules} /></>}
      {error && <p className="p-field-error" role="alert">{error}</p>}
      <Button type="button" size="sm" variant="secondary" disabled={!text.trim() || busy} onClick={check}>Preview changes</Button>
      {preview && <div className="p-csv-preview">
        <p role="status">{preview.changes.filter(c => c.operation !== "delete").length} updates · {preview.changes.filter(c => c.operation === "delete").length} deletions · {preview.unchanged} unchanged or blank · {preview.errors.length} errors</p>
        {preview.errors.length > 0 && <div role="alert"><p>Fix these errors before importing:</p><ul>{preview.errors.slice(0, 25).map((error, i) => <li key={i}>{error}</li>)}</ul>{preview.errors.length > 25 && <p>{preview.errors.length - 25} more errors.</p>}</div>}
        {preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {preview.changes.length > 0 && <>
          <div className="p-csv-table"><table><thead><tr><th>Row</th><th>Item / scope</th><th>Values to stage</th></tr></thead><tbody>
            {preview.changes.slice(page * 40, (page + 1) * 40).map(change => <tr key={change.line}><td>{change.line}</td>
              <td>{change.values.description}<small>{change.values.scope}</small></td>
              <td>{change.operation === "delete" ? "Delete user-entered value" : change.target.binding.kind === "rate" ? `1 ${change.values.currency} = ${change.values.myr_per_unit} MYR`
                : [change.values.mode, change.values.price && `${change.values.price}${change.values.max_price ? ` – ${change.values.max_price}` : ""} ${change.values.currency}`, change.values.minutes && `${change.values.minutes} min`].filter(Boolean).join(" · ")}</td></tr>)}
          </tbody></table></div>
          {preview.changes.length > 40 && <div className="p-comparison-pages"><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
            <span>{page * 40 + 1}–{Math.min((page + 1) * 40, preview.changes.length)} of {preview.changes.length}</span>
            <button type="button" disabled={(page + 1) * 40 >= preview.changes.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        </>}
      </div>}
      <div className="p-export-actions"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="button" disabled={busy || !preview?.changes.length || !!preview.errors.length} onClick={stage}>Import as drafts</Button></div>
    </dialog>}
  </>;
}
