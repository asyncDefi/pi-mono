# MCP

Pi loads project MCP servers from `.pi/mcp.json`. MCP servers are not converted into skills. They are separate, loadable context resources.

## Configuration

Use a Claude-compatible `mcpServers` object:

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["./tools/docs-mcp.js"],
      "description": "Project documentation search"
    },
    "unity": {
      "url": "http://localhost:8080/mcp",
      "description": "Local Unity editor MCP"
    }
  }
}
```

Stdio servers use `command`, optional `args`, `cwd`, and `env`. HTTP servers use `url` or `baseUrl`; `baseUrl` appends `/mcp` when needed. Set `"disabled": true` to skip a server.

## Dynamic MCP Context

Pi exposes MCP through the built-in `mcp_context` tool:

- `list_discovered` or `list`: list servers configured in `.pi/mcp.json`
- `load`: connect to a server, list tools, and expose those tools to the model
- `unload`: remove a server's tools and close its connection
- `list_active`: list loaded MCP servers and tool names
- `history`: show recent load/unload events

Only loaded MCP servers contribute tools to the model context. Unload unused servers to keep tool context small.
