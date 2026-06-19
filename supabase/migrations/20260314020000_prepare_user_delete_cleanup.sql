-- =============================================================================
-- Prepare user deletion by removing/nulling direct auth.users references first.
-- Supabase auth.admin.deleteUser() does not automatically cascade through the
-- public schema, so we clear those FK references explicitly before deleting the
-- auth row.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prepare_user_delete(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    fk_record RECORD;
    sql_stmt TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required';
    END IF;

    FOR fk_record IN
        SELECT
            ns.nspname AS schema_name,
            cls.relname AS table_name,
            attr.attname AS column_name,
            attr.attnotnull AS is_not_null
        FROM pg_constraint con
        JOIN pg_class cls
          ON cls.oid = con.conrelid
        JOIN pg_namespace ns
          ON ns.oid = cls.relnamespace
        JOIN pg_attribute attr
          ON attr.attrelid = con.conrelid
         AND attr.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.confrelid = 'auth.users'::regclass
          AND array_length(con.conkey, 1) = 1
          AND ns.nspname = 'public'
        ORDER BY
            CASE WHEN attr.attnotnull THEN 0 ELSE 1 END,
            cls.relname,
            attr.attname
    LOOP
        IF fk_record.is_not_null THEN
            sql_stmt := format(
                'DELETE FROM %I.%I WHERE %I = $1',
                fk_record.schema_name,
                fk_record.table_name,
                fk_record.column_name
            );
        ELSE
            sql_stmt := format(
                'UPDATE %I.%I SET %I = NULL WHERE %I = $1',
                fk_record.schema_name,
                fk_record.table_name,
                fk_record.column_name,
                fk_record.column_name
            );
        END IF;

        EXECUTE sql_stmt USING p_user_id;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'projects'
          AND column_name = 'user_id'
    ) THEN
        UPDATE public.projects
        SET user_id = NULL
        WHERE user_id = p_user_id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'revisions'
          AND column_name = 'user_id'
    ) THEN
        UPDATE public.revisions
        SET user_id = NULL
        WHERE user_id = p_user_id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'revisions'
          AND column_name = 'created_by'
    ) THEN
        UPDATE public.revisions
        SET created_by = NULL
        WHERE created_by = p_user_id;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prepare_user_delete(UUID) TO service_role;