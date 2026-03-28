/**
 * openclaw-mcp-bridge — Bridges MCP servers into native OpenClaw agent tools.
 *
 * Architecture:
 * - Tool schemas are loaded from a pre-discovered cache (.mcp-tools-cache.json)
 * - Tools are registered synchronously during plugin load (required by OpenClaw)
 * - MCP server connections are established lazily on first tool call
 * - Run `npx tsx discover.ts` to refresh the cache after adding/changing servers
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Types ----

export type TransportMode = "streamable-http" | "sse" | "auto";

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: boolean;
  transport?: TransportMode;
}

interface PluginConfig {
  servers?: Record<string, ServerConfig>;
  optional?: boolean;
}

interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface CacheEntry {
  server: string;
  tools: CachedTool[];
  discoveredAt: string;
}

interface Cache {
  version: number;
  servers: CacheEntry[];
}

// ---- Helpers ----

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? "";
  });
}

export function sanitizeToolName(
  serverName: string,
  toolName: string,
  prefix: boolean
): string {
  const sanitize = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase();

  return prefix
    ? `${sanitize(serverName)}_${sanitize(toolName)}`
    : sanitize(toolName);
}

function loadCache(pluginDir: string): Cache | null {
  const cachePath = path.join(pluginDir, ".mcp-tools-cache.json");
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(raw) as Cache;
    if (cache.version !== 1 || !Array.isArray(cache.servers)) return null;
    return cache;
  } catch {
    return null;
  }
}

export function getTransportMode(serverConfig: ServerConfig): TransportMode {
  return serverConfig.transport ?? "auto";
}

function resolveHeaders(headers?: Record<string, string>): Record<string, string> {
  const resolvedHeaders: Record<string, string> = {};
  if (!headers) {
    return resolvedHeaders;
  }

  for (const [k, v] of Object.entries(headers)) {
    resolvedHeaders[k] = resolveEnvVars(v);
  }

  return resolvedHeaders;
}

export async function connectUrlTransport(
  client: Client,
  serverName: string,
  serverConfig: ServerConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<void> {
  const resolvedUrl = resolveEnvVars(serverConfig.url ?? "");
  const resolvedHeaders = resolveHeaders(serverConfig.headers);
  const mode = getTransportMode(serverConfig);

  const connectStreamable = async (): Promise<void> => {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );

    const transport = new StreamableHTTPClientTransport(new URL(resolvedUrl), {
      requestInit: { headers: resolvedHeaders },
    });

    await client.connect(transport);
    logger.info(`mcp-bridge: ${serverName} connected via streamable-http`);
  };

  const connectSse = async (): Promise<void> => {
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );

    const transport = new SSEClientTransport(new URL(resolvedUrl), {
      requestInit: { headers: resolvedHeaders },
    });

    await client.connect(transport);
    logger.info(`mcp-bridge: ${serverName} connected via sse`);
  };

  if (mode === "sse") {
    await connectSse();
    return;
  }

  if (mode === "streamable-http") {
    await connectStreamable();
    return;
  }

  try {
    await connectStreamable();
  } catch (err: any) {
    logger.warn(
      `mcp-bridge: ${serverName} streamable-http failed (${err?.message ?? String(err)}), falling back to sse`
    );
    await connectSse();
  }
}

// ---- Plugin ----

export default function register(api: any) {
  // api.config is the FULL openclaw config, not just the plugin config.
  // Extract our plugin-specific config from the entries block.
  const fullConfig = api.config ?? {};
  const pluginEntry = fullConfig?.plugins?.entries?.["mcp-bridge"] ?? {};
  const config: PluginConfig = pluginEntry.config ?? {};
  const servers = config.servers ?? {};
  const optionalTools = config.optional ?? false;

  // Determine plugin directory
  const pluginDir = path.dirname(
    typeof __filename !== "undefined"
      ? __filename
      : new URL(import.meta.url).pathname
  );

  // Load cached tool schemas (synchronous — safe for plugin registration)
  const cache = loadCache(pluginDir);

  if (!cache || cache.servers.length === 0) {
    api.logger.warn(
      "mcp-bridge: no tool cache found. Run `npx tsx discover.ts` in the plugin directory to discover MCP tools."
    );
    return;
  }

  // Lazy connection pool
  const clients = new Map<string, Client>();
  const connecting = new Map<string, Promise<Client>>();

  async function getClient(serverName: string): Promise<Client> {
    const existing = clients.get(serverName);
    if (existing) return existing;

    // Prevent duplicate connections
    const pending = connecting.get(serverName);
    if (pending) return pending;

    const serverConfig = servers[serverName];
    if (!serverConfig) {
      throw new Error(`No config for MCP server '${serverName}'`);
    }

    const promise = connectServer(serverName, serverConfig);
    connecting.set(serverName, promise);

    try {
      const client = await promise;
      clients.set(serverName, client);
      return client;
    } finally {
      connecting.delete(serverName);
    }
  }

  async function connectServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<Client> {
    const client = new Client(
      { name: `openclaw-mcp-bridge/${serverName}`, version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    if (serverConfig.command) {
      const resolvedArgs = (serverConfig.args ?? []).map(resolveEnvVars);
      const resolvedEnv: Record<string, string> = {};
      if (serverConfig.env) {
        for (const [k, v] of Object.entries(serverConfig.env)) {
          resolvedEnv[k] = resolveEnvVars(v);
        }
      }

      const transport = new StdioClientTransport({
        command: resolveEnvVars(serverConfig.command),
        args: resolvedArgs,
        env: { ...process.env, ...resolvedEnv } as Record<string, string>,
      });

      await client.connect(transport);
    } else if (serverConfig.url) {
      await connectUrlTransport(client, serverName, serverConfig, api.logger);
    } else {
      throw new Error(`Server ${serverName}: must specify 'command' or 'url'`);
    }

    api.logger.info(`mcp-bridge: connected to ${serverName}`);
    return client;
  }

  // Register tools from cache (synchronous — this is the critical part)
  let totalTools = 0;

  for (const cacheEntry of cache.servers) {
    const serverName = cacheEntry.server;
    const serverConfig = servers[serverName];

    if (!serverConfig || serverConfig.enabled === false) {
      continue; // skip servers not in current config
    }

    const prefix = serverConfig.toolPrefix !== false;

    for (const tool of cacheEntry.tools) {
      const toolName = sanitizeToolName(serverName, tool.name, prefix);
      const mcpToolName = tool.name;

      const description = [
        tool.description ?? `MCP tool from ${serverName}`,
        `(MCP: ${serverName}/${mcpToolName})`,
      ].join(" ");

      const parameters = tool.inputSchema ?? {
        type: "object" as const,
        properties: {},
      };

      api.registerTool(
        {
          name: toolName,
          description,
          parameters,

          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const client = await getClient(serverName);
                const result = await client.callTool({
                  name: mcpToolName,
                  arguments: params,
                });

                // Normalize content: OC only renders type:"text" and type:"image".
                // MCP servers may return type:"resource" (embedded resources) which
                // OC silently drops. Unwrap resource content into text.
                const rawContent = (result.content as any[]) ?? [];
                const normalizedContent = rawContent.map((item: any) => {
                  if (item.type === "resource" && item.resource) {
                    return {
                      type: "text" as const,
                      text: item.resource.text ?? JSON.stringify(item.resource),
                    };
                  }
                  return item;
                });

                return {
                  content: normalizedContent.length > 0
                    ? normalizedContent
                    : [{ type: "text", text: JSON.stringify(result) }],
                  isError: result.isError === true,
                };
              } catch (err: any) {
                if (attempt === 0) {
                  // Connection may be dead — drop it and retry with a fresh one
                  clients.delete(serverName);
                  api.logger.warn(
                    `mcp-bridge: ${serverName}/${mcpToolName} failed, retrying with fresh connection`
                  );
                  continue;
                }
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
            }
          },
        },
        { optional: optionalTools }
      );

      totalTools++;
    }
  }

  api.logger.info(
    `mcp-bridge: registered ${totalTools} tool(s) from ${cache.servers.length} server(s)`
  );

  // Service for cleanup on shutdown
  api.registerService({
    id: "mcp-bridge",
    start: async () => {},
    stop: async () => {
      for (const [name, client] of clients) {
        try {
          await client.close();
          api.logger.info(`mcp-bridge: disconnected from ${name}`);
        } catch {
          // ignore
        }
      }
      clients.clear();
    },
  });
}
