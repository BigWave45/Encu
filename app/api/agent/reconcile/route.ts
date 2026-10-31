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

type NearTxResult = {
  final_execution_status?: string;
  status?: {
    SuccessValue?: string;
    Failure?: unknown;
    SuccessReceiptId?: string;
  };
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: Array<{
      Transfer?: { deposit?: string };
    }>;
  };
};

type NearRpcResponse = {
  result?: NearTxResult;
  error?: { message?: string; code?: number };
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
    .select("request_id,status,outlayer_tx_hash,recipient,amount_yocto")
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

  let rpc: NearRpcResponse;
  try {
    const response = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "agentguard-reconcile",
        method: "tx",
        params: {
          tx_hash: reservation.outlayer_tx_hash,
          sender_account_id: signerId,
          wait_until: "FINAL"
        }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });

    rpc = await response.json().catch(() => ({}));
    if (!response.ok || rpc.error || !rpc.result) {
      return NextResponse.json({
        status: "needs_review",
        requestId: reservation.request_id,
        reason: "near_rpc_unavailable_or_transaction_not_found"
      }, { status: 202 });
    }
  } catch {
    return NextResponse.json({
      status: "needs_review",
      requestId: reservation.request_id,
      reason: "near_rpc_unavailable"
    }, { status: 202 });
  }

  const result = rpc.result;
  const transferMatches =
    result.final_execution_status === "FINAL" &&
    result.transaction?.signer_id === signerId &&
    result.transaction?.receiver_id === reservation.recipient &&
    Array.isArray(result.transaction?.actions) &&
    result.transaction.actions.some(
      (action) => action.Transfer?.deposit === String(reservation.amount_yocto)
    );

  if (!transferMatches) {
    return NextResponse.json({
      status: "needs_review",
      requestId: reservation.request_id,
      reason: "final_transaction_does_not_match_reserved_transfer"
    }, { status: 202 });
  }

  const chainStatus = result.status;
  let outcome: "executed" | "failed" | null = null;

  // Only settle after NEAR reports FINAL. SuccessReceiptId is deliberately
  // not accepted: it can indicate that downstream receipt execution remains.
  if (chainStatus && Object.prototype.hasOwnProperty.call(chainStatus, "Failure")) {
    outcome = "failed";
  } else if (chainStatus && Object.prototype.hasOwnProperty.call(chainStatus, "SuccessValue")) {
    outcome = "executed";
  }

  if (!outcome) {
    return NextResponse.json({
      status: "needs_review",
      requestId: reservation.request_id,
      reason: "final_execution_status_unrecognised"
    }, { status: 202 });
  }

  const { data: finished, error: finishError } = await db.rpc("finish_agent_spend", {
    p_request_id: reservation.request_id,
    p_outcome: outcome,
    p_tx_hash: reservation.outlayer_tx_hash,
    p_error: null
  });

  if (finishError) {
    return NextResponse.json({
      status: "needs_review",
      requestId: reservation.request_id,
      reason: "ledger_finalisation_failed"
    }, { status: 500 });
  }

  return NextResponse.json({
    status: finished?.status ?? outcome,
    requestId: reservation.request_id,
    txHash: reservation.outlayer_tx_hash,
    finality: "FINAL"
  });
}
