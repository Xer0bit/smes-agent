import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

interface WorkspaceOrganization {
  id: string;
  name: string;
  slug: string;
  avatar_url?: string | null;
}

interface OrganizationContextType {
  currentOrganizationId: string | null;
  setCurrentOrganizationId: (id: string | null) => void;
  currentOrganization: WorkspaceOrganization | null;
  organizations: WorkspaceOrganization[];
  loadingOrganizations: boolean;
  refreshOrganization: (user: User | null, preferredOrganizationId?: string | null) => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

const storageKey = (userId: string) => `ecomgear.currentOrganizationId.${userId}`;

export const OrganizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentOrganizationId, setCurrentOrganizationIdState] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<WorkspaceOrganization[]>([]);
  const [loadingOrganizations, setLoadingOrganizations] = useState(true);

  // Ref holding the current user id so setCurrentOrganizationId always reads
  // the latest value, even from a stale closure (UI switch during refresh).
  const currentUserIdRef = useRef<string | null>(null);

  const setCurrentOrganizationId = useCallback((id: string | null, userId?: string | null) => {
    setCurrentOrganizationIdState(id);

    const uid = userId ?? currentUserIdRef.current;
    if (!uid) return;
    try {
      if (id) {
        localStorage.setItem(storageKey(uid), id);
      } else {
        localStorage.removeItem(storageKey(uid));
      }
    } catch {
      // Ignore storage errors in private mode or tests.
    }
  }, []);

  const loadAccessibleOrganizations = useCallback(async (user: User) => {
    const [{ data: createdOrgs, error: createdError }, { data: memberRows, error: memberError }, { data: accessibleProjects, error: projectsError }] = await Promise.all([
      supabase
        .from('organizations')
        .select('id, name, slug, avatar_url')
        .eq('created_by', user.id),
      supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id),
      supabase
        .from('projects')
        .select('organization_id')
        .eq('user_id', user.id)
        .not('organization_id', 'is', null),
    ]);

    if (createdError) {
      console.warn('loadAccessibleOrganizations created orgs error:', createdError.message);
    }

    if (memberError) {
      console.warn('loadAccessibleOrganizations membership error:', memberError.message);
    }

    if (projectsError) {
      console.warn('loadAccessibleOrganizations projects error:', projectsError.message);
    }

    const orgIds = new Set<string>();
    (createdOrgs || []).forEach((org) => orgIds.add(org.id));
    (memberRows || []).forEach((row) => {
      if (row.org_id) orgIds.add(row.org_id);
    });
    (accessibleProjects || []).forEach((project) => {
      if (project.organization_id) orgIds.add(project.organization_id);
    });

    if (orgIds.size === 0) {
      return [] as WorkspaceOrganization[];
    }

    const { data: orgRows, error: orgsError } = await supabase
      .from('organizations')
      .select('id, name, slug, avatar_url')
      .in('id', Array.from(orgIds));

    if (orgsError) {
      console.warn('loadAccessibleOrganizations organizations lookup error:', orgsError.message);
      return [] as WorkspaceOrganization[];
    }

    return (orgRows || []).sort((left, right) => left.name.localeCompare(right.name));
  }, []);

  const refreshOrganization = useCallback(async (user: User | null, preferredOrganizationId?: string | null) => {
    setLoadingOrganizations(true);

    if (!user) {
      setOrganizations([]);
      setCurrentOrganizationId(null);
      setLoadingOrganizations(false);
      return;
    }

    try {
      const accessibleOrganizations = await loadAccessibleOrganizations(user);
      setOrganizations(accessibleOrganizations);

      currentUserIdRef.current = user.id;
      let storedOrganizationId: string | null = null;
      try {
        storedOrganizationId = localStorage.getItem(storageKey(user.id));
      } catch {
        storedOrganizationId = null;
      }

      const nextOrganizationId = preferredOrganizationId
        || currentOrganizationId
        || storedOrganizationId
        || accessibleOrganizations[0]?.id
        || null;

      const validatedOrganizationId = accessibleOrganizations.some((org) => org.id === nextOrganizationId)
        ? nextOrganizationId
        : accessibleOrganizations[0]?.id || null;

      // Pass user.id explicitly   currentUserId state may not have updated yet
      setCurrentOrganizationId(validatedOrganizationId, user.id);
    } catch (e) {
      console.warn('refreshOrganization exception', e);
      setOrganizations([]);
      setCurrentOrganizationId(null);
    } finally {
      setLoadingOrganizations(false);
    }
  }, [currentOrganizationId, loadAccessibleOrganizations, setCurrentOrganizationId]);

  const currentOrganization = organizations.find((org) => org.id === currentOrganizationId) || null;

  return (
    <OrganizationContext.Provider 
      value={{ 
        currentOrganizationId, 
        setCurrentOrganizationId,
        currentOrganization,
        organizations,
        loadingOrganizations,
        refreshOrganization 
      }}
    >
      {children}
    </OrganizationContext.Provider>
  );
};

export const useOrganization = () => {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
};
