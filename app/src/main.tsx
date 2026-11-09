import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Bug, DatabaseBackup, Download, X } from "lucide-react";
import Planner from "./Planner";
import { ThemeProvider } from "./components/theme-provider";
import { Button } from "./components/ui/button";
import { installPlannerTransport } from "./lib/planner";
import { BrowserPlannerApi } from "./native/api";
import "./styles.css";
import "./controls.css";

const service = new BrowserPlannerApi();
installPlannerTransport((path, method, body) => service.request(path, method, body), () => service.config());

function BackupDialog({ onClose, onImported }: { onClose(): void; onImported(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null), [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); return () => { element.close(); previous?.focus(); };
  }, []);
  async function restore() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      await service.ready();
      await service.repository.importBackup(JSON.parse(await file.text()), replace);
      const trips = await service.repository.summaries(), selected = await service.repository.get<string>("meta", "selected-trip");
      const id = trips.some(t => t.id === selected) ? selected : trips[0]?.id;
      if (id) localStorage.setItem("wayfinder:last-trip", id); else localStorage.removeItem("wayfinder:last-trip");
      onImported(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="p-export-dialog" aria-labelledby="backup-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="p-export-heading"><h2 id="backup-title">Restore browser backup</h2><Button variant="ghost" size="sm" aria-label="Close backup import" disabled={busy} onClick={onClose}><X size={18} aria-hidden="true" /></Button></div>
    <form onSubmit={event => { event.preventDefault(); void restore(); }}>
      <p>Restore saved trips, prices and transport data from a Wayfinder JSON backup.</p>
      <label>Backup file <input type="file" accept=".json,application/json" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />Replace records with matching IDs</label>
      {error && <p role="alert" className="p-export-warning">{error}</p>}
      <div className="p-export-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !file}>{busy ? "Restoring…" : "Restore backup"}</Button></div>
    </form>
  </dialog>;
}
function NativePlanner() {
  const [revision, setRevision] = useState(0), [importing, setImporting] = useState(false), [error, setError] = useState("");
  async function downloadBackup(debug = false) {
    try {
      await service.ready();
      await service.repository.put("meta", "selected-trip", localStorage.getItem("wayfinder:last-trip"));
      const backup = await service.repository.exportBackup(debug ? { app_commit: __APP_COMMIT__, user_agent: navigator.userAgent,
        provider_settings: await service.providers.settings().catch(error => String(error)) } : undefined);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" })), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `wayfinder-${debug ? "debug" : "backup"}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  return <>
    {error && <p role="alert">{error}<Button onClick={() => setError("")}>Dismiss</Button></p>}
    <Planner externalRevision={revision} storageActions={disabled => <>
      <button className="p-menu-item" type="button" disabled={disabled} onClick={() => void downloadBackup()}><Download size={15} aria-hidden="true" /><span>Download browser backup<small>Save trips, prices and transport data as JSON.</small></span></button>
      <button className="p-menu-item" type="button" disabled={disabled} onClick={() => void downloadBackup(true)}><Bug size={15} aria-hidden="true" /><span>Download debug bundle<small>Backup plus the search log and provider responses, for troubleshooting.</small></span></button>
      <button className="p-menu-item" type="button" disabled={disabled} onClick={() => setImporting(true)}><DatabaseBackup size={15} aria-hidden="true" /><span>Restore browser backup</span></button>
    </>} />
    {importing && <BackupDialog onClose={() => setImporting(false)} onImported={() => setRevision(value => value + 1)} />}
  </>;
}
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ThemeProvider><NativePlanner /></ThemeProvider></React.StrictMode>);
