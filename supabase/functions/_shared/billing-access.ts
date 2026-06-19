export async function hasBillingAccess(
  supabaseClient: any,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const { data: rpcAllowed } = await supabaseClient.rpc('is_org_billing_admin', {
    p_org_id: organizationId,
    p_user_id: userId,
  });

  if (rpcAllowed) {
    return true;
  }

  const { data: membership } = await supabaseClient
    .from('org_members')
    .select('role')
    .eq('org_id', organizationId)
    .eq('user_id', userId)
    .in('role', ['owner', 'admin', 'billing_admin'])
    .limit(1)
    .maybeSingle();

  if (membership) {
    return true;
  }

  const { data: organization } = await supabaseClient
    .from('organizations')
    .select('created_by')
    .eq('id', organizationId)
    .eq('created_by', userId)
    .limit(1)
    .maybeSingle();

  return Boolean(organization);
}