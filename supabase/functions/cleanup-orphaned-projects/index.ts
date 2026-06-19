import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import * as postgres from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const dbUrl = Deno.env.get('EXTERNAL_DB_URL');
    if (!dbUrl) {
      throw new Error('EXTERNAL_DB_URL not configured');
    }

    const pool = new postgres.Pool(dbUrl, 3, true);
    const connection = await pool.connect();

    try {
      console.log('[cleanup-orphaned-projects] 🧹 Starting cleanup...');
      
      // Delete orphaned projects (user_id IS NULL and older than 7 days)
      const result = await connection.queryObject`
        DELETE FROM projects
        WHERE user_id IS NULL
        AND created_at < NOW() - INTERVAL '7 days'
        RETURNING id
      `;

      const deletedCount = result.rows.length;
      console.log(`[cleanup-orphaned-projects] ✅ Deleted ${deletedCount} orphaned projects`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          deleted_count: deletedCount,
          message: `Cleaned up ${deletedCount} orphaned projects`
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[cleanup-orphaned-projects] ❌ Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
