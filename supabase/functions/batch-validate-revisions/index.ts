console.info('Batch validate revisions started');

import "https://deno.land/x/xhr@0.4.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting batch validation of all revisions...');
    
    // Fetch all revisions from the database
    const { data: revisions, error: fetchError } = await supabase
      .from('revisions')
      .select('id, generated_files, project_id, created_at')
      .order('created_at', { ascending: false });

    if (fetchError) {
      throw new Error(`Failed to fetch revisions: ${fetchError.message}`);
    }

    if (!revisions || revisions.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No revisions found to validate',
        stats: { total: 0, processed: 0, failed: 0 }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`📊 Found ${revisions.length} revisions to validate`);

    const results = {
      total: revisions.length,
      processed: 0,
      failed: 0,
      skipped: 0,
      details: [] as any[]
    };

    // Process each revision
    for (const revision of revisions) {
      try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Processing revision: ${revision.id}`);
        console.log(`Project: ${revision.project_id}`);
        console.log(`${'='.repeat(60)}`);

        // Extract files from generated_files
        const generatedFiles = revision.generated_files;
        
        if (!generatedFiles || !generatedFiles.files || !Array.isArray(generatedFiles.files)) {
          console.log(`⏭️  Skipping revision ${revision.id} - no valid files array`);
          results.skipped++;
          results.details.push({
            revision_id: revision.id,
            status: 'skipped',
            reason: 'No valid files array'
          });
          continue;
        }

        const files = generatedFiles.files;
        console.log(`📁 Found ${files.length} files to validate`);

        // Call debug-sandbox edge function
        const debugResponse = await fetch(`${SUPABASE_URL}/functions/v1/debug-sandbox`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({ files })
        });

        if (!debugResponse.ok) {
          const errorText = await debugResponse.text();
          throw new Error(`Debug-sandbox failed: ${errorText}`);
        }

        const debugData = await debugResponse.json();

        if (!debugData.success) {
          throw new Error(`Validation failed: ${debugData.error || 'Unknown error'}`);
        }

        console.log(`✅ Validation complete for revision ${revision.id}`);
        console.log(`   - Files processed: ${debugData.metrics.files_processed}`);
        console.log(`   - Files modified: ${debugData.metrics.files_modified}`);
        console.log(`   - Issues fixed: ${debugData.metrics.issues_fixed}`);
        console.log(`   - Sandpack compatible: ${debugData.metrics.sandpack_compatible}`);

        // Update revision with validated files
        const { error: updateError } = await supabase
          .from('revisions')
          .update({
            generated_files: {
              files: debugData.files,
              summary: generatedFiles.summary || '',
              validation_report: debugData.validation,
              validated_at: new Date().toISOString()
            }
          })
          .eq('id', revision.id);

        if (updateError) {
          throw new Error(`Failed to update revision: ${updateError.message}`);
        }

        results.processed++;
        results.details.push({
          revision_id: revision.id,
          status: 'success',
          metrics: debugData.metrics,
          validation: {
            issues_found: debugData.validation.totalIssues,
            issues_fixed: debugData.validation.fixedIssues,
            sandpack_compatible: debugData.validation.sandpackCompatible
          }
        });

        console.log(`💾 Updated revision ${revision.id} in database`);

      } catch (revisionError) {
        console.error(`❌ Error processing revision ${revision.id}:`, revisionError);
        results.failed++;
        results.details.push({
          revision_id: revision.id,
          status: 'failed',
          error: revisionError instanceof Error ? revisionError.message : 'Unknown error'
        });
      }
    }

    const totalTime = Date.now() - startTime;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 BATCH VALIDATION COMPLETE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total revisions: ${results.total}`);
    console.log(`✅ Processed: ${results.processed}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`⏭️  Skipped: ${results.skipped}`);
    console.log(`⏱️  Total time: ${totalTime}ms`);
    console.log(`${'='.repeat(60)}\n`);

    return new Response(JSON.stringify({
      success: true,
      message: `Batch validation complete. Processed ${results.processed}/${results.total} revisions`,
      stats: {
        total: results.total,
        processed: results.processed,
        failed: results.failed,
        skipped: results.skipped,
        total_time_ms: totalTime
      },
      details: results.details
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error('❌ Batch validation failed:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stats: {
        total_time_ms: elapsed
      }
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
