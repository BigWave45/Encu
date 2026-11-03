import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateDeveloper } from "@/lib/developer-auth";
import { getSupabase } from "@/lib/supabase";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/) });

export async function POST(request: NextRequest) {
  let identity;
  try { identity = await authenticateDeveloper(request.headers.get("authorization")); }
  catch { return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 }); }
  if (!identity) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const limited = await consumeRateLimit(`developer:${identity.userId}`, "agent_credential_rotate", 5, 60);
  if (!limited) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!limited.allowed) return NextResponse.json({ error: "rate_limit_exceeded", retryAfterSeconds: limited.retryAfterSeconds }, { status: 429 });

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await getSupabase().rpc("rotate_developer_agent_credential", {
    p_owner_user_id: identity.userId,
    p_agent_id: parsed.data.id,
    p_token_hash: tokenHash
  });
  if (error) {
    const status = (error.message ?? "").includes("developer_agent_not_found_or_inactive") ? 404 : 500;
    return NextResponse.json({ error: status === 404 ? "agent_not_found_or_inactive" : "agent_credential_rotation_failed" }, { status });
  }

  return NextResponse.json({
    status: "rotated",
    agent: { id: data.id, name: data.name },
    token,
    warning: "The previous token is invalid. Copy this replacement now; it cannot be retrieved again."
  }, { headers: { "Cache-Control": "no-store, private" } });
}
