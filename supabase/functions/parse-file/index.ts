import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      throw new Error('No file provided');
    }

    const fileType = file.type;
    let extractedText = '';

    console.log('Processing file:', file.name, 'Type:', fileType);

    // Handle different file types
    if (fileType.startsWith('image/')) {
      // For images, we'll just note that an image was attached
      extractedText = `[Image attachment: ${file.name}]`;
    } else if (fileType === 'application/pdf') {
      // For PDF, we'll extract basic info
      // In production, you'd use a PDF parsing library
      extractedText = `[PDF attachment: ${file.name}, Size: ${file.size} bytes]`;
    } else if (fileType.includes('word') || fileType.includes('document')) {
      // For Word docs
      extractedText = `[Word document: ${file.name}, Size: ${file.size} bytes]`;
    } else if (fileType.includes('excel') || fileType.includes('spreadsheet')) {
      // For Excel files
      extractedText = `[Excel file: ${file.name}, Size: ${file.size} bytes]`;
    } else if (fileType.startsWith('text/')) {
      // For text files, read the content
      const text = await file.text();
      extractedText = text;
    } else {
      extractedText = `[File: ${file.name}, Type: ${fileType}, Size: ${file.size} bytes]`;
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        extractedText,
        fileName: file.name,
        fileType: fileType
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error parsing file:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
