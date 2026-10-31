import { createHash, timingSafeEqual } from "node:crypto";
import { getSupabase } from "@/lib/supabase";

export type AgentIdentity = { agentId: string; isAdmin: boolean };

function safeEqual(expected: string, supplied: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateAgent(authorization: string | null): Promise<AgentIdentity | null> {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  if (!supplied) return null;
  const primaryToken = process.env.AGENTGUARD_AGENT_TOKEN;
  if (primaryToken && safeEqual(primaryToken, supplied)) return { agentId: "primary", isAdmin: true };
  const tokenHash = createHash("sha256").update(supplied).digest("hex");
  const db = getSupabase();
  const { data, error } = await db.from("agents").select("id").eq("token_hash", tokenHash).eq("active", true).maybeSingle();
  if (error || !data) return null;
  return { agentId: data.id, isAdmin: false };
}