"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = { agentId: string; accessToken: string; onSaved?: () => void };
type Config = {
  allocation: { allocation_limit_yocto: string; spent_yocto: string; reserved_yocto: string } | null;
  policy: { max_transfer_yocto: string | null; daily_limit_yocto: string | null; weekly_limit_yocto: string | null; auto_spend_limit_yocto: string | null } | null;
};

const SCALE = 10n ** 24n;
function parseNear(value: string): string | null | undefined {
  if (!value.trim()) return null;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(value.trim())) return undefined;
  const [whole, fraction = ""] = value.trim().split(".");
  return (BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(24)).slice(0, 24))).toString();
}
function formatNear(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const amount = BigInt(value);
    const fraction = (amount % SCALE).toString().padStart(24, "0").replace(/0+$/, "");
    return fraction ? `${amount / SCALE}.${fraction}` : (amount / SCALE).toString();
  } catch { return ""; }
}
function displayNear(value: string | null | undefined): string {
  if (value == null) return "Not configured";
  const formatted = formatNear(value);
  return formatted ? `${formatted} NEAR` : "0 NEAR";
}

export default function AgentConfiguration({ agentId, accessToken, onSaved }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [allocation, setAllocation] = useState("");
  const [maxTransfer, setMaxTransfer] = useState("");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [autoSpend, setAutoSpend] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const loadVersion = useRef(0);
  const currentAgentId = useRef(agentId);
  currentAgentId.current = agentId;

  const load = useCallback(async (requestedAgentId = agentId) => {
    const version = ++loadVersion.current;
    const response = await fetch(`/api/developer/agents/config?id=${encodeURIComponent(requestedAgentId)}`, {
      headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store"
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load configuration.");
    if (version !== loadVersion.current) return;
    const data = body as Config;
    setConfig(data);
    setAllocation(formatNear(data.allocation?.allocation_limit_yocto));
    setMaxTransfer(formatNear(data.policy?.max_transfer_yocto));
    setDaily(formatNear(data.policy?.daily_limit_yocto));
    setWeekly(formatNear(data.policy?.weekly_limit_yocto));
    setAutoSpend(formatNear(data.policy?.auto_spend_limit_yocto));
  }, [agentId, accessToken]);

  useEffect(() => {
    setConfig(null);
    setAllocation(""); setMaxTransfer(""); setDaily(""); setWeekly(""); setAutoSpend("");
    setError(""); setMessage("");
    const version = loadVersion.current + 1;
    load(agentId).catch(e => { if (loadVersion.current === version) setError(e instanceof Error ? e.message : "Configuration unavailable."); });
    return () => { loadVersion.current += 1; };
  }, [load, agentId]);


  async function saveAuthority() {
    const allocationValue = parseNear(allocation);
    const transferValues = amounts([maxTransfer, daily, weekly]);
    const autoSpendValue = parseNear(autoSpend);
    if (allocationValue === undefined || allocationValue === null) {
      setError("Enter a valid allocation of zero or more NEAR.");
      return;
    }
    if (!transferValues) return;
    if (autoSpendValue === undefined) {
      setError("Enter a valid autonomous allowance or leave blank to clear it.");
      return;
    }

    setBusy(true); setError(""); setMessage("");
    try {
      const updates = [
        { action: "allocation", allocationLimitYocto: allocationValue },
        { action: "policy", maxTransferYocto: transferValues[0], dailyLimitYocto: transferValues[1], weeklyLimitYocto: transferValues[2] },
        { action: "auto_spend", autoSpendLimitYocto: autoSpendValue }
      ];
      for (const update of updates) {
        const response = await fetch("/api/developer/agents/config", {
          method: "PATCH",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ id: agentId, ...update })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.reason ?? body.error ?? "Configuration update failed.");
      }
      if (currentAgentId.current !== agentId) return;
      await load(agentId);
      await onSaved?.();
      setIsOpen(false);
      setMessage("Spending authority saved.");
    } catch (e) {
      if (currentAgentId.current === agentId) {
        setError(e instanceof Error ? e.message : "Configuration update failed. Check saved values before retrying.");
        try { await load(agentId); } catch { /* Preserve the original error. */ }
      }
    } finally { setBusy(false); }
  }

  function amounts(values: string[]) {
    const parsed = values.map(parseNear);
    if (parsed.some(value => value === undefined || value === "0")) {
      setError("Use positive NEAR amounts with no more than 24 decimal places. Leave a field blank to clear that limit; set allocation or autonomous allowance to zero to stop spending.");
      return null;
    }
    return parsed;
  }

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
        </> : <div className="developer-config-load-state">
          {error ? <button className="developer-button secondary" type="button" onClick={() => { setError(""); const version = loadVersion.current + 1; void load(agentId).catch(e => { if (loadVersion.current === version) setError(e instanceof Error ? e.message : "Configuration unavailable."); }); }}>Retry loading configuration</button> : <p>Loading configuration…</p>}
        </div>}
        {error && <p className="developer-message developer-error" role="alert">{error}</p>}
      </div>}
    </div>
  );
}
