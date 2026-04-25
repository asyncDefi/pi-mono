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
    "errors-log": {
      "command": "C:\\Users\\Ivan\\Documents\\my_mcps\\errors-log\\.venv\\Scripts\\python.exe",
      "args": ["-m", "errors_log"],
      "cwd": "C:\\Users\\Ivan\\Documents\\my_mcps\\errors-log",
      "env": {
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "ERRORS_LOG_CONFIG": "C:\\Users\\Ivan\\Documents\\my_mcps\\errors-log\\errors_log_config.yaml",
        "ERRORS_LOG_PROJECT_NAME": "roblox-game"
      },
      "description": "Local errors log MCP"
    },
    "unity": {
      "url": "http://localhost:8080/mcp",
      "description": "Local Unity editor MCP"
    }
  }
}
```

Stdio servers use `command`, optional `args`, `cwd`, and `env`. Python stdio servers get `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` by default unless `env` already sets them; keeping them explicit in the config is useful for compatibility with other MCP hosts. HTTP servers use `url` or `baseUrl`; `baseUrl` appends `/mcp` when needed. Set `"disabled": true` to skip a server.

## Dynamic MCP Context

Pi exposes MCP through the built-in `mcp_context` tool:

- `list_discovered` or `list`: list servers configured in `.pi/mcp.json`, including transport details plus env/header key names without secret values
- `load`: connect to a server, list tools, and expose those tools to the model
- `unload`: remove a server's tools and close its connection
- `list_active`: list loaded MCP servers and tool names
- `history`: show recent load/unload events

Only loaded MCP servers contribute tools to the model context. Unload unused servers to keep tool context small.
