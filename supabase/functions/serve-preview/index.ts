// supabase/functions/serve-preview/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || 
      filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'application/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Remove 'serve-preview' from path if present
    if (pathParts[0] === 'serve-preview') {
      pathParts.shift();
    }
    
    if (pathParts.length < 2) {
      return new Response('Invalid URL format. Expected: /serve-preview/{projectId}/{buildId}/{filePath}', { status: 400 });
    }
    
    const projectId = pathParts[0];
    const buildId = pathParts[1];
    const filePath = pathParts.slice(2).join('/') || 'index.html';
    
    const storagePath = `${projectId}/${buildId}/${filePath}`;
    
    console.log(`[serve-preview] Serving: ${storagePath}`);
    
    // Download from Storage
    const { data, error } = await supabase.storage
      .from('preview-builds')
      .download(storagePath);
    
    if (error || !data) {
      console.error(`[serve-preview] File not found: ${storagePath}`, error);
      return new Response('File not found', { status: 404 });
    }
    
    // Read content as ArrayBuffer to preserve binary data
    const arrayBuffer = await data.arrayBuffer();
    const contentType = getContentType(filePath);
    const isHtml = contentType.startsWith('text/html');

    console.log(`[serve-preview] Serving ${filePath} as ${contentType}`);

    const filename = filePath.split('/').pop() || 'file';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Vary': 'Origin',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https:;",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    };

    if (isHtml) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
      headers['Content-Disposition'] = `inline; filename="${filename}"`;
      const text = new TextDecoder('utf-8').decode(arrayBuffer);
      return new Response(text, { status: 200, headers });
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
      return new Response(arrayBuffer, { status: 200, headers });
    }
    
  } catch (error) {
    console.error('[serve-preview] Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
});
