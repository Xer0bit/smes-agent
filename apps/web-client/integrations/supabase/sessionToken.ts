/**
 * Access token for API calls from either portal. The user app and the admin
 * portal keep separate sessions (different storage keys); services shared
 * by both must not assume the user session exists.
 */
import { lovableCloud } from './client';

export async function anySessionToken(): Promise<string | null> {
  const { data: { session } } = await lovableCloud.auth.getSession();
  if (session?.access_token) return session.access_token;
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
    const { supabase: admin } = await import('./adminClient');
    const { data: { session: adminSession } } = await admin.auth.getSession();
    return adminSession?.access_token ?? null;
  }
  return null;
}
