import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let identity;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const baseUrl = process.env.OUTLAYER_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.OUTLAYER_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json({ error: "outlayer_not_configured" }, { status: 503 });
  }

  try {
    const response = await fetch(`${baseUrl}/wallet/v1/balance?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });

    if (response.status === 401 || response.status === 403) {
      return NextResponse.json({ error: "outlayer_authentication_failed" }, { status: 502 });
    }
    if (!response.ok) {
      return NextResponse.json({
        error: "outlayer_balance_request_failed",
        providerStatus: response.status
      }, { status: 502 });
    }

    const balance = await response.json().catch(() => null);
    if (balance === null || typeof balance !== "object") {
      return NextResponse.json({ error: "invalid_outlayer_balance_response" }, { status: 502 });
    }

    return NextResponse.json({ status: "ok", chain: "near", balance });
  } catch {
    return NextResponse.json({ error: "outlayer_unavailable" }, { status: 503 });
  }
}
