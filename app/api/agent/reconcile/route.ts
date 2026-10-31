import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128)
});

// Public NEAR account identifier for the AgentGuard OutLayer testnet wallet.
const signerId = "6d665ad261fc10ce705e4b10d107b9e8f40177266f937c6dff8f5a178126ae6e";

function validToken(expected: string, supplied?: string) {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

type NearTxStatus = {
  status?: {
    SuccessValue?: string;
    SuccessReceiptId?: string;
    Failure?: unknown;
  };
};

export async function POST(request: NextRequest) {
  const expected = process.env.AGENTGUARD_AGENT_TOKEN;
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!expected || !validToken(expected, supplied)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getSupabase();
  const { data: reservation, error } = await db
    .from("spend_reservations")
    .select("request_id,status,outlayer_tx_hash")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "reservation_lookup_failed" }, { status: 500 });
  }
  if (!reservation) {
    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  }
  if (reservation.status === "executed" || reservation.status === "failed") {
    return NextResponse.json({ status: reservation.status, requestId: reservation.request_id });
  }
  if (!reservation.outlayer_tx_hash) {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      reason: "transaction_hash_not_available"
    }, { status: 202 });
  }

  let rpc: { result?: NearTxStatus; error?: { message?: string } };
  try {
    const response = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "agentguard-reconcile",
        method: "EXPERIMENTAL_tx_status",
        params: [reservation.outlayer_tx_hash, signerId]
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return NextResponse.json({ status: "needs_review", requestId: reservation.request_id, reason: "near_rpc_unavailable" }, { status: 202 });
    }
    rpc = await response.json();
  } catch {
    return NextResponse.json({ status: "needs_review", requestId: reservation.request_id, reason: "near_rpc_unavailable" }, { status: 202 });
  }

  const chainStatus = rpc.result?.status;
  let outcome: "executed" | "failed" | null = null;
  if (chainStatus && Object.prototype.hasOwnProperty.call(chainStatus, "Failure")) {
    outcome = "failed";
  } else if (
    chainStatus &&
    (Object.prototype.hasOwnProperty.call(chainStatus, "SuccessValue") ||
      Object.prototype.hasOwnProperty.call(chainStatus, "SuccessReceiptId"))
  ) {
    outcome = "executed";
  }

  if (!outcome) {
    return NextResponse.json({
      status: "needs_review",
      requestId: reservation.request_id,
      reason: "transaction_not_final_or_not_found"
    }, { status: 202 });
  }

  const { data: finished, error: finishError } = await db.rpc("finish_agent_spend", {
    p_request_id: reservation.request_id,
    p_outcome: outcome,
    p_tx_hash: reservation.outlayer_tx_hash,
    p_error: null
  });
  if (finishError) {
    return NextResponse.json({ status: "needs_review", requestId: reservation.request_id, reason: "ledger_finalisation_failed" }, { status: 500 });
  }

  return NextResponse.json({
    status: finished?.status ?? outcome,
    requestId: reservation.request_id,
    txHash: reservation.outlayer_tx_hash
  });
}
