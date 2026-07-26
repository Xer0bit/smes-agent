export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      brand_assets: {
        Row: {
          asset_type: string
          client_id: string
          created_at: string
          description: string | null
          file_name: string
          file_url: string
          id: string
          revision: number
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          asset_type: string
          client_id: string
          created_at?: string
          description?: string | null
          file_name: string
          file_url: string
          id?: string
          revision?: number
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          asset_type?: string
          client_id?: string
          created_at?: string
          description?: string | null
          file_name?: string
          file_url?: string
          id?: string
          revision?: number
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brand_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_users: {
        Row: {
          client_id: string
          id: string
          user_id: string
        }
        Insert: {
          client_id: string
          id?: string
          user_id: string
        }
        Update: {
          client_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          created_at: string
          id: string
          name: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          status?: string
        }
        Relationships: []
      }
      lead_forms: {
        Row: {
          client_id: string
          created_at: string
          form_name: string
          id: string
          webhook_url: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          form_name: string
          id?: string
          webhook_url?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          form_name?: string
          id?: string
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_forms_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          client_id: string
          created_at: string
          data: Json
          id: string
          lead_form_id: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          data?: Json
          id?: string
          lead_form_id?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          data?: Json
          id?: string
          lead_form_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_lead_form_id_fkey"
            columns: ["lead_form_id"]
            isOneToOne: false
            referencedRelation: "lead_forms"
            referencedColumns: ["id"]
          },
        ]
      }
      press_release_urls: {
        Row: {
          created_at: string
          id: string
          outlet_name: string | null
          press_release_id: string
          total_visits: number
          unique_visits: number
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          outlet_name?: string | null
          press_release_id: string
          total_visits?: number
          unique_visits?: number
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          outlet_name?: string | null
          press_release_id?: string
          total_visits?: number
          unique_visits?: number
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "press_release_urls_press_release_id_fkey"
            columns: ["press_release_id"]
            isOneToOne: false
            referencedRelation: "press_releases"
            referencedColumns: ["id"]
          },
        ]
      }
      press_releases: {
        Row: {
          admin_comment: string | null
          client_id: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          published_url: string | null
          status: Database["public"]["Enums"]["press_status"]
          title: string
          total_visits: number
          unique_visits: number
          updated_at: string
        }
        Insert: {
          admin_comment?: string | null
          client_id: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          published_url?: string | null
          status?: Database["public"]["Enums"]["press_status"]
          title: string
          total_visits?: number
          unique_visits?: number
          updated_at?: string
        }
        Update: {
          admin_comment?: string | null
          client_id?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          published_url?: string | null
          status?: Database["public"]["Enums"]["press_status"]
          title?: string
          total_visits?: number
          unique_visits?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "press_releases_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      social_accounts: {
        Row: {
          account_name: string
          client_id: string | null
          connected_at: string
          id: string
          mcp_tool_name: string | null
          mcp_url: string | null
          page_config: Json | null
          platform: string
          user_id: string
          webhook_url: string | null
        }
        Insert: {
          account_name: string
          client_id?: string | null
          connected_at?: string
          id?: string
          mcp_tool_name?: string | null
          mcp_url?: string | null
          page_config?: Json | null
          platform: string
          user_id: string
          webhook_url?: string | null
        }
        Update: {
          account_name?: string
          client_id?: string | null
          connected_at?: string
          id?: string
          mcp_tool_name?: string | null
          mcp_url?: string | null
          page_config?: Json | null
          platform?: string
          user_id?: string
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      social_media_posts: {
        Row: {
          account_id: string | null
          client_id: string | null
          content: string
          created_at: string | null
          id: string
          media_urls: string[] | null
          platforms: Database["public"]["Enums"]["social_platform"][]
          published_at: string | null
          scheduled_at: string | null
          status: Database["public"]["Enums"]["post_status"]
          updated_at: string | null
          user_id: string
        }
        Insert: {
          account_id?: string | null
          client_id?: string | null
          content: string
          created_at?: string | null
          id?: string
          media_urls?: string[] | null
          platforms?: Database["public"]["Enums"]["social_platform"][]
          published_at?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["post_status"]
          updated_at?: string | null
          user_id: string
        }
        Update: {
          account_id?: string | null
          client_id?: string | null
          content?: string
          created_at?: string | null
          id?: string
          media_urls?: string[] | null
          platforms?: Database["public"]["Enums"]["social_platform"][]
          published_at?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["post_status"]
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_media_posts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_media_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user" | "super_admin"
      post_status: "draft" | "scheduled" | "published" | "failed"
      press_status: "draft" | "submitted" | "published" | "unpublished"
      social_platform:
        | "twitter"
        | "facebook"
        | "instagram"
        | "linkedin"
        | "youtube"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user", "super_admin"],
      post_status: ["draft", "scheduled", "published", "failed"],
      press_status: ["draft", "submitted", "published", "unpublished"],
      social_platform: [
        "twitter",
        "facebook",
        "instagram",
        "linkedin",
        "youtube",
      ],
    },
  },
} as const
