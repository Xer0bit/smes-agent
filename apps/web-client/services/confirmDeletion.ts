import { supabase } from '@/integrations/supabase/client';

/**
 * Confirm a row is actually gone before telling the user it was deleted.
 *
 * PostgREST does not error when a DELETE matches zero rows. `.delete().eq(...)`
 * returns `{ error: null }` whether it removed the row, was blocked by RLS, or
 * matched nothing at all. Every admin delete treated that as success, so the
 * list refreshed, the row was still there, and the toast still said "deleted".
 *
 * The same shape bit us through an edge function: admin-delete-user returns
 * `{ success: true }`, the UI trusted it, and an account that was reported
 * deleted was still signing in days later. The function turned out to be
 * correct; nothing had ever checked.
 *
 * So the rule is: a destructive action is not done because the call returned
 * without an error. It is done when the row is gone and we looked.
 */

/** Thrown when the row survived the delete. Message is user-facing. */
export class DeletionNotConfirmedError extends Error {
  constructor(public readonly table: string, public readonly id: string) {
    super(
      'The delete did not take effect — the record is still there. ' +
      'This usually means a permission rule blocked it. Nothing was changed.',
    );
    this.name = 'DeletionNotConfirmedError';
  }
}

/**
 * Re-query the row and throw if it still exists.
 *
 * A failed *verification* is deliberately not treated as a failed deletion: if
 * the read itself errors we cannot tell the two apart, and claiming the delete
 * failed would be as wrong as claiming it succeeded. Callers get `'unverified'`
 * and should say so rather than assert either outcome.
 */
export async function confirmRowDeleted(
  table: string,
  id: string,
  idColumn = 'id',
): Promise<'gone' | 'unverified'> {
  const { data, error } = await supabase
    .from(table)
    .select(idColumn)
    .eq(idColumn, id)
    .maybeSingle();

  if (error) return 'unverified';
  if (data) throw new DeletionNotConfirmedError(table, id);
  return 'gone';
}
