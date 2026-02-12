# openclaw-mcp-bridge

OpenClaw plugin that bridges [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers into native agent tools.

## Why?

MCP servers expose structured tools with typed schemas — the proper interface for AI agents. This plugin connects MCP servers to OpenClaw's agent tool system so every MCP tool becomes a first-class native tool, not a CLI wrapper.

## Install

```bash
openclaw plugins install openclaw-mcp-bridge
```

Or link locally for development:

```bash
openclaw plugins install -l ./path/to/openclaw-mcp-bridge
```

## Configure

Add your MCP servers to `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "mcp-bridge": {
        enabled: true,
        config: {
          servers: {
            // Stdio server (spawns a local process)
            "ai-todo": {
              command: "ai-todo",
              args: ["serve", "--root", "/path/to/workspace"]
            },

            // Remote server via mcp-remote proxy
            "linear": {
              command: "npx",
              args: [
                "-y", "mcp-remote",
                "https://mcp.linear.app/mcp",
                "--header", "Authorization:Bearer ${LINEAR_API_KEY}"
              ]
            },

            // HTTP/SSE server (direct URL connection)
            "my-api": {
              url: "https://api.example.com/mcp",
              headers: {
                "Authorization": "Bearer ${API_KEY}"
              }
            }
          }
        }
      }
    }
  }
}
```

Restart the gateway after config changes.

## Server Config

Each server entry supports:

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | Command to spawn (stdio transport) |
| `args` | `string[]` | Arguments for the command |
| `env` | `object` | Extra environment variables for the process |
| `url` | `string` | URL for HTTP/SSE transport (alternative to command) |
| `headers` | `object` | HTTP headers for URL transport |
| `enabled` | `boolean` | Enable/disable this server (default: `true`) |
| `toolPrefix` | `boolean` | Prefix tool names with server name (default: `true`) |

Either `command` or `url` is required.

### Environment Variable Resolution

All string values support `${ENV_VAR}` syntax for environment variable substitution. This includes `command`, `args`, `env` values, `url`, and `headers`.

### Tool Naming

With `toolPrefix: true` (default), tools are named `<server>_<tool>`:
- Server `ai-todo`, tool `list_tasks` → `ai_todo_list_tasks`
- Server `linear`, tool `list_issues` → `linear_list_issues`

With `toolPrefix: false`, the original MCP tool name is used (watch for conflicts across servers).

## How It Works

1. On gateway start, the plugin spawns/connects to each configured MCP server
2. Calls `tools/list` on each server to discover available tools and their JSON schemas
3. Registers each tool as a native OpenClaw agent tool via `api.registerTool()`
4. When the agent calls a tool, the plugin routes it to the correct MCP server via `tools/call`
5. MCP response content is passed through directly to the agent

## Optional Tools

To make all bridged tools require an explicit allowlist:

```json5
{
  plugins: {
    entries: {
      "mcp-bridge": {
        config: {
          optional: true,
          servers: { /* ... */ }
        }
      }
    }
  }
}
```

Then enable them per-agent:

```json5
{
  agents: {
    list: [{
      id: "main",
      tools: {
        allow: ["mcp-bridge"]  // enable all bridged tools
      }
    }]
  }
}
```

## Development

```bash
git clone https://github.com/fxstein/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
npm install
openclaw plugins install -l .
openclaw gateway restart
```

## License

MIT
