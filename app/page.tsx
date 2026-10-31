export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24, fontFamily: "Arial, sans-serif" }}>
      <p style={{ color: "#64748b", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>NEAR · Agent Security</p>
      <h1 style={{ fontSize: 44, marginBottom: 12 }}>AgentGuard</h1>
      <p style={{ color: "#475569", fontSize: 18, lineHeight: 1.6 }}>
        A transaction control gateway for AI agents. Requests are reserved against a shared spending budget before they reach custody.
      </p>
      <section style={{ marginTop: 40, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
        <strong>Development status</strong>
        <p style={{ color: "#64748b", lineHeight: 1.6 }}>
          Policy gateway scaffold created. Connect Supabase and OutLayer testnet credentials to run the first live transfer test.
        </p>
        <code style={{ background: "#f1f5f9", padding: "6px 8px", borderRadius: 6 }}>POST /api/agent/transfer</code>
      </section>
    </main>
  );
}