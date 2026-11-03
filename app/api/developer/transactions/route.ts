import { NextRequest, NextResponse } from "next/server";
import { authenticateDeveloper } from "@/lib/developer-auth";
import { getSupabase } from "@/lib/supabase";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let identity;
  try {
    identity = await authenticateDeveloper(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });

  const rate = await consumeRateLimit(`developer:${identity.userId}`, "transaction_activity_read", 60, 60);
  if (!rate) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "rate_limit_exceeded", retryAfterSeconds: rate.retryAfterSeconds }, { status: 429 });

  const db = getSupabase();
  const { data: ownedAgents, error: agentsError } = await db.from("agents")
    .select("id")
    .eq("owner_user_id", identity.userId);
  if (agentsError) return NextResponse.json({ error: "developer_transactions_read_failed" }, { status: 503 });

  const ids = (ownedAgents ?? []).map(agent => agent.id);
  if (!ids.length) return NextResponse.json({ transactions: [] }, { headers: { "Cache-Control": "no-store, private" } });

  const { data, error } = await db.from("spend_reservations")
    .select("request_id,agent_id,recipient,amount_yocto,status,outlayer_tx_hash,outlayer_request_id,last_error,created_at,updated_at")
    .in("agent_id", ids)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: "developer_transactions_read_failed" }, { status: 503 });
  return NextResponse.json({
    transactions: (data ?? []).map(item => ({
      requestId: item.request_id,
      agentId: item.agent_id,
      recipient: item.recipient,
      amountYocto: String(item.amount_yocto),
      status: item.status,
      txHash: item.outlayer_tx_hash,
      providerRequestId: item.outlayer_request_id,
      lastError: item.last_error,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }))
  }, { headers: { "Cache-Control": "no-store, private" } });
}
