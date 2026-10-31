import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { transferNear } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128),
  to: z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/),
  amountYocto: z.string().regex(/^[1-9][0-9]*$/)
});

function validToken(expected: string, supplied?: string) {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a,b);
}

export async function POST(request: NextRequest) {
  const expected = process.env.AGENTGUARD_AGENT_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  if (!expected || !validToken(expected,supplied)) {
    return NextResponse.json({error:"unauthorized"},{status:401});
  }

  const parsed = schema.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) {
    return NextResponse.json({error:"invalid_request",details:parsed.error.flatten()},{status:400});
  }

  const {requestId,to,amountYocto} = parsed.data;
  const amount = BigInt(amountYocto);
  const cap = BigInt(process.env.AGENTGUARD_MAX_TRANSFER_YOCTO ?? "0");
  if (cap <= 0n || amount > cap) {
    return NextResponse.json({status:"blocked",reason:"per_transaction_limit"},{status:403});
  }

  const db = getSupabase();
  const {data: reservation,error} = await db.rpc("reserve_agent_spend",{
    p_request_id:requestId,p_amount_yocto:amountYocto,p_recipient:to
  });
  if (error) {
    const conflict = error.message.includes("idempotency_key_conflict");
    return NextResponse.json({error:conflict?"idempotency_key_conflict":"reservation_failed"},
      {status:conflict?409:500});
  }
  if (reservation?.status==="blocked") return NextResponse.json(reservation,{status:403});

  // A replay must never call OutLayer. Only the insert winner gets created=true.
  if (reservation?.created !== true) {
    return NextResponse.json({status:reservation?.status ?? "already_processed",requestId},{status:409});
  }

  let outcome:"executed"|"failed"|"needs_review" = "needs_review";
  let txHash:string|null = null;
  let providerRequestId:string|null = null;
  let reason = "outlayer_response_unknown";

  try {
    const result = await transferNear(to,amountYocto);
    txHash = typeof result.body.tx_hash==="string" ? result.body.tx_hash : null;
    providerRequestId = typeof result.body.request_id==="string"
      ? result.body.request_id
      : typeof result.body.requestId==="string"
        ? result.body.requestId
        : null;

    if (providerRequestId) {
      const { error: referenceError } = await db
        .from("spend_reservations")
        .update({ outlayer_request_id: providerRequestId })
        .eq("request_id", requestId);
      if (referenceError) {
        reason = "provider_request_reference_persistence_failed";
      }
    }

    if (providerRequestId && reason === "provider_request_reference_persistence_failed") {
      outcome="needs_review";
    } else if (result.httpStatus>=200 && result.httpStatus<300 && txHash) {
      // A provider response containing a transaction hash proves submission,
      // not necessarily on-chain finality. Keep the reservation held until
      // the transaction is independently confirmed.
      outcome="needs_review";
      reason="awaiting_onchain_confirmation";
    } else if (result.httpStatus===422 && result.body.error==="onchain_tx_failed" && txHash) {
      // OutLayer confirms the transaction was broadcast. Do not release the
      // reservation until NEAR finality independently confirms the failure.
      outcome="needs_review";
      reason="awaiting_onchain_confirmation_after_provider_revert";
    } else if (result.httpStatus>=200 && result.httpStatus<300 && providerRequestId) {
      // A request ID is not documented as an async result for native NEAR
      // transfers. Preserve the reservation and require manual review.
      outcome="needs_review";
      reason="unverified_native_transfer_response";

    } else {
      reason=`unclassified_outlayer_response_${result.httpStatus}`;
    }
  } catch {
    // Network timeout is ambiguous: do not release budget or automatically retry.
    reason="outlayer_timeout_or_connection_error";
  }

  const {error:finishError} = await db.rpc("finish_agent_spend",{
    p_request_id:requestId,p_outcome:outcome,p_tx_hash:txHash,p_error:reason||null
  });
  if (finishError) {
    return NextResponse.json({status:"needs_review",requestId,txHash,providerRequestId,reason:"ledger_finalisation_failed"},{status:202});
  }
  if (outcome==="needs_review") {
    return NextResponse.json({status:outcome,requestId,txHash,providerRequestId,reason},{status:202});
  }
  if (outcome==="failed") {
    return NextResponse.json({status:outcome,requestId,txHash,providerRequestId,reason},{status:422});
  }
  return NextResponse.json({status:outcome,requestId,txHash,providerRequestId});
}