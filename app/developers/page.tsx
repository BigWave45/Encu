"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import "./developers.css";
import AgentConfiguration from "./agent-configuration";

type DeveloperAgent = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  allocation: { allocation_limit_yocto: string; spent_yocto: string; reserved_yocto: string } | null;
  policy: { max_transfer_yocto: string | null; daily_limit_yocto: string | null; weekly_limit_yocto: string | null; auto_spend_limit_yocto: string | null } | null;
};

type AgentResponse = { status?: string; agent?: { id: string; name: string }; token?: string; warning?: string; error?: string };
type DeveloperTransaction = {
  requestId: string; agentId: string; recipient: string; amountYocto: string; status: string;
  txHash: string | null; providerRequestId: string | null; lastError: string | null; createdAt: string;
};

function near(value: string | null | undefined) {
  if (!value) return "Not configured";
  try {
    const amount = BigInt(value);
    const whole = amount / 10n ** 24n;
    const fraction = ((amount % 10n ** 24n) / 10n ** 20n).toString().padStart(4, "0").replace(/0+$/, "");
    return fraction ? `${whole.toString()}.${fraction} NEAR` : `${whole.toString()} NEAR`;
  } catch { return "Unavailable"; }
}

export default function DeveloperPortal() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [agents, setAgents] = useState<DeveloperAgent[]>([]);
  const [transactions, setTransactions] = useState<DeveloperTransaction[]>([]);
  const [transactionsBusy, setTransactionsBusy] = useState(false);
  const [transactionsError, setTransactionsError] = useState("");
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentError, setAgentError] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [issuedWarning, setIssuedWarning] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"connect" | "overview" | "agents">("connect");
  const [setupRecipientCount, setSetupRecipientCount] = useState<number | null>(null);

  const loadAgents = useCallback(async (accessToken: string) => {
    setAgentsBusy(true);
    setAgentError("");
    try {
      const response = await fetch("/api/developer/agents", {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) {
        setAgentError(body.error ?? "Could not load your agents.");
        setAgents([]);
      } else {
        setAgents(body.agents ?? []);
      }
    } catch {
      setAgentError("Could not reach ENCU. Check your connection.");
    } finally {
      setAgentsBusy(false);
    }
  }, []);

  const loadTransactions = useCallback(async (accessToken: string) => {
    setTransactionsBusy(true);
    setTransactionsError("");
    try {
      const response = await fetch("/api/developer/transactions", {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load transaction activity.");
      setTransactions(body.transactions ?? []);
    } catch (error) {
      setTransactionsError(error instanceof Error ? error.message : "Could not load transaction activity.");
      setTransactions([]);
    } finally {
      setTransactionsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!session || agents.length === 0) {
      setSetupRecipientCount(0);
      return;
    }
    let active = true;
    Promise.all(agents.map(async agent => {
      const response = await fetch(`/api/developer/agents/config?id=${encodeURIComponent(agent.id)}`, {
        headers: { authorization: `Bearer ${session.access_token}` },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Could not verify recipient setup.");
      const body = await response.json();
      return (body.recipients ?? []).filter((recipient: { status: string }) => recipient.status === "active").length;
    })).then(counts => {
      if (active) setSetupRecipientCount(counts.reduce((total, count) => total + count, 0));
    }).catch(() => {
      if (active) setSetupRecipientCount(null);
    });
    return () => { active = false; };
  }, [session, agents]);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      setAuthError("Developer sign-in is not configured for this deployment yet.");
      return;
    }
    const supabase = createClient(url, key, {
      auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    setClient(supabase);
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) {
        void loadAgents(data.session.access_token);
        void loadTransactions(data.session.access_token);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!alive) return;
      setSession(nextSession);
      if (nextSession) {
        void loadAgents(nextSession.access_token);
        void loadTransactions(nextSession.access_token);
      } else {
        setAgents([]);
        setTransactions([]);
      }
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [loadAgents, loadTransactions]);

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    setAuthBusy(true);
    setAuthMessage("");
    setAuthError("");
    try {
      if (authMode === "signup") {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/developers` }
        });
        if (error) throw error;
        if (data.session) {
          setSession(data.session);
          await loadAgents(data.session.access_token);
          await loadTransactions(data.session.access_token);
          setAuthMessage("Account created. Your developer workspace is ready.");
        } else {
          setAuthMessage("Account created. Check your email and confirm your address before signing in.");
        }
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setSession(data.session);
        await loadAgents(data.session.access_token);
        await loadTransactions(data.session.access_token);
        setAuthMessage("Signed in.");
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    setSession(null);
    setAgents([]);
    setTransactions([]);
    setIssuedToken("");
    setAuthMessage("Signed out.");
  }

  async function createAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setCreateBusy(true);
    setAgentMessage("");
    setAgentError("");
    setIssuedToken("");
    try {
      const response = await fetch("/api/developer/agents", {
        method: "POST",
        headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: agentId.trim(), name: agentName.trim() })
      });
      const body: AgentResponse = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Agent creation failed.");
      setIssuedToken(body.token ?? "");
      setIssuedWarning(body.warning ?? "");
      setAgentMessage("Agent created. Copy its token now.");
      setAgentId("");
      setAgentName("");
      await loadAgents(session.access_token);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Agent creation failed.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function agentAction(id: string, action: "rotate" | "deactivate" | "activate") {
    if (!session) return;
    setActionBusy(`${id}:${action}`);
    setAgentError("");
    setAgentMessage("");
    setIssuedToken("");
    try {
      const response = action === "rotate"
        ? await fetch("/api/developer/agents/rotate", {
            method: "POST",
            headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({ id })
          })
        : await fetch("/api/developer/agents/status", {
            method: "PATCH",
            headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({ id, active: action === "activate" })
          });
      const body: AgentResponse = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Agent update failed.");
      if (action === "rotate") {
        setIssuedToken(body.token ?? "");
        setIssuedWarning(body.warning ?? "");
        setAgentMessage(`Credential rotated for ${id}. Copy the replacement token now.`);
      } else {
        setAgentMessage(`Agent ${id} ${action === "activate" ? "activated" : "deactivated"}.`);
      }
      await loadAgents(session.access_token);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Agent update failed.");
    } finally {
      setActionBusy(null);
    }
  }

  async function copyToken() {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      setAgentMessage("Token copied. Store it in your agent's server-side secret manager.");
    } catch {
      setAgentMessage("Clipboard access unavailable. Select and copy the token manually.");
    }
  }

  return (
    <main className="developer-page">
      <div className="developer-container">
        <header className="developer-topbar">
          <Link className="developer-brand" href="/">ENCU</Link>
          <span>Developer control plane</span>
        </header>

        <div className="developer-eyebrow">Developer workspace</div>
        <h1 className="developer-title">Connect your agents<br />to controlled execution.</h1>
        <p className="developer-lede">
          Provision independent agent identities, assign spending authority and manage execution permissions from one workspace.
        </p>

        {session && <nav className="developer-navigation" aria-label="Developer workspace navigation">
          <button type="button" className={activeView === "connect" ? "active" : ""} onClick={() => setActiveView("connect")}>Connect / Setup</button>
          <button type="button" className={activeView === "overview" ? "active" : ""} onClick={() => setActiveView("overview")}>Overview</button>
          <button type="button" className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")}>Agents</button>
          <span>Recipients, Integration, Transactions, Audit &amp; Security and Developer Tools follow in the next navigation slice.</span>
        </nav>}

        {session && activeView === "connect" && <section className="developer-workspace-panel">
          <div className="developer-workspace-heading">
            <div><span className="developer-section-kicker">WORKSPACE SETUP</span><h2>Connect your first agent</h2>
              <p>Each item reflects data ENCU can verify from your current workspace.</p></div>
            <span className="developer-setup-count">{[
              true,
              agents.length > 0,
              agents.some(agent => BigInt(agent.allocation?.allocation_limit_yocto ?? "0") > 0n),
              setupRecipientCount !== null && setupRecipientCount > 0
            ].filter(Boolean).length}/4 complete</span>
          </div>
          <div className="developer-setup-list">
            <div className="developer-setup-item complete"><span className="developer-setup-mark">✓</span><div><strong>Developer workspace active</strong><p>Authenticated as {session.user.email}</p></div><span className="developer-setup-state">Connected</span></div>
            <div className={agents.length ? "developer-setup-item complete" : "developer-setup-item"}><span className="developer-setup-mark">{agents.length ? "✓" : "2"}</span><div><strong>Create an agent identity</strong><p>{agents.length ? `${agents.length} agent identity ${agents.length === 1 ? "is" : "ies"} registered.` : "Create a logical agent with its own machine credential."}</p></div><button type="button" onClick={() => setActiveView("agents")}>{agents.length ? "Manage agents" : "Create agent"}</button></div>
            <div className={agents.some(agent => BigInt(agent.allocation?.allocation_limit_yocto ?? "0") > 0n) ? "developer-setup-item complete" : "developer-setup-item"}><span className="developer-setup-mark">{agents.some(agent => BigInt(agent.allocation?.allocation_limit_yocto ?? "0") > 0n) ? "✓" : "3"}</span><div><strong>Assign spending authority</strong><p>{agents.some(agent => BigInt(agent.allocation?.allocation_limit_yocto ?? "0") > 0n) ? "At least one agent has a non-zero allocation." : "New agents start with zero allocation and cannot execute transfers."}</p></div><button type="button" onClick={() => setActiveView("agents")}>Configure allocation</button></div>
            <div className={setupRecipientCount === null ? "developer-setup-item unavailable" : setupRecipientCount > 0 ? "developer-setup-item complete" : "developer-setup-item"}><span className="developer-setup-mark">{setupRecipientCount === null ? "!" : setupRecipientCount > 0 ? "✓" : "4"}</span><div><strong>Authorize a recipient</strong><p>{setupRecipientCount === null ? "Recipient status could not be verified. Retry by reopening this page." : setupRecipientCount > 0 ? `${setupRecipientCount} active recipient authorization(s) found.` : "Transfers remain blocked until an exact recipient account is authorized."}</p></div><button type="button" onClick={() => setActiveView("agents")}>Manage recipients</button></div>
          </div>
          <p className="developer-setup-note">Agent credentials are displayed once when created or rotated. ENCU cannot verify whether you have stored a token securely, so credential storage is deliberately not marked complete here.</p>
        </section>}

        {session && activeView === "overview" && <section className="developer-workspace-panel">
          <div className="developer-workspace-heading"><div><span className="developer-section-kicker">WORKSPACE OVERVIEW</span><h2>Spending and execution activity</h2><p>Live values from the developer agents and transaction endpoints.</p></div>
            <button className="developer-button secondary" type="button" disabled={agentsBusy || transactionsBusy} onClick={() => { void loadAgents(session.access_token); void loadTransactions(session.access_token); }}>Refresh overview</button>
          </div>
          <div className="developer-overview-metrics">
            <div><span>Registered agents</span><strong>{agents.length}</strong></div>
            <div><span>Allocated authority</span><strong>{near(agents.reduce((sum, agent) => sum + BigInt(agent.allocation?.allocation_limit_yocto ?? "0"), 0n).toString())}</strong></div>
            <div><span>Spent</span><strong>{near(agents.reduce((sum, agent) => sum + BigInt(agent.allocation?.spent_yocto ?? "0"), 0n).toString())}</strong></div>
            <div><span>Reserved</span><strong>{near(agents.reduce((sum, agent) => sum + BigInt(agent.allocation?.reserved_yocto ?? "0"), 0n).toString())}</strong></div>
            <div><span>Requests loaded</span><strong>{transactions.length}</strong></div>
          </div>
          <div className="developer-overview-activity">
            <div><h3>Recent execution requests</h3><button className="developer-button secondary" type="button" disabled={transactionsBusy} onClick={() => void loadTransactions(session.access_token)}>{transactionsBusy ? "Refreshing…" : "Refresh activity"}</button></div>
            {transactionsError && <p className="developer-error" role="alert">{transactionsError}</p>}
            {transactions.length === 0 && !transactionsBusy ? <p className="developer-empty">No transaction requests have been returned for this workspace.</p> : transactions.slice(0, 8).map(item => <article className="developer-overview-transaction" key={item.requestId}>
              <div><strong>{near(item.amountYocto)}</strong><span>{item.agentId} · {item.recipient}</span></div><span className={`developer-status status-${item.status.replace(/[^a-z0-9_-]/g, "-")}`}>{item.status.replace(/_/g, " ")}</span>
            </article>)}
            <button className="developer-text-link" type="button" onClick={() => setActiveView("agents")}>Open agent management and full activity</button>
          </div>
        </section>}

        {!session ? (
          <div className="developer-grid">
            <section className="developer-panel">
              <h2>{authMode === "signup" ? "Create your developer account" : "Sign in to ENCU"}</h2>
              <p>{authMode === "signup" ? "Use your email address and create a password. Email confirmation may be required before your first sign-in." : "Access the private workspace associated with your account."}</p>
              <form className="developer-form" onSubmit={submitAuth}>
                <label>Email address<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
                <label>Password<input type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>
                <button className="developer-button" type="submit" disabled={!client || authBusy}>{authBusy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}</button>
              </form>
              <div className="developer-message" role="status">{authMessage}</div>
              {authError && <div className="developer-message developer-error" role="alert">{authError}</div>}
              <p>
                {authMode === "signup" ? "Already registered?" : "New to ENCU?"}{" "}
                <button className="developer-button secondary" type="button" onClick={() => { setAuthMode(authMode === "signup" ? "signin" : "signup"); setAuthMessage(""); setAuthError(""); }}>
                  {authMode === "signup" ? "Sign in" : "Create account"}
                </button>
              </p>
            </section>
            <aside className="developer-panel">
              <h2>What your account controls</h2>
              <p>Your workspace is isolated from other developers. You can create agents, view their assigned allocation and rotate or deactivate their credentials.</p>
              <p>New agents start with zero spending authority. You configure each agent’s allocation, transfer limits, autonomous allowance and exact authorized NEAR recipients.</p>
              <p>Developer accounts cannot change the shared treasury ceiling or platform emergency stop.</p>
            </aside>
          </div>
        ) : (
          <div className={`developer-grid ${activeView === "agents" ? "" : "developer-view-hidden"}`}>
            <section className="developer-panel">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div><h2>Your agents</h2><p>Signed in as {session.user.email}</p></div>
                <button className="developer-button secondary" type="button" onClick={signOut}>Sign out</button>
              </div>

              <form className="developer-form" onSubmit={createAgent}>
                <label>Agent ID<input required minLength={2} maxLength={48} pattern="[a-z0-9_-]+" value={agentId} onChange={event => setAgentId(event.target.value)} placeholder="e.g. research-agent" /></label>
                <label>Agent name<input required minLength={2} maxLength={80} value={agentName} onChange={event => setAgentName(event.target.value)} placeholder="e.g. Research Agent" /></label>
                <button className="developer-button" type="submit" disabled={createBusy}>{createBusy ? "Creating…" : "Create agent"}</button>
              </form>

              {agentMessage && <div className="developer-message" role="status">{agentMessage}</div>}
              {agentError && <div className="developer-message developer-error" role="alert">{agentError}</div>}
              {issuedToken && <div className="developer-token"><strong>New agent token</strong><code>{issuedToken}</code><button className="developer-button secondary" type="button" onClick={copyToken}>Copy token</button><p>{issuedWarning}</p></div>}

              <div className="developer-list">
                {agentsBusy && <p>Loading your agents…</p>}
                {!agentsBusy && agents.length === 0 && <p>You have not created any agents yet.</p>}
                {agents.map(agent => {
                  const allocation = agent.allocation;
                  const limit = allocation?.allocation_limit_yocto ?? "0";
                  const ready = agent.active && BigInt(limit) > 0n;
                  return (
                    <article className="developer-agent" key={agent.id}>
                      <div className="developer-agent-head">
                        <div><h3>{agent.name}</h3><code>{agent.id}</code></div>
                        <span style={{color:agent.active ? "#dfb66f" : "#e49b8e",fontSize:11}}>{agent.active ? "Active" : "Disabled"}</span>
                      </div>
                      <div className="developer-meta">
                        <div><span>Allocated authority</span><strong>{near(limit)}</strong></div>
                        <div><span>Spent / reserved</span><strong>{near(allocation?.spent_yocto)} / {near(allocation?.reserved_yocto)}</strong></div>
                      </div>
                      <p>{ready ? "Allocation exists. Set transfer limits, autonomous allowance and authorized recipients." : "This agent has zero allocation and cannot spend until you configure its authority."}</p>
                      <AgentConfiguration agentId={agent.id} accessToken={session.access_token} />
                      <AgentPlayground agentId={agent.id} />
                      <div className="developer-actions">
                        <button type="button" disabled={!!actionBusy || !agent.active} onClick={() => agentAction(agent.id,"rotate")}>Rotate token</button>
                        <button type="button" disabled={!!actionBusy} onClick={() => agentAction(agent.id,agent.active ? "deactivate" : "activate")}>{agent.active ? "Deactivate" : "Reactivate"}</button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <section className="developer-activity" aria-label="Recent transaction activity">
                <div className="developer-activity-head">
                  <div><span className="developer-section-kicker">ACTIVITY</span><h2>Recent transactions</h2></div>
                  <button className="developer-button secondary" type="button" disabled={transactionsBusy} onClick={() => session && void loadTransactions(session.access_token)}>{transactionsBusy ? "Refreshing…" : "Refresh"}</button>
                </div>
                {transactionsError && <p className="developer-error" role="alert">{transactionsError}</p>}
                {transactionsBusy && transactions.length === 0 && <p>Loading transaction activity…</p>}
                {!transactionsBusy && !transactionsError && transactions.length === 0 && <div className="developer-empty"><strong>No transactions yet</strong><span>Requests made by your agents will appear here.</span></div>}
                {transactions.length > 0 && <div className="developer-activity-list">
                  {transactions.map(item => <article className="developer-transaction" key={item.requestId}>
                    <div className="developer-transaction-main">
                      <div><strong>{near(item.amountYocto)}</strong><span>NEAR · {item.agentId}</span></div>
                      <span className={`developer-status status-${item.status.replace(/[^a-z0-9_-]/g, "-")}`}>{item.status.replace(/_/g, " ")}</span>
                    </div>
                    <div className="developer-transaction-meta"><span>To {item.recipient}</span><time>{new Date(item.createdAt).toLocaleString()}</time></div>
                    {item.txHash && <code className="developer-tx-reference">TX {item.txHash}</code>}
                    {item.lastError && <p className="developer-transaction-error">{item.lastError}</p>}
                  </article>)}
                </div>}
                <p className="developer-activity-note">Showing the latest 50 requests across agents in this workspace. Transaction status is reconciled independently against NEAR finality.</p>
              </section>
            </section>
            <aside className="developer-panel">
              <h2>Configure bounded execution</h2>
              <p>1. Create your agent and securely store its bearer token.</p>
              <p>2. You assign an allocation from the shared Testnet treasury, subject to ENCU’s platform-wide ceiling.</p>
              <p>3. You set transfer limits, autonomous allowance and exact authorized NEAR recipients.</p>
              <p>4. Your backend sends requests using the agent token. ENCU enforces the current policy before execution by the configured backend.</p>
              <div className="developer-footnote">Your login authenticates you as a developer. The agent token authenticates the machine identity. They are separate credentials and must never be interchanged.</div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}


function AgentPlayground({ agentId }: { agentId: string }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [payload, setPayload] = useState("");
  const [message, setMessage] = useState("");

  function generatePayload() {
    setMessage("");
    setPayload("");
    const value = amount.trim();
    if (!/^(0|[1-9][0-9]*)(\\.[0-9]{1,24})?$/.test(value)) {
      setMessage("Enter a positive NEAR amount with no more than 24 decimal places.");
      return;
    }
    const [whole, fraction = ""] = value.split(".");
    const amountYocto = (BigInt(whole) * 10n ** 24n + BigInt((fraction + "0".repeat(24)).slice(0, 24))).toString();
    if (amountYocto === "0") {
      setMessage("Amount must be greater than zero.");
      return;
    }
    const to = recipient.trim();
    if (to.length > 64 || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(to)) {
      setMessage("Enter a valid lowercase NEAR account ID (maximum 64 characters).");
      return;
    }
    setPayload(JSON.stringify({ requestId: "encu-" + crypto.randomUUID(), to, amountYocto, expectedAgentId: agentId }, null, 2));
  }

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payload);
      setMessage("JSON payload copied.");
    } catch {
      setMessage("Clipboard unavailable. Select and copy the JSON manually.");
    }
  }

  return (
    <section className="developer-playground" aria-label="Request Payload Builder">
      <span className="developer-section-kicker">DEVELOPER TOOL</span>
      <h4>Request Payload Builder</h4>
      <p>Prepare a request body for this agent. This tool does not submit a request or execute a transfer.</p>
      <div className="developer-playground-fields">
        <label>Recipient NEAR account<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="recipient.near" autoCapitalize="none" autoCorrect="off" /></label>
        <label>Amount (NEAR)<input value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.001" inputMode="decimal" /></label>
      </div>
      <div className="developer-playground-controls">
        <button className="developer-button" type="button" onClick={generatePayload}>Generate payload</button>
        {payload && <button className="developer-button secondary" type="button" onClick={() => void copyPayload()}>Copy JSON</button>}
      </div>
      {message && <p className="developer-playground-warning" role="status">{message}</p>}
      {payload && <pre className="developer-playground-payload">{payload}</pre>}
      <p className="developer-playground-warning">A generated payload is not an authorization decision. Your backend must authenticate the agent and enforce current allocation, limits and recipient permissions before execution.</p>
    </section>
  );
}
