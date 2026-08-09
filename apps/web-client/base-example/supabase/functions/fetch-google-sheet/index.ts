const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { sheet_id, col_start, col_end } = await req.json();

    if (!sheet_id || !col_start || !col_end) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing sheet_id, col_start, or col_end" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const colRegex = /^[A-Z]{1,2}$/;
    if (!colRegex.test(col_start.toUpperCase()) || !colRegex.test(col_end.toUpperCase())) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid column letters. Use A-Z." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract sheet ID from URL or raw ID
    let extractedId = sheet_id;
    const urlMatch = sheet_id.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) extractedId = urlMatch[1];

    // Use Google Visualization API (works for "Anyone with the link" sheets without auth)
    const colStartUpper = col_start.toUpperCase();
    const colEndUpper = col_end.toUpperCase();
    
    // Build a query to select columns
    const colStartNum = colLetterToNumber(colStartUpper);
    const colEndNum = colLetterToNumber(colEndUpper);
    const colLetters: string[] = [];
    for (let i = colStartNum; i <= colEndNum; i++) {
      colLetters.push(String.fromCharCode(64 + i));
    }

    // Try multiple URL formats
    // Format 1: Published to web (most reliable for server-side)
    const pubUrl = `https://docs.google.com/spreadsheets/d/${extractedId}/pub?output=csv&range=${colStartUpper}:${colEndUpper}`;
    // Format 2: Export URL (works for some sharing configs)
    const exportUrl = `https://docs.google.com/spreadsheets/d/${extractedId}/export?format=csv&range=${colStartUpper}:${colEndUpper}`;
    // Format 3: gviz API
    const gvizUrl = `https://docs.google.com/spreadsheets/d/${extractedId}/gviz/tq?tqx=out:csv&range=${colStartUpper}:${colEndUpper}`;

    let csvText = "";
    let success = false;

    for (const url of [pubUrl, exportUrl, gvizUrl]) {
      console.log("Trying:", url);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          redirect: "follow",
        });
        if (res.ok) {
          const text = await res.text();
          if (!text.trim().startsWith("<!DOCTYPE") && !text.trim().startsWith("<html")) {
            csvText = text;
            success = true;
            console.log("Success with:", url, "Length:", text.length);
            break;
          }
        }
        console.log("Failed:", url, "Status:", res.status);
      } catch (e) {
        console.log("Error with:", url, e.message);
      }
    }

    if (!success) {
      return new Response(
        JSON.stringify({ ok: false, error: "Could not access the sheet. Please go to your Google Sheet → File → Share → Publish to web → select 'Comma-separated values (.csv)' → click Publish. Then try again." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse CSV
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, headers: [], rows: [] }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => {
      const cells = parseCsvLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] ?? "";
      });
      return row;
    });

    return new Response(
      JSON.stringify({ ok: true, headers, rows }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message || "Internal error" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function colLetterToNumber(col: string): number {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}
