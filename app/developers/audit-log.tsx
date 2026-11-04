"use client";

import { useCallback, useEffect, useState } from "react";

type AuditEvent = {
  id: string; source: string; actor: string; action: string;
  targetId: string | null; requestId: string | null;
  details: Record<string, unknown>; createdAt: string;
};

export default function DeveloperAuditLog({ accessToken, refreshKey = 0 }: { accessToken: string; refreshKey?: number }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/developer/audit", {
        headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load audit events.");
      setEvents(body.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load audit events.");
    } finally { setBusy(false); }
  }, [accessToken]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  return (
    <section className="developer-audit" aria-label="Security and audit log">
      <div className="developer-activity-head">
        <div><span className="developer-section-kicker">SECURITY RECORD</span><h2>Audit &amp; request events</h2></div>
        <button className="developer-button secondary" type="button" onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="developer-audit-intro">Configuration changes and security events recorded for agents in this workspace.</p>
      {error && <p className="developer-error" role="alert">{error}</p>}
      {busy && events.length === 0 && <p>Loading audit events…</p>}
      {!busy && !error && events.length === 0 && <div className="developer-empty"><strong>No audit events yet</strong><span>Recorded changes and security events will appear here.</span></div>}
      <div className="developer-audit-list">
        {events.map(event => (
          <details className="developer-audit-entry" key={event.id}>
            <summary>
              <span className="developer-audit-action">{event.action.replace(/_/g, " ")}</span>
              <span className="developer-audit-source">{event.source}</span>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </summary>
            <dl>
              <div><dt>Actor</dt><dd>{event.actor}</dd></div>
              {event.targetId && <div><dt>Target</dt><dd>{event.targetId}</dd></div>}
              {event.requestId && <div><dt>Request ID</dt><dd>{event.requestId}</dd></div>}
            </dl>
            {Object.keys(event.details ?? {}).length > 0 && <pre>{JSON.stringify(event.details, null, 2)}</pre>}
          </details>
        ))}
      </div>
    </section>
  );
}
