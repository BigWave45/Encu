import { getSupabase } from "@/lib/supabase";

export type DeveloperIdentity = {
  userId: string;
  email: string;
};

export async function authenticateDeveloper(authorization: string | null): Promise<DeveloperIdentity | null> {
  const token = authorization?.match(/^Bearer\\s+(.+)$/i)?.[1]?.trim();
  if (!token || token.length > 8192) return null;

  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data.user || !data.user.email_confirmed_at) return null;

  return {
    userId: data.user.id,
    email: data.user.email ?? ""
  };
}
