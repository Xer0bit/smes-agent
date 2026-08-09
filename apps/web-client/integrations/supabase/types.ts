export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// =============================================================================
// ENUM TYPES (matching database)
// =============================================================================
export type AppRole = 'super_admin' | 'admin' | 'user'
export type OrgMemberRole = 'owner' | 'admin' | 'member'
export type ProjectStatus = 'active' | 'suspended' | 'deleted'
export type OrgStatus = 'active' | 'suspended'
export type AccountStatus = 'active' | 'suspended' | 'pending_verification' | 'deletion_pending'
export type RegionType = 'global' | 'cn'
export type PlanTier = 'free' | 'pro' | 'agency' | 'starter' | 'professional' | 'enterprise'
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'
export type ProjectVisibility = 'org_all' | 'org_restricted' | 'org_wide' | 'restricted'
export type ProjectMemberRole = 'editor' | 'viewer' | 'client'
export type OrgRole = 'admin' | 'billing_admin' | 'member'
export type SubscriptionPlan = 'free' | 'pro' | 'agency'
export type OrganizationMode = 'standard' | 'agency'
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
export type UsageType = 'revision_lines' | 'ai_agent_calls' | 'hosting_bandwidth' | 'storage'
export type InvoiceStatus = 'draft' | 'pending' | 'paid' | 'overdue' | 'canceled'
export type BillingType = 'recurring' | 'one_time'
export type AddOnStatus = 'active' | 'cancelled' | 'pending'
export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type DomainStatus = 'pending_dns' | 'verifying' | 'active' | 'failed' | 'inactive'

// =============================================================================
// DATABASE TYPE
// =============================================================================
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          created_at: string | null
          updated_at: string | null
          phone: string | null
          avatar_url: string | null
          account_status: AccountStatus | null
          is_mfa_enabled: boolean | null
          preferred_language: string | null
          region: RegionType | null
          last_login_at: string | null
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          created_at?: string | null
          updated_at?: string | null
          phone?: string | null
          avatar_url?: string | null
          account_status?: AccountStatus | null
          is_mfa_enabled?: boolean | null
          preferred_language?: string | null
          region?: RegionType | null
          last_login_at?: string | null
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          created_at?: string | null
          updated_at?: string | null
          phone?: string | null
          avatar_url?: string | null
          account_status?: AccountStatus | null
          is_mfa_enabled?: boolean | null
          preferred_language?: string | null
          region?: RegionType | null
          last_login_at?: string | null
        }
        Relationships: []
      }
      organizations: {
        Row: {
          id: string
          name: string
          status: string | null
          created_at: string | null
          updated_at: string | null
          slug: string
          avatar_url: string | null
          region: RegionType | null
          plan_tier: PlanTier | null
          seats_total: number | null
          seats_used: number | null
          security_policy: Json | null
          sso_config: Json | null
          created_by: string | null
          mode: OrganizationMode | null
          subscription_plan: SubscriptionPlan | null
          stripe_customer_id: string | null
          stripe_connect_account_id: string | null
          stripe_connect_onboarded: boolean | null
          billing_email: string | null
          billing_address: Json | null
        }
        Insert: {
          id?: string
          name: string
          status?: string | null
          created_at?: string | null
          updated_at?: string | null
          slug: string
          avatar_url?: string | null
          region?: RegionType | null
          plan_tier?: PlanTier | null
          seats_total?: number | null
          seats_used?: number | null
          security_policy?: Json | null
          sso_config?: Json | null
          created_by?: string | null
          mode?: OrganizationMode | null
          subscription_plan?: SubscriptionPlan | null
          stripe_customer_id?: string | null
          stripe_connect_account_id?: string | null
          stripe_connect_onboarded?: boolean | null
          billing_email?: string | null
          billing_address?: Json | null
        }
        Update: {
          id?: string
          name?: string
          status?: string | null
          created_at?: string | null
          updated_at?: string | null
          slug?: string
          avatar_url?: string | null
          region?: RegionType | null
          plan_tier?: PlanTier | null
          seats_total?: number | null
          seats_used?: number | null
          security_policy?: Json | null
          sso_config?: Json | null
          created_by?: string | null
          mode?: OrganizationMode | null
          subscription_plan?: SubscriptionPlan | null
          stripe_customer_id?: string | null
          stripe_connect_account_id?: string | null
          stripe_connect_onboarded?: boolean | null
          billing_email?: string | null
          billing_address?: Json | null
        }
        Relationships: []
      }
      projects: {
        Row: {
          id: string
          name: string
          status: ProjectStatus | null
          created_at: string | null
          updated_at: string | null
          organization_id: string | null
          slug: string | null
          description: string | null
          visibility: ProjectVisibility | null
          created_by: string | null
          message_count: number
          latest_generated_code: string | null
          user_id: string | null
          total_storage_bytes: number | null
          revision_count: number | null
          latest_revision_size: number | null
          storage_warning_shown: boolean | null
        }
        Insert: {
          id?: string
          name: string
          status?: ProjectStatus | null
          created_at?: string | null
          updated_at?: string | null
          organization_id?: string | null
          slug?: string | null
          description?: string | null
          visibility?: ProjectVisibility | null
          created_by?: string | null
          message_count?: number
          latest_generated_code?: string | null
          user_id?: string | null
          total_storage_bytes?: number | null
          revision_count?: number | null
          latest_revision_size?: number | null
          storage_warning_shown?: boolean | null
        }
        Update: {
          id?: string
          name?: string
          status?: ProjectStatus | null
          created_at?: string | null
          updated_at?: string | null
          organization_id?: string | null
          slug?: string | null
          description?: string | null
          visibility?: ProjectVisibility | null
          created_by?: string | null
          message_count?: number
          latest_generated_code?: string | null
          user_id?: string | null
          total_storage_bytes?: number | null
          revision_count?: number | null
          latest_revision_size?: number | null
          storage_warning_shown?: boolean | null
        }
        Relationships: []
      }
      revisions: {
        Row: {
          id: string
          project_id: string
          prompt: string
          generated_code: string | null
          created_at: string | null
          revision_number: number | null
          git_commit_hash: string | null
          git_branch: string | null
          is_published: boolean | null
          is_active: boolean | null
          created_by: string | null
          generated_files: Json | null
          user_id: string | null
          preview_url: string | null
          preview_status: string | null
        }
        Insert: {
          id?: string
          project_id: string
          prompt: string
          generated_code?: string | null
          created_at?: string | null
          revision_number?: number | null
          git_commit_hash?: string | null
          git_branch?: string | null
          is_published?: boolean | null
          is_active?: boolean | null
          created_by?: string | null
          generated_files?: Json | null
          user_id?: string | null
          preview_url?: string | null
          preview_status?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          prompt?: string
          generated_code?: string | null
          created_at?: string | null
          revision_number?: number | null
          git_commit_hash?: string | null
          git_branch?: string | null
          is_published?: boolean | null
          is_active?: boolean | null
          created_by?: string | null
          generated_files?: Json | null
          user_id?: string | null
          preview_url?: string | null
          preview_status?: string | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          project_id: string
          role: string
          content: string
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          role: string
          content: string
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          role?: string
          content?: string
          created_at?: string
        }
        Relationships: []
      }
      org_members: {
        Row: {
          id: string
          org_id: string
          user_id: string
          role: OrgRole
          joined_at: string | null
          created_at: string | null
          is_client: boolean | null
          client_billing_enabled: boolean | null
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          role?: OrgRole
          joined_at?: string | null
          created_at?: string | null
          is_client?: boolean | null
          client_billing_enabled?: boolean | null
        }
        Update: {
          id?: string
          org_id?: string
          user_id?: string
          role?: OrgRole
          joined_at?: string | null
          created_at?: string | null
          is_client?: boolean | null
          client_billing_enabled?: boolean | null
        }
        Relationships: []
      }
      ai_agents: {
        Row: {
          id: string
          user_id: string
          name: string
          description: string | null
          job_description: string | null
          agent_photo_url: string | null
          original_prompt: string | null
          workflow_data: Json | null
          status: string | null
          created_at: string | null
          updated_at: string | null
          about: string | null
          current_task: string | null
          is_active: boolean | null
          connected_integrations: Json | null
          project_id: string | null
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          description?: string | null
          job_description?: string | null
          agent_photo_url?: string | null
          original_prompt?: string | null
          workflow_data?: Json | null
          status?: string | null
          created_at?: string | null
          updated_at?: string | null
          about?: string | null
          current_task?: string | null
          is_active?: boolean | null
          connected_integrations?: Json | null
          project_id?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          description?: string | null
          job_description?: string | null
          agent_photo_url?: string | null
          original_prompt?: string | null
          workflow_data?: Json | null
          status?: string | null
          created_at?: string | null
          updated_at?: string | null
          about?: string | null
          current_task?: string | null
          is_active?: boolean | null
          connected_integrations?: Json | null
          project_id?: string | null
        }
        Relationships: []
      }
      project_members: {
        Row: {
          id: string
          project_id: string
          user_id: string
          role: ProjectMemberRole | null
          joined_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          user_id: string
          role?: ProjectMemberRole | null
          joined_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          role?: ProjectMemberRole | null
          joined_at?: string | null
        }
        Relationships: []
      }
      project_member_access: {
        Row: {
          id: string
          project_id: string
          user_id: string
          granted_by: string | null
          granted_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          user_id: string
          granted_by?: string | null
          granted_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          granted_by?: string | null
          granted_at?: string | null
        }
        Relationships: []
      }
      org_invitations: {
        Row: {
          id: string
          org_id: string
          email: string
          role: OrgRole
          status: 'pending' | 'accepted' | 'declined' | 'expired'
          token: string
          invited_by: string | null
          expires_at: string
          created_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          email: string
          role?: OrgRole
          status?: 'pending' | 'accepted' | 'declined' | 'expired'
          token?: string
          invited_by?: string | null
          expires_at: string
          created_at?: string | null
        }
        Update: {
          id?: string
          org_id?: string
          email?: string
          role?: OrgRole
          status?: 'pending' | 'accepted' | 'declined' | 'expired'
          token?: string
          invited_by?: string | null
          expires_at?: string
          created_at?: string | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          id: string
          org_id: string
          plan: SubscriptionPlan
          status: SubscriptionStatus
          is_annual: boolean | null
          stripe_subscription_id: string | null
          stripe_price_id: string | null
          current_period_start: string | null
          current_period_end: string | null
          cancel_at_period_end: boolean | null
          canceled_at: string | null
          trial_start: string | null
          trial_end: string | null
          metadata: Json | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          plan?: SubscriptionPlan
          status?: SubscriptionStatus
          is_annual?: boolean | null
          stripe_subscription_id?: string | null
          stripe_price_id?: string | null
          current_period_start?: string | null
          current_period_end?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          trial_start?: string | null
          trial_end?: string | null
          metadata?: Json | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          org_id?: string
          plan?: SubscriptionPlan
          status?: SubscriptionStatus
          is_annual?: boolean | null
          stripe_subscription_id?: string | null
          stripe_price_id?: string | null
          current_period_start?: string | null
          current_period_end?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          trial_start?: string | null
          trial_end?: string | null
          metadata?: Json | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      usage_tracking: {
        Row: {
          id: string
          user_id: string | null
          org_id: string
          lines_used: number | null
          period_start: string
          period_end: string
          created_at: string | null
          updated_at: string | null
          lines_available: number
          bonus_lines: number
        }
        Insert: {
          id?: string
          user_id?: string | null
          org_id: string
          lines_used?: number | null
          period_start?: string
          period_end: string
          created_at?: string | null
          updated_at?: string | null
          lines_available?: number
          bonus_lines?: number
        }
        Update: {
          id?: string
          user_id?: string | null
          org_id?: string
          lines_used?: number | null
          period_start?: string
          period_end?: string
          created_at?: string | null
          updated_at?: string | null
          lines_available?: number
          bonus_lines?: number
        }
        Relationships: []
      }
      published_versions: {
        Row: {
          id: string
          project_id: string
          revision_id: string
          version_tag: string
          git_tag: string | null
          git_commit_hash: string | null
          deployment_url: string | null
          deployed_by: string | null
          status: string | null
          published_at: string
        }
        Insert: {
          id?: string
          project_id: string
          revision_id: string
          version_tag: string
          git_tag?: string | null
          git_commit_hash?: string | null
          deployment_url?: string | null
          deployed_by?: string | null
          status?: string | null
          published_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          revision_id?: string
          version_tag?: string
          git_tag?: string | null
          git_commit_hash?: string | null
          deployment_url?: string | null
          deployed_by?: string | null
          status?: string | null
          published_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_project_access: {
        Args: {
          project_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: AppRole
      org_member_role: OrgMemberRole
      project_status: ProjectStatus
      org_status: OrgStatus
      account_status: AccountStatus
      region_type: RegionType
      plan_tier: PlanTier
      invitation_status: InvitationStatus
      project_visibility: ProjectVisibility
      project_member_role: ProjectMemberRole
      org_role: OrgRole
      subscription_plan: SubscriptionPlan
      organization_mode: OrganizationMode
      subscription_status: SubscriptionStatus
      usage_type: UsageType
      invoice_status: InvoiceStatus
      billing_type: BillingType
      add_on_status: AddOnStatus
      payout_status: PayoutStatus
      domain_status: DomainStatus
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

// =============================================================================
// HELPER TYPES
// =============================================================================
type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update']
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T]

// =============================================================================
// CONVENIENCE TYPE ALIASES
// =============================================================================
export type Profile = Tables<'profiles'>
export type Organization = Tables<'organizations'>
export type Project = Tables<'projects'>
export type Revision = Tables<'revisions'>
export type Message = Tables<'messages'>
export type OrgMember = Tables<'org_members'>
export type AIAgent = Tables<'ai_agents'>
export type ProjectMember = Tables<'project_members'>
export type ProjectMemberAccess = Tables<'project_member_access'>
export type OrgInvitation = Tables<'org_invitations'>
export type Subscription = Tables<'subscriptions'>
export type UsageTracking = Tables<'usage_tracking'>
export type PublishedVersion = Tables<'published_versions'>

export const Constants = {
  public: {
    Enums: {
      app_role: ['super_admin', 'admin', 'user'] as const,
      project_status: ['active', 'suspended', 'deleted'] as const,
      org_role: ['admin', 'billing_admin', 'member'] as const,
      subscription_plan: ['free', 'pro', 'agency'] as const,
      subscription_status: ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'] as const,
    },
  },
} as const
