#!/usr/bin/env npx tsx
/**
 * MCP Tool Discovery — runs MCP servers, lists their tools, and caches
 * the schemas to .mcp-tools-cache.json for the plugin to use at load time.
 *
 * Usage: npx tsx discover.ts [--config path/to/config.json]
 *
 * Default config: reads from the plugin config in openclaw.json,
 * or pass a standalone JSON file with the same "servers" shape.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: boolean;
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
  version: 1;
  servers: CacheEntry[];
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? "";
  });
}

async function discoverServer(
  serverName: string,
  config: ServerConfig
): Promise<CacheEntry> {
  if (!config.command) {
    throw new Error(`Server ${serverName}: only stdio servers supported for discovery`);
  }

  const resolvedArgs = (config.args ?? []).map(resolveEnvVars);
  const resolvedEnv: Record<string, string> = {};
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      resolvedEnv[k] = resolveEnvVars(v);
    }
  }

  const transport = new StdioClientTransport({
    command: resolveEnvVars(config.command),
    args: resolvedArgs,
    env: { ...process.env, ...resolvedEnv } as Record<string, string>,
  });

  const client = new Client(
    { name: "mcp-bridge-discover", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const tools: CachedTool[] = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    console.log(`  ${serverName}: ${tools.length} tool(s) discovered`);
    for (const t of tools) {
      console.log(`    - ${t.name}: ${t.description?.slice(0, 80) ?? "(no description)"}`);
    }

    return {
      server: serverName,
      tools,
      discoveredAt: new Date().toISOString(),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await transport.close();
    } catch {
      // ignore
    }
  }
}

async function main() {
  // Find config
  let servers: Record<string, ServerConfig> = {};

  const configArg = process.argv.indexOf("--config");
  if (configArg >= 0 && process.argv[configArg + 1]) {
    const configPath = process.argv[configArg + 1];
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    servers = raw.servers ?? raw;
  } else {
    // Try to read from openclaw.json
    const openclawPaths = [
      ...(process.env.OPENCLAW_CONFIG_PATH ? [process.env.OPENCLAW_CONFIG_PATH] : []),
      path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json"),
      "openclaw.json",
    ];
    for (const p of openclawPaths) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        servers = raw.plugins?.entries?.["mcp-bridge"]?.config?.servers ?? {};
        if (Object.keys(servers).length > 0) {
          console.log(`Read config from ${p}`);
          break;
        }
      } catch {
        // try next
      }
    }
  }

  const enabledServers = Object.entries(servers).filter(
    ([, cfg]) => cfg.enabled !== false
  );

  if (enabledServers.length === 0) {
    console.error("No MCP servers configured. Pass --config or configure in openclaw.json.");
    process.exit(1);
  }

  console.log(`Discovering tools from ${enabledServers.length} server(s)...\n`);

  const cache: Cache = { version: 1, servers: [] };

  for (const [name, config] of enabledServers) {
    try {
      const entry = await discoverServer(name, config);
      cache.servers.push(entry);
    } catch (err: any) {
      console.error(`  ${name}: FAILED — ${err.message}`);
    }
  }

  const cachePath = path.join(path.dirname(new URL(import.meta.url).pathname), ".mcp-tools-cache.json");
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  console.log(`\nCache written to ${cachePath}`);
  console.log(`Total: ${cache.servers.reduce((n, s) => n + s.tools.length, 0)} tool(s) from ${cache.servers.length} server(s)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
