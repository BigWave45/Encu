import { NextRequest, NextResponse } from "next/server";
import { agentRateLimitResponse } from "@/lib/agent-rate-limit";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { authenticateAgent } from "@/lib/agent-auth";
import { getNearRpcUrl, getOutLayerConfig } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128)
});



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
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limited = await agentRateLimitResponse(identity.agentId, "near_finality_reconciliation", 10, 60);
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let signerId: string;
  let rpcUrl: string;
  try {
    const outlayer = getOutLayerConfig();
    signerId = outlayer.nearAddress;
    rpcUrl = getNearRpcUrl();
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "testnet_configuration_invalid"
    }, { status: 503 });
  }

  const db = getSupabase();
  const { data: reservation, error } = await db
    .from("spend_reservations")
    .select("request_id,status,outlayer_tx_hash,outlayer_request_id,recipient,amount_yocto,agent_id")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "reservation_lookup_failed" }, { status: 500 });
  }
  if (!reservation) {
    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  }
  if (!identity.isAdmin && reservation.agent_id !== identity.agentId) {
    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  }
  if (reservation.status === "executed" || reservation.status === "failed") {
    return NextResponse.json({ status: reservation.status, requestId: reservation.request_id });
  }
  if (!reservation.outlayer_tx_hash) {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      providerRequestId: reservation.outlayer_request_id,
      reason: reservation.outlayer_request_id ? "provider_request_pending_chain_hash" : "transaction_hash_not_available"
    }, { status: 202 });
  }

  let rpc: NearRpcResponse;
  try {
    const response = await fetch(rpcUrl, {
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
    result.transaction.actions.length === 1 &&
    result.transaction.actions[0].Transfer?.deposit === String(reservation.amount_yocto);

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
