import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { transferNear } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128),
  to: z.string().min(2).max(128),
  amountYocto: z.string().regex(/^[0-9]+$/)
});

export async function POST(request: NextRequest) {
  const expectedToken = process.env.AGENTGUARD_AGENT_TOKEN;
  const suppliedToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!expectedToken || suppliedToken !== expectedToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const { requestId, to, amountYocto } = parsed.data;
  const amount = BigInt(amountYocto);
  const maxPerTransfer = BigInt(process.env.AGENTGUARD_MAX_TRANSFER_YOCTO ?? "0");

  if (amount <= 0n || amount > maxPerTransfer) {
    return NextResponse.json({ status: "blocked", reason: "per_transaction_limit" }, { status: 403 });
  }

  const supabase = getSupabase();
  const { data: reservation, error: reserveError } = await supabase.rpc("reserve_agent_spend", {
    p_request_id: requestId,
    p_amount_yocto: amountYocto,
    p_recipient: to
  });

  if (reserveError) {
    return NextResponse.json({ error: "reservation_failed", detail: reserveError.message }, { status: 500 });
  }

  if (reservation?.status === "blocked") {
    return NextResponse.json(reservation, { status: 403 });
  }

  if (reservation?.status !== "reserved") {
    return NextResponse.json({ error: "request_already_processed", reservation }, { status: 409 });
  }

  try {
    const result = await transferNear(to, amountYocto);
    const txHash = typeof result.tx_hash === "string" ? result.tx_hash : null;

    const { error: finishError } = await supabase.rpc("finish_agent_spend", {
      p_request_id: requestId,
      p_success: true,
      p_tx_hash: txHash
    });

    if (finishError) {
      return NextResponse.json({
        status: "executed_reconciliation_required",
        requestId,
        outlayer: result,
        warning: "Transfer was submitted but ledger finalisation failed."
      }, { status: 202 });
    }

    return NextResponse.json({ status: "executed", requestId, outlayer: result });
  } catch (error) {
    await supabase.rpc("finish_agent_spend", {
      p_request_id: requestId,
      p_success: false,
      p_tx_hash: null
    });

    return NextResponse.json({
      status: "failed",
      requestId,
      error: error instanceof Error ? error.message : "OutLayer request failed"
    }, { status: 502 });
  }
}