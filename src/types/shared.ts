/**
 * Shared Types for Frontend/Backend Consistency
 * 
 * These types should match the database schema and be used consistently
 * across all frontend services and components.
 */

import type { 
  Project as DbProject,
  Organization as DbOrganization,
  Profile as DbProfile,
  Revision as DbRevision,
  Message as DbMessage,
  OrgMember as DbOrgMember,
  Subscription as DbSubscription,
  UsageTracking as DbUsageTracking,
  ProjectStatus,
  ProjectVisibility,
  OrgRole,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/integrations/supabase/types';

// Re-export database types for convenience
export type {
  DbProject,
  DbOrganization,
  DbProfile,
  DbRevision,
  DbMessage,
  DbOrgMember,
  DbSubscription,
  DbUsageTracking,
  ProjectStatus,
  ProjectVisibility,
  OrgRole,
  SubscriptionPlan,
  SubscriptionStatus,
};

// =============================================================================
// PROJECT TYPES
// =============================================================================

/**
 * Full project type matching database schema
 */
export interface Project {
  id: string;
  name: string;
  description?: string | null;
  status: ProjectStatus | null;
  visibility?: ProjectVisibility | null;
  user_id: string | null;
  organization_id: string | null;
  created_by: string | null;
  slug?: string | null;
  message_count: number;
  revision_count: number | null;
  total_storage_bytes: number | null;
  latest_generated_code?: string | null;
  latest_revision_size?: number | null;
  storage_warning_shown?: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Minimal project type for listings
 */
export interface ProjectSummary {
  id: string;
  name: string;
  description?: string | null;
  status: ProjectStatus | null;
  created_at: string | null;
  updated_at: string | null;
  revision_count: number | null;
  message_count: number;
}

/**
 * Project with expanded relations
 */
export interface ProjectWithDetails extends Project {
  organization?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  owner?: {
    id: string;
    email: string;
    full_name: string | null;
  } | null;
  latestRevision?: {
    id: string;
    revision_number: number | null;
    preview_url: string | null;
    created_at: string | null;
  } | null;
}

// =============================================================================
// ORGANIZATION TYPES
// =============================================================================

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string | null;
  plan_tier: string | null;
  subscription_plan: SubscriptionPlan | null;
  seats_total: number | null;
  seats_used: number | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrganizationMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  joined_at: string | null;
  is_client: boolean | null;
  user?: {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

// =============================================================================
// USER TYPES
// =============================================================================

export interface User {
  id: string;
  email: string;
  full_name?: string | null;
  avatar_url?: string | null;
  created_at?: string | null;
}

export interface AuthenticatedUser extends User {
  organization_id?: string | null;
  role?: OrgRole;
}

// =============================================================================
// REVISION TYPES
// =============================================================================

export interface Revision {
  id: string;
  project_id: string;
  prompt: string;
  generated_code?: string | null;
  generated_files?: any | null;
  revision_number: number | null;
  preview_url?: string | null;
  preview_status?: string | null;
  is_published: boolean | null;
  is_active: boolean | null;
  created_by: string | null;
  user_id: string | null;
  created_at: string | null;
}

// =============================================================================
// API RESPONSE TYPES
// =============================================================================

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// =============================================================================
// GENERATION TYPES
// =============================================================================

export interface GeneratedFile {
  path: string;
  content: string;
  type?: string;
  operation?: 'create' | 'update' | 'delete';
}

export interface GenerationResult {
  files: GeneratedFile[];
  summary?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// =============================================================================
// BILLING/USAGE TYPES
// =============================================================================

export interface UsageInfo {
  lines_used: number;
  lines_available: number;
  bonus_lines: number;
  period_start: string;
  period_end: string;
}

export interface SubscriptionInfo {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
}
