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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      build_logs: {
        Row: {
          at: string
          build_id: string
          chunk: string
          id: number
        }
        Insert: {
          at?: string
          build_id: string
          chunk: string
          id?: number
        }
        Update: {
          at?: string
          build_id?: string
          chunk?: string
          id?: number
        }
        Relationships: [
          {
            foreignKeyName: "build_logs_build_id_fkey"
            columns: ["build_id"]
            isOneToOne: false
            referencedRelation: "builds"
            referencedColumns: ["id"]
          },
        ]
      }
      builds: {
        Row: {
          app_name: string | null
          artifact_kind: string | null
          artifact_path: string | null
          branch: string | null
          bundle_id: string | null
          codemagic_build_id: string | null
          created_at: string
          diagnostic_token: string | null
          diagnostics: Json | null
          error_category: string | null
          error_retriable: boolean | null
          error_summary: string | null
          github_run_id: number | null
          id: string
          keystore_id: string | null
          logo_path: string | null
          node_version: string
          platform: string
          project_kind: string | null
          release_type: string
          repo: string | null
          retry_of: string | null
          source_filename: string | null
          source_path: string | null
          source_size: number | null
          stage: string
          stage_updated_at: string
          status: string
          updated_at: string
          user_id: string
          web_dir: string | null
        }
        Insert: {
          app_name?: string | null
          artifact_kind?: string | null
          artifact_path?: string | null
          branch?: string | null
          bundle_id?: string | null
          codemagic_build_id?: string | null
          created_at?: string
          diagnostic_token?: string | null
          diagnostics?: Json | null
          error_category?: string | null
          error_retriable?: boolean | null
          error_summary?: string | null
          github_run_id?: number | null
          id?: string
          keystore_id?: string | null
          logo_path?: string | null
          node_version?: string
          platform?: string
          project_kind?: string | null
          release_type?: string
          repo?: string | null
          retry_of?: string | null
          source_filename?: string | null
          source_path?: string | null
          source_size?: number | null
          stage?: string
          stage_updated_at?: string
          status?: string
          updated_at?: string
          user_id: string
          web_dir?: string | null
        }
        Update: {
          app_name?: string | null
          artifact_kind?: string | null
          artifact_path?: string | null
          branch?: string | null
          bundle_id?: string | null
          codemagic_build_id?: string | null
          created_at?: string
          diagnostic_token?: string | null
          diagnostics?: Json | null
          error_category?: string | null
          error_retriable?: boolean | null
          error_summary?: string | null
          github_run_id?: number | null
          id?: string
          keystore_id?: string | null
          logo_path?: string | null
          node_version?: string
          platform?: string
          project_kind?: string | null
          release_type?: string
          repo?: string | null
          retry_of?: string | null
          source_filename?: string | null
          source_path?: string | null
          source_size?: number | null
          stage?: string
          stage_updated_at?: string
          status?: string
          updated_at?: string
          user_id?: string
          web_dir?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "builds_keystore_id_fkey"
            columns: ["keystore_id"]
            isOneToOne: false
            referencedRelation: "keystores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "builds_retry_of_fkey"
            columns: ["retry_of"]
            isOneToOne: false
            referencedRelation: "builds"
            referencedColumns: ["id"]
          },
        ]
      }
      github_connections: {
        Row: {
          access_token: string
          created_at: string
          github_login: string
          repo_name: string | null
          scopes: string | null
          token_type: string | null
          updated_at: string
          user_id: string
          validated_at: string | null
        }
        Insert: {
          access_token: string
          created_at?: string
          github_login: string
          repo_name?: string | null
          scopes?: string | null
          token_type?: string | null
          updated_at?: string
          user_id: string
          validated_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string
          github_login?: string
          repo_name?: string | null
          scopes?: string | null
          token_type?: string | null
          updated_at?: string
          user_id?: string
          validated_at?: string | null
        }
        Relationships: []
      }
      keystores: {
        Row: {
          created_at: string
          id: string
          key_alias: string
          key_password: string
          keystore_base64: string
          keystore_password: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_alias: string
          key_password: string
          keystore_base64: string
          keystore_password: string
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key_alias?: string
          key_password?: string
          keystore_base64?: string
          keystore_password?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
