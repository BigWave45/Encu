import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/)
}).refine((value) => value.id !== "primary", {
  message: "The primary admin identity cannot be rotated through this endpoint."
});

export async function POST(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const limited = await adminRateLimitResponse(identity.agentId, "agent_credential_rotation", 10, 60);
  if (limited) return limited;

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await getSupabase().rpc("rotate_agent_credential", {
    p_agent_id: parsed.data.id,
    p_token_hash: tokenHash,
    p_actor_agent_id: identity.agentId
  });

  if (error) {
    const status = error.message.includes("active_agent_not_found") ? 404 : 500;
    return NextResponse.json({ error: "agent_rotation_failed" }, { status });
  }

  return NextResponse.json({
    status: "rotated",
    agent: { id: data.id, name: data.name },
    token,
    warning: "The previous credential is invalid. Copy this replacement now; it cannot be retrieved again."
  }, { status: 200 });
}
