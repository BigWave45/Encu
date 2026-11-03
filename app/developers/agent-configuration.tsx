"use client";

import { useCallback, useEffect, useState } from "react";

type Props = { agentId: string; accessToken: string };
type Config = {
  allocation: { allocation_limit_yocto: string; spent_yocto: string; reserved_yocto: string } | null;
  policy: { max_transfer_yocto: string | null; daily_limit_yocto: string | null; weekly_limit_yocto: string | null; auto_spend_limit_yocto: string | null } | null;
  recipients: Array<{ account_id: string; label: string | null; status: string; expires_at: string | null }>;
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

export default function AgentConfiguration({ agentId, accessToken }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [allocation, setAllocation] = useState("");
  const [maxTransfer, setMaxTransfer] = useState("");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [autoSpend, setAutoSpend] = useState("");
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/developer/agents/config?id=${encodeURIComponent(agentId)}`, {
      headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store"
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load configuration.");
    const data = body as Config;
    setConfig(data);
    setAllocation(formatNear(data.allocation?.allocation_limit_yocto));
    setMaxTransfer(formatNear(data.policy?.max_transfer_yocto));
    setDaily(formatNear(data.policy?.daily_limit_yocto));
    setWeekly(formatNear(data.policy?.weekly_limit_yocto));
    setAutoSpend(formatNear(data.policy?.auto_spend_limit_yocto));
  }, [agentId, accessToken]);

  useEffect(() => {
    let active = true;
    load().catch(e => { if (active) setError(e instanceof Error ? e.message : "Configuration unavailable."); });
    return () => { active = false; };
  }, [load]);

  async function save(payload: Record<string, unknown>) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/developer/agents/config", {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ id: agentId, ...payload })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.reason ?? body.error ?? "Configuration update failed.");
      setMessage("Saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Configuration update failed.");
    } finally { setBusy(false); }
  }

  function amounts(values: string[]) {
    const parsed = values.map(parseNear);
    if (parsed.some(value => value === undefined)) {
      setError("Use valid NEAR amounts with no more than 24 decimal places. Leave a field blank to clear that limit.");
      return null;
    }
    return parsed;
  }

  return (
    <details className="developer-config">
      <summary>Configure spending authority</summary>
      <div className="developer-config-body">
        <p className="developer-footnote">Amounts are in NEAR. Allocation comes from the shared Testnet pool and remains subject to ENCU’s platform-wide ceiling.</p>
        {config ? <>
          <div className="developer-meta">
            <div><span>Allocated</span><strong>{displayNear(config.allocation?.allocation_limit_yocto)}</strong></div>
            <div><span>Spent</span><strong>{displayNear(config.allocation?.spent_yocto)}</strong></div>
            <div><span>Reserved</span><strong>{displayNear(config.allocation?.reserved_yocto)}</strong></div>
          </div>
          <form className="developer-form" onSubmit={e => { e.preventDefault(); const value = parseNear(allocation); if (value == null || value === undefined) { setError("Enter a valid allocation greater than zero."); return; } void save({ action: "allocation", allocationLimitYocto: value }); }}>
            <h4>Allocation</h4>
            <label>Maximum allocation (NEAR)<input inputMode="decimal" value={allocation} onChange={e => setAllocation(e.target.value)} required /></label>
            <button className="developer-button" disabled={busy}>Save allocation</button>
          </form>
          <form className="developer-form" onSubmit={e => { e.preventDefault(); const values = amounts([maxTransfer, daily, weekly]); if (values) void save({ action: "policy", maxTransferYocto: values[0], dailyLimitYocto: values[1], weeklyLimitYocto: values[2] }); }}>
            <h4>Transfer limits</h4>
            <label>Maximum per transfer (NEAR)<input inputMode="decimal" value={maxTransfer} onChange={e => setMaxTransfer(e.target.value)} placeholder="Clear to remove" /></label>
            <label>Daily limit (NEAR)<input inputMode="decimal" value={daily} onChange={e => setDaily(e.target.value)} placeholder="Clear to remove" /></label>
            <label>Weekly limit (NEAR)<input inputMode="decimal" value={weekly} onChange={e => setWeekly(e.target.value)} placeholder="Clear to remove" /></label>
            <button className="developer-button" disabled={busy}>Save transfer limits</button>
          </form>
          <form className="developer-form" onSubmit={e => { e.preventDefault(); const value = parseNear(autoSpend); if (value === undefined) { setError("Enter a valid autonomous allowance or leave blank to clear it."); return; } void save({ action: "auto_spend", autoSpendLimitYocto: value }); }}>
            <h4>Autonomous allowance</h4>
            <label>Maximum autonomous spend (NEAR)<input inputMode="decimal" value={autoSpend} onChange={e => setAutoSpend(e.target.value)} placeholder="Clear to disable autonomous spend" /></label>
            <button className="developer-button" disabled={busy}>Save allowance</button>
          </form>
          <form className="developer-form" onSubmit={e => { e.preventDefault(); void save({ action: "authorize_recipient", accountId: accountId.trim(), label: label.trim() || undefined }); setAccountId(""); setLabel(""); }}>
            <h4>Authorize recipient</h4>
            <label>NEAR account ID<input value={accountId} onChange={e => setAccountId(e.target.value)} required placeholder="recipient.near" /></label>
            <label>Label (optional)<input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} /></label>
            <button className="developer-button" disabled={busy || !accountId.trim()}>Add recipient</button>
          </form>
          <div className="developer-recipient-list">
            <h4>Recipient allowlist</h4>
            {!config.recipients.length && <p>No recipients authorized. Transfers to all recipients remain blocked.</p>}
            {config.recipients.map(recipient => <div className="developer-recipient" key={recipient.account_id}>
              <div><strong>{recipient.label || recipient.account_id}</strong><code>{recipient.account_id}</code><span>{recipient.status}</span></div>
              {recipient.status === "active" && <button type="button" disabled={busy} onClick={() => void save({ action: "revoke_recipient", accountId: recipient.account_id, reason: "Revoked by developer" })}>Revoke</button>}
            </div>)}
          </div>
        </> : <p>Loading configuration…</p>}
        {message && <p className="developer-message" role="status">{message}</p>}
        {error && <p className="developer-message developer-error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
