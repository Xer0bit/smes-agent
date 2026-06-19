import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.78.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // Initialize Admin Client up-front so it is available in the catch block.
    const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Track the job we successfully claimed so failures can be recorded.
    let claimedJobId: string | null = null;

    try {
        const { record } = await req.json(); // Payload from Database Webhook

        // Safety check
        if (!record || !record.id) {
            return new Response("No record found", { status: 400 });
        }

        if (record.status !== 'pending') {
            return new Response("Job already processed", { status: 200 });
        }

        // Atomic claim: only one worker can flip pending -> processing.
        // If no row comes back, another invocation already claimed this job.
        const { data: claimed, error: claimError } = await supabase
            .from('jobs')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', record.id)
            .eq('status', 'pending')
            .select('id');

        if (claimError) {
            throw claimError;
        }
        if (!claimed || claimed.length === 0) {
            return new Response("Job already claimed", { status: 200 });
        }

        claimedJobId = record.id;
        console.log(`[JobWorker] Processing job ${record.id} of type ${record.type}`);

        let result = {};

        // Job Dispatcher
        if (record.type === 'generate') {
            // Call agent-with-tools or run logic here
            // For now, we simulate "Active Engineering"
            await new Promise(r => setTimeout(r, 2000)); // Thinking...
            result = { success: true, message: "Generated successfully" };
        } else if (record.type === 'fix') {
            // Run auto-fix logic
            await new Promise(r => setTimeout(r, 3000)); // Analyzing...
            result = { success: true, message: "Fix applied" };
        }

        // Mark as complete
        await supabase.from('jobs').update({
            status: 'completed',
            result,
            updated_at: new Date().toISOString()
        }).eq('id', record.id);

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Never leave a claimed job stuck in 'processing'.
        if (claimedJobId) {
            try {
                await supabase.from('jobs').update({
                    status: 'failed',
                    result: { error: message },
                    updated_at: new Date().toISOString()
                }).eq('id', claimedJobId);
            } catch (updateErr) {
                console.error(`[JobWorker] Failed to mark job ${claimedJobId} as failed:`, updateErr);
            }
        }

        return new Response(JSON.stringify({ error: message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        });
    }
});
