"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = { agentId: string; accessToken: string; onSaved?: () => void | Promise<void> };
type Config = {
  allocation: { allocation_limit_yocto: string; spent_yocto: string; reserved_yocto: string } | null;
  policy: { max_transfer_yocto: string | null; daily_limit_yocto: string | null; weekly_limit_yocto: string | null; auto_spend_limit_yocto: string | null } | null;
};

const SCALE = 10n ** 24n;
function parseNear(value: string): string | null | undefined {
  if (!value.trim()) return null;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(value.trim())) return undefined;
  const [whole, fraction = ""] = value.trim().split(".");
  return (
    <div className="developer-config">
      <button className="developer-button secondary" type="button" aria-expanded={isOpen} onClick={() => setIsOpen(value => !value)}>{isOpen ? "Close settings" : "Edit spending authority"}</button>
      {message && !isOpen && <p className="developer-message" role="status">{message}</p>}
      {isOpen && <div className="developer-config-body">
        <p className="developer-footnote">Amounts are in NEAR. Allocation comes from the shared Testnet pool and remains subject to ENCU’s platform-wide ceiling. Requests outside configured limits or the autonomous allowance are rejected; there is no manual approval queue.</p>
        {config ? <>
          <div className="developer-meta">
            <div><span>Allocated</span><strong>{displayNear(config.allocation?.allocation_limit_yocto)}</strong></div>
            <div><span>Spent</span><strong>{displayNear(config.allocation?.spent_yocto)}</strong></div>
            <div><span>Reserved</span><strong>{displayNear(config.allocation?.reserved_yocto)}</strong></div>
          </div>
          <form className="developer-form" onSubmit={e => { e.preventDefault(); void saveAuthority(); }}>
            <h4>Allocation</h4>
            <label>Maximum allocation (NEAR)<input inputMode="decimal" value={allocation} onChange={e => setAllocation(e.target.value)} required /></label>
            <h4>Transfer limits</h4>
            <label>Maximum per transfer (NEAR)<input inputMode="decimal" value={maxTransfer} onChange={e => setMaxTransfer(e.target.value)} placeholder="Clear to remove" /></label>
            <label>Daily limit (NEAR)<input inputMode="decimal" value={daily} onChange={e => setDaily(e.target.value)} placeholder="Clear to remove" /></label>
            <label>Weekly limit (NEAR)<input inputMode="decimal" value={weekly} onChange={e => setWeekly(e.target.value)} placeholder="Clear to remove" /></label>
            <h4>Autonomous allowance</h4>
            <label>Maximum autonomous spend (NEAR)<input inputMode="decimal" value={autoSpend} onChange={e => setAutoSpend(e.target.value)} placeholder="Clear to disable autonomous spend" /></label>
            <button className="developer-button" disabled={busy}>{busy ? "Saving authority…" : "Save spending authority"}</button>
          </form>
        </> : <div className="developer-config-load-state">{error ? <button className="developer-button secondary" type="button" onClick={() => { setError(""); void load(agentId).catch(e => setError(e instanceof Error ? e.message : "Configuration unavailable.")); }}>Retry loading configuration</button> : <p>Loading configuration…</p>}</div>}
        {error && <p className="developer-message developer-error" role="alert">{error}</p>}
      </div>}
    </div>
  );
}