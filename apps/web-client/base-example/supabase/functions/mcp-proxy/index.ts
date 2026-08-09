const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function parseResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()

  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try { return JSON.parse(line.slice(6)) } catch { /* skip */ }
      }
    }
    return null
  }

  if (contentType.includes('application/json')) {
    try { return JSON.parse(text) } catch { /* skip */ }
  }

  // Not JSON or SSE — return null and let caller handle
  return null
}

async function mcpRequest(url: string, body: object, sessionId?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorText = await res.text()
    const isHtml = errorText.trimStart().startsWith('<')
    throw new Error(
      isHtml
        ? `MCP server returned HTTP ${res.status} (likely invalid URL or server not found)`
        : `MCP server returned HTTP ${res.status}: ${errorText.slice(0, 200)}`
    )
  }

  const data = await parseResponse(res)
  const newSessionId = res.headers.get('mcp-session-id') ?? sessionId ?? ''
  return { data, sessionId: newSessionId }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, mcp_url, tool_name, tool_args } = await req.json()

    if (!mcp_url) {
      return jsonResponse({ error: 'mcp_url is required' }, 400)
    }

    // Validate URL format
    try {
      new URL(mcp_url)
    } catch {
      return jsonResponse({ error: 'Invalid mcp_url format' }, 400)
    }

    if (action === 'initialize') {
      // Initialize MCP session
      const init = await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'FT30 Media', version: '1.0.0' },
        },
      })

      // Send initialized notification
      await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }, init.sessionId)

      // List tools
      const toolsResult = await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }, init.sessionId)

      const tools = toolsResult.data?.result?.tools ?? []

      return jsonResponse({ tools, sessionId: init.sessionId })
    }

    if (action === 'invoke') {
      if (!tool_name) {
        return jsonResponse({ error: 'tool_name is required' }, 400)
      }

      // Initialize first
      const init = await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'FT30 Media', version: '1.0.0' },
        },
      })

      // Send initialized notification
      await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }, init.sessionId)

      // Invoke the tool
      const callResult = await mcpRequest(mcp_url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: tool_name,
          arguments: tool_args ?? {},
        },
      }, init.sessionId)

      return jsonResponse({ result: callResult.data?.result ?? callResult.data })
    }

    return jsonResponse({ error: 'Invalid action. Use "initialize" or "invoke".' }, 400)
  } catch (error: unknown) {
    console.error('MCP proxy error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return jsonResponse({ error: message }, 200) // Return 200 so client can read the error
  }
})
