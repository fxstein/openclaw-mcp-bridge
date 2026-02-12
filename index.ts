/**
 * openclaw-mcp-bridge — Bridges MCP servers into native OpenClaw agent tools.
 *
 * For each configured MCP server, this plugin:
 * 1. Spawns the server process (stdio) or connects via HTTP/SSE
 * 2. Discovers available tools via MCP tools/list
 * 3. Registers each tool as a native OpenClaw agent tool
 * 4. Routes tool executions to the correct MCP server via tools/call
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// SSE/Streamable HTTP transport — imported dynamically when needed

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: boolean;
}

interface PluginConfig {
  servers?: Record<string, ServerConfig>;
  optional?: boolean;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// Resolve ${ENV_VAR} references in strings
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? "";
  });
}

function resolveEnvInArray(arr: string[]): string[] {
  return arr.map(resolveEnvVars);
}

function resolveEnvInRecord(
  rec: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = resolveEnvVars(v);
  }
  return out;
}

// Sanitize MCP tool name into a valid OpenClaw tool name (snake_case, no dots/hyphens)
function sanitizeToolName(serverName: string, toolName: string, prefix: boolean): string {
  const sanitize = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase();

  if (prefix) {
    return `${sanitize(serverName)}_${sanitize(toolName)}`;
  }
  return sanitize(toolName);
}

export default function register(api: any) {
  const config: PluginConfig = api.config ?? {};
  const servers = config.servers ?? {};
  const optionalTools = config.optional ?? false;

  const clients = new Map<string, Client>();
  const transports = new Map<string, StdioClientTransport>();

  // Register a background service to manage MCP server lifecycles
  api.registerService({
    id: "mcp-bridge",

    async start() {
      const enabledServers = Object.entries(servers).filter(
        ([, cfg]) => cfg.enabled !== false
      );

      if (enabledServers.length === 0) {
        api.logger.info("mcp-bridge: no servers configured");
        return;
      }

      api.logger.info(
        `mcp-bridge: connecting to ${enabledServers.length} MCP server(s)...`
      );

      for (const [serverName, serverConfig] of enabledServers) {
        try {
          await connectServer(serverName, serverConfig);
        } catch (err) {
          api.logger.error(
            `mcp-bridge: failed to connect to ${serverName}: ${err}`
          );
        }
      }
    },

    async stop() {
      for (const [name, client] of clients) {
        try {
          await client.close();
          api.logger.info(`mcp-bridge: disconnected from ${name}`);
        } catch (err) {
          api.logger.warn(`mcp-bridge: error closing ${name}: ${err}`);
        }
      }
      for (const [, transport] of transports) {
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      transports.clear();
    },
  });

  async function connectServer(
    serverName: string,
    serverConfig: ServerConfig
  ) {
    const client = new Client(
      { name: `openclaw-mcp-bridge/${serverName}`, version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    let transport: any;

    if (serverConfig.command) {
      // Stdio transport
      const resolvedArgs = serverConfig.args
        ? resolveEnvInArray(serverConfig.args)
        : [];
      const resolvedEnv = serverConfig.env
        ? resolveEnvInRecord(serverConfig.env)
        : {};

      transport = new StdioClientTransport({
        command: resolveEnvVars(serverConfig.command),
        args: resolvedArgs,
        env: { ...process.env, ...resolvedEnv } as Record<string, string>,
      });

      transports.set(serverName, transport);
    } else if (serverConfig.url) {
      // HTTP/SSE transport — use Streamable HTTP with SSE fallback
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      const resolvedUrl = resolveEnvVars(serverConfig.url);
      const resolvedHeaders = serverConfig.headers
        ? resolveEnvInRecord(serverConfig.headers)
        : {};

      transport = new SSEClientTransport(new URL(resolvedUrl), {
        requestInit: {
          headers: resolvedHeaders,
        },
      });
    } else {
      throw new Error(
        `Server ${serverName}: must specify either 'command' or 'url'`
      );
    }

    await client.connect(transport);
    clients.set(serverName, client);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: McpTool[] = toolsResult.tools ?? [];

    api.logger.info(
      `mcp-bridge: ${serverName} — discovered ${tools.length} tool(s)`
    );

    const prefix = serverConfig.toolPrefix !== false;

    // Register each tool as a native OpenClaw agent tool
    for (const tool of tools) {
      const toolName = sanitizeToolName(serverName, tool.name, prefix);
      const mcpToolName = tool.name; // preserve original for MCP calls

      const description = [
        tool.description ?? `MCP tool from ${serverName}`,
        prefix ? `(MCP: ${serverName}/${mcpToolName})` : `(MCP: ${serverName})`,
      ].join(" ");

      // Convert MCP input schema to OpenClaw-compatible JSON Schema
      const parameters = tool.inputSchema ?? {
        type: "object",
        properties: {},
      };

      api.registerTool(
        {
          name: toolName,
          description,
          parameters,

          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const serverClient = clients.get(serverName);
            if (!serverClient) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error: MCP server '${serverName}' is not connected`,
                  },
                ],
                isError: true,
              };
            }

            try {
              const result = await serverClient.callTool({
                name: mcpToolName,
                arguments: params,
              });

              // MCP returns content array — pass through directly
              return {
                content: (result.content as any[]) ?? [
                  { type: "text", text: JSON.stringify(result) },
                ],
                isError: result.isError === true,
              };
            } catch (err: any) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `MCP error (${serverName}/${mcpToolName}): ${err.message ?? String(err)}`,
                  },
                ],
                isError: true,
              };
            }
          },
        },
        { optional: optionalTools }
      );
    }
  }
}
