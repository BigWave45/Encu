"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import "./developers.css";
import "./dashboard-workflow.css";
import AgentConfiguration from "./agent-configuration";
import AgentPlayground from "./agent-playground";
import ExecutionExplainer from "./execution-explainer";
import DeveloperAuditLog from "./audit-log";

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
  const [issuedTokenAgentId, setIssuedTokenAgentId] = useState("");
  const [issuedWarning, setIssuedWarning] = useState("");
  const [auditRefreshKey, setAuditRefreshKey] = useState(0);
  const [activeView, setActiveView] = useState<"overview" | "agents" | "recipients" | "integration" | "transactions" | "audit" | "tools" | "execution">("overview");
  const [actionBusy, setActionBusy] = useState<string | null>(null);

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
    setIssuedTokenAgentId("");
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
      setIssuedTokenAgentId(body.agent?.id ?? agentId.trim());
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
        setIssuedTokenAgentId(id);
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
          <>
          <nav className="developer-nav" aria-label="Developer workspace sections">
            {([["overview","Overview"],["agents","Agents"],["recipients","Recipients"],["integration","Integration"],["transactions","Transactions"],["audit","Audit & Security"],["tools","Developer tools"],["execution","How ENCU works"]] as const).map(([id,label]) => <button key={id} type="button" className={activeView === id ? "active" : ""} aria-current={activeView === id ? "page" : undefined} onClick={() => setActiveView(id)}>{label}</button>)}
          </nav>
          <div className="developer-grid">
            <section className="developer-panel">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div><h2>{activeView === "overview" ? "Workspace overview" : activeView === "agents" ? "Your agents" : activeView === "recipients" ? "Recipient permissions" : activeView === "integration" ? "Integration" : activeView === "transactions" ? "Transactions" : activeView === "audit" ? "Audit & Security" : activeView === "tools" ? "Developer tools" : "How ENCU works"}</h2><p>Signed in as {session.user.email}</p></div>
{activeView === "overview" && <div className="developer-workspace-summary" aria-label="Workspace spending summary">
                {(() => {
                  const totals = agents.reduce((sum, agent) => ({
                    allocated: sum.allocated + BigInt(agent.allocation?.allocation_limit_yocto ?? "0"),
                    spent: sum.spent + BigInt(agent.allocation?.spent_yocto ?? "0"),
                    reserved: sum.reserved + BigInt(agent.allocation?.reserved_yocto ?? "0")
                  }), { allocated: 0n, spent: 0n, reserved: 0n });
                  const available = totals.allocated - totals.spent - totals.reserved;
                  return <>
                    <div><span>Allocated authority</span><strong>{near(totals.allocated.toString())}</strong></div>
                    <div><span>Spent</span><strong>{near(totals.spent.toString())}</strong></div>
                    <div><span>Reserved</span><strong>{near(totals.reserved.toString())}</strong></div>
                    <div><span>Available across agents</span><strong>{available >= 0n ? near(available.toString()) : "Ledger mismatch"}</strong></div>
                  </>;
                })()}
              </div>}
                <button className="developer-button secondary" type="button" onClick={signOut}>Sign out</button>
              </div>

              {activeView === "overview" && (() => {
                const activeAgents = agents.filter(agent => agent.active);
                const configuredAgents = agents.filter(agent => agent.active && BigInt(agent.allocation?.allocation_limit_yocto ?? "0") > 0n);
                const inactiveAgents = agents.filter(agent => !agent.active);
                const unallocatedAgents = agents.filter(agent => BigInt(agent.allocation?.allocation_limit_yocto ?? "0") === 0n);
                const pendingTransactions = transactions.filter(item => ["pending", "submitted", "processing", "needs_review", "awaiting_approval"].includes(item.status));
                const failedTransactions = transactions.filter(item => ["failed", "rejected", "cancelled", "expired", "blocked"].includes(item.status));
                const recentTransactions = transactions.slice(0, 5);
                return <section className="developer-overview-detail" aria-label="Developer workspace status">
                  <div className="developer-overview-heading"><span className="developer-section-kicker">WORKSPACE STATUS</span><span>{agentsBusy || transactionsBusy ? "Updating live records…" : "Based on your current workspace records"}</span></div>
                  <div className="developer-overview-metrics">
                    <article><span>Agents</span><strong>{agents.length}</strong><small>{activeAgents.length} active · {inactiveAgents.length} inactive</small></article>
                    <article><span>Allocated agents</span><strong>{configuredAgents.length}</strong><small>{unallocatedAgents.length} with zero allocation</small></article>
                    <article><span>In-flight requests</span><strong>{pendingTransactions.length}</strong><small>Across the latest 50 requests</small></article>
                    <article><span>Blocked or failed</span><strong>{failedTransactions.length}</strong><small>Across the latest 50 requests</small></article>
                  </div>
                  <div className="developer-overview-columns">
                    <div className="developer-overview-panel">
                      <div className="developer-activity-head"><h3>Agent readiness</h3><button className="developer-button secondary" type="button" disabled={agentsBusy || !session} onClick={() => session && void loadAgents(session.access_token)}>Refresh</button></div>
                      {agentError && <p className="developer-error" role="alert">{agentError}</p>}
                      {agents.length === 0 ? <p className="developer-overview-empty">No agents yet. Create an agent to begin configuring bounded execution.</p> : agents.slice(0, 6).map(agent => {
                        const allocation = BigInt(agent.allocation?.allocation_limit_yocto ?? "0");
                        const ready = agent.active && allocation > 0n;
                        return <div className="developer-overview-agent" key={agent.id}><div><strong>{agent.name}</strong><code>{agent.id}</code></div><span className={ready ? "is-ready" : "is-attention"}>{!agent.active ? "Inactive" : allocation === 0n ? "No allocation" : "Allocated"}</span></div>;
                      })}
                      {agents.length > 6 && <p className="developer-overview-empty">Showing 6 of {agents.length} agents. Open Agents to manage the full list.</p>}
                    </div>
                    <div className="developer-overview-panel">
                      <div className="developer-activity-head"><h3>Recent requests</h3><button className="developer-button secondary" type="button" disabled={transactionsBusy || !session} onClick={() => session && void loadTransactions(session.access_token)}>Refresh</button></div>
                      {transactionsError && <p className="developer-error" role="alert">{transactionsError}</p>}
                      {transactions.length === 0 ? <p className="developer-overview-empty">{transactionsBusy ? "Loading requests…" : "No transaction requests recorded yet."}</p> : recentTransactions.map(item => <div className="developer-overview-request" key={item.requestId}><div><strong>{near(item.amountYocto)}</strong><span>{item.agentId} → {item.recipient}</span></div><span className={failedTransactions.includes(item) ? "is-attention" : pendingTransactions.includes(item) ? "is-pending" : "is-ready"}>{item.status.replace(/_/g, " ")}</span></div>)}
                      <button className="developer-overview-link" type="button" onClick={() => setActiveView("transactions")}>View transaction history</button>
                    </div>
                  </div>
                </section>;
              })()}
              {activeView === "agents" && <>
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
                      <AgentConfiguration agentId={agent.id} accessToken={session.access_token} onSaved={() => void loadAgents(session.access_token)} />
                      <div className="developer-actions">
                        <button type="button" disabled={!!actionBusy || !agent.active} onClick={() => agentAction(agent.id,"rotate")}>Rotate token</button>
                        <button type="button" disabled={!!actionBusy} onClick={() => agentAction(agent.id,agent.active ? "deactivate" : "activate")}>{agent.active ? "Deactivate" : "Reactivate"}</button>
                      </div>
                    </article>
                  );
                })}
              </div>
              </>}
              {activeView === "transactions" && <section className="developer-activity" aria-label="Recent transaction activity">
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
              </section>}
              {activeView === "audit" && <DeveloperAuditLog accessToken={session.access_token} refreshKey={auditRefreshKey} />
            </section>
            {activeView === "overview" && <aside className="developer-panel">
              <h2>Configure bounded execution</h2>
              <p>1. Create your agent and securely store its bearer token.</p>
              <p>2. You assign an allocation from the shared Testnet treasury, subject to ENCU’s platform-wide ceiling.</p>
              <p>3. You set transfer limits, autonomous allowance and exact authorized NEAR recipients.</p>
              <p>4. Your backend sends requests using the agent token. ENCU enforces the current policy before execution by the configured backend.</p>
              <div className="developer-footnote">Your login authenticates you as a developer. The agent token authenticates the machine identity. They are separate credentials and must never be interchanged.</div>
            </aside>}
          </div>
          {activeView === "recipients" && <RecipientManagement agents={agents} accessToken={session.access_token} onSaved={() => void loadAgents(session.access_token)} />}
          {activeView === "integration" && <IntegrationGuide issuedToken={issuedToken} issuedWarning={issuedWarning} />}
          {activeView === "tools" && <section className="developer-panel developer-tools-workspace"><span className="developer-section-kicker">LIVE TESTNET TOOLS</span><h2>Request payload builder</h2><p>Submitting a request can initiate a real Testnet transfer when the agent policy permits it. This is not a dry run.</p>{agents.length === 0 ? <div className="developer-empty"><strong>Create an agent first</strong><span>The payload builder is scoped to an existing agent identity.</span></div> : agents.map(agent => <article className="developer-agent" key={agent.id}><div className="developer-agent-head"><div><h3>{agent.name}</h3><code>{agent.id}</code></div><span>{agent.active ? "Active" : "Disabled"}</span></div><AgentPlayground agentId={agent.id} issuedToken={issuedTokenAgentId === agent.id ? issuedToken : ""} onSubmitted={() => { void loadTransactions(session.access_token); setAuditRefreshKey(value => value + 1); }} /></article>)}</section>}
          {activeView === "overview" && <ExecutionExplainer />}
          {activeView === "execution" && <ExecutionExplainer />}
          </>
        )}
      </div>
    </main>
  );
}


type RecipientRecord = { account_id: string; label: string | null; status: string; expires_at: string | null };

function RecipientManagement({ agents, accessToken, onSaved }: { agents: DeveloperAgent[]; accessToken: string; onSaved: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selectedAgent = agents.find(agent => agent.id === agentId) ?? agents[0] ?? null;

  const load = useCallback(async (id: string) => {
    if (!id) { setRecipients([]); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/developer/agents/config?id=${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load recipient permissions.");
      setRecipients(Array.isArray(body.recipients) ? body.recipients : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load recipient permissions.");
    } finally { setLoading(false); }
  }, [accessToken]);

  useEffect(() => {
    if (!agents.some(agent => agent.id === agentId) && agents[0]) setAgentId(agents[0].id);
    if (!agents.length) { setAgentId(""); setRecipients([]); }
  }, [agents, agentId]);

  useEffect(() => { if (selectedAgent) void load(selectedAgent.id); }, [selectedAgent?.id, load]);

  async function update(payload: Record<string, unknown>) {
    if (!selectedAgent) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/developer/agents/config", {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ id: selectedAgent.id, ...payload })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.reason ?? body.error ?? "Recipient permission update failed.");
      setMessage(payload.action === "authorize_recipient" ? "Recipient authorized." : "Recipient permission revoked.");
      await load(selectedAgent.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recipient permission update failed.");
    } finally { setBusy(false); }
  }

  return (
    <section className="developer-panel developer-recipient-workspace">
      <div className="developer-workspace-heading">
        <div><span className="developer-section-kicker">RECIPIENT ACCESS</span><h2>Authorized NEAR accounts</h2><p>Transfers are restricted to exact account IDs explicitly authorized for each agent. Permissions do not carry over between agents.</p></div>
      </div>
      {agents.length === 0 ? <div className="developer-empty"><strong>Create an agent first</strong><span>Recipient permissions are assigned to an individual agent identity.</span></div> : <>
        <label className="developer-recipient-agent">Agent identity
          <select value={selectedAgent?.id ?? ""} onChange={event => setAgentId(event.target.value)}>
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}
          </select>
        </label>
        <form className="developer-form" onSubmit={event => {
          event.preventDefault();
          if (!accountId.trim()) return;
          void update({ action: "authorize_recipient", accountId: accountId.trim(), label: label.trim() || undefined, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
          setAccountId(""); setLabel(""); setExpiresAt("");
        }}>
          <h3>Authorize a recipient</h3>
          <label>Exact NEAR account ID<input value={accountId} onChange={event => setAccountId(event.target.value)} required placeholder="recipient.near" /></label>
          <label>Label (optional)<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="Vendor or service name" /></label>
          <label>Expiry (optional)<input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
          <button className="developer-button" type="submit" disabled={busy || !accountId.trim()}>{busy ? "Saving…" : "Authorize recipient"}</button>
        </form>
        <div className="developer-recipient-list">
          <div className="developer-activity-head"><h3>Agent allowlist</h3><button className="developer-button secondary" type="button" disabled={loading} onClick={() => selectedAgent && void load(selectedAgent.id)}>Refresh</button></div>
          {loading && <p>Loading recipient permissions…</p>}
          {!loading && recipients.length === 0 && <p>No recipients authorized. Transfers to all recipients remain blocked.</p>}
          {recipients.map(recipient => <div className="developer-recipient" key={recipient.account_id}>
            <div><strong>{recipient.label || recipient.account_id}</strong><code>{recipient.account_id}</code><span>{recipient.status}{recipient.expires_at ? ` · expires ${new Date(recipient.expires_at).toLocaleString()}` : " · no expiry"}</span></div>
            {recipient.status === "active" && <button type="button" disabled={busy} onClick={() => void update({ action: "revoke_recipient", accountId: recipient.account_id, reason: "Revoked by developer" })}>Revoke</button>}
          </div>)}
        </div>
      </>}
      {message && <p className="developer-message" role="status">{message}</p>}
      {error && <p className="developer-message developer-error" role="alert">{error}</p>}
    </section>
  );
}

function IntegrationGuide({ issuedToken, issuedWarning }: { issuedToken: string; issuedWarning: string }) {
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const payload = JSON.stringify({
    requestId: "invoice-payment-20261104-001",
    to: "recipient.near",
    amountYocto: "1000000000000000000000000",
    expectedAgentId: "your-agent-id"
  });
  const request = `curl --request POST "$ENCU_BASE_URL/api/agent/transfer" --header "Authorization: Bearer $ENCU_AGENT_TOKEN" --header "Content-Type: application/json" --data '${payload}'`;
  async function copyRequest() {
    try { await navigator.clipboard.writeText(request); setCopied(true); }
    catch { setCopied(false); }
  }
  return (
    <section className="developer-panel developer-integration-workspace">
      <span className="developer-section-kicker">API INTEGRATION</span>
      <h2>Connect your backend to ENCU</h2>
      <p>Integrate from a trusted server environment. Each request is authenticated as one agent identity, then evaluated against that agent’s allocation, transfer policy and recipient permissions.</p>
      <div className="developer-integration-steps">
        <article><span>01</span><div><strong>Set your server environment</strong><p>Configure the base URL for the ENCU deployment you use and store the agent token in your server-side secret manager.</p></div></article>
        <article><span>02</span><div><strong>Send the agent-scoped request</strong><p>Use the exact agent token and a unique request ID. Set <code>expectedAgentId</code> to catch accidental token-to-agent mismatches.</p></div></article>
        <article><span>03</span><div><strong>Reconcile the outcome</strong><p>A successful HTTP response is not proof of payment. Read the returned status and monitor the transaction record until NEAR finality is reconciled.</p></div></article>
      </div>
      <div className="developer-integration-env">
        <strong>Server environment variables</strong>
        <code>ENCU_BASE_URL=https://your-encu-deployment</code>
        <code>ENCU_AGENT_TOKEN=your-agent-scoped-token</code>
        <small>Do not prefix the token with NEXT_PUBLIC_, embed it in frontend code, or commit it to source control.</small>
      </div>
      <div className="developer-integration-code-heading"><h3>Native NEAR transfer request</h3><button className="developer-button secondary" type="button" onClick={() => void copyRequest()}>{copied ? "Copied" : "Copy cURL"}</button></div>
      <pre className="developer-integration-code"><code>{request}</code></pre>
      <div className="developer-integration-field-notes">
        <div><strong><code>requestId</code></strong><span>8–128 characters. Keep it stable only when retrying the exact same logical payload. A conflicting replay returns 409.</span></div>
        <div><strong><code>to</code></strong><span>Exact NEAR account ID. It must be authorized for this agent before execution.</span></div>
        <div><strong><code>amountYocto</code></strong><span>Positive integer string in yoctoNEAR. 1 NEAR = 10²⁴ yoctoNEAR. No decimal point or exponent notation.</span></div>
        <div><strong><code>expectedAgentId</code></strong><span>Optional identity assertion. ENCU returns 409 if it differs from the authenticated agent.</span></div>
      </div>
      {issuedToken && <div className="developer-token"><strong>Credential issued in this browser session</strong><button className="developer-button secondary" type="button" onClick={() => setShowToken(value => !value)}>{showToken ? "Hide token" : "Reveal token"}</button>{showToken && <code>{issuedToken}</code>}<p>{issuedWarning || "Copy this one-time token and store it in your backend secret manager. It is held in page memory only and is not persisted by ENCU in browser storage."}</p></div>}
      <div className="developer-integration-responses">
        <h3>Interpret the API response</h3>
        <div><strong>202 · needs_review</strong><p>ENCU has accepted the request for follow-up, but the transfer is not confirmed as paid. This includes provider submission awaiting on-chain confirmation and uncertain provider outcomes.</p></div>
        <div><strong>403 · blocked</strong><p>Policy denied the request, such as a recipient not being authorized, an allocation or transfer limit being exceeded, or the global execution policy blocking submission.</p></div>
        <div><strong>409 · conflict or already processing</strong><p>Identity assertion mismatch, idempotency conflict, replay, or a request already being processed. Do not generate a new ID to bypass a conflict.</p></div>
        <div><strong>429 · rate limited</strong><p>Read the <code>Retry-After</code> response header before retrying. The current route applies a per-agent request limit.</p></div>
        <div><strong>400 / 401 / 503 / 500</strong><p>Invalid payload, missing or invalid agent credential, authentication/provider/rate-limit infrastructure unavailable, or reservation failure. Inspect the returned error field and retry only when safe.</p></div>
      </div>
      <div className="developer-integration-warning"><strong>Testnet execution warning</strong><p>This endpoint is not a dry run. Once the request passes policy checks, ENCU can submit a real Testnet transfer automatically. Use a controlled test recipient and small amount. A provider request ID or transaction hash alone is not finality; ENCU settles the reservation only after matching execution evidence is reconciled against NEAR finality.</p></div>
    </section>
  );
}
