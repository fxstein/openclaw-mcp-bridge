import { describe, expect, it } from "vitest";
import {
  getTransportMode,
  resolveEnvVars,
  sanitizeToolName,
  type ServerConfig,
} from "../index";
import { getEnabledServers } from "../discover";

describe("transport and config helpers", () => {
  it("sanitizeToolName works with prefix", () => {
    expect(sanitizeToolName("QMD Server", "Query-Docs", true)).toBe(
      "qmd_server_query_docs"
    );
  });

  it("sanitizeToolName works without prefix", () => {
    expect(sanitizeToolName("QMD Server", "Query-Docs", false)).toBe("query_docs");
  });

  it("resolveEnvVars resolves ${VAR} patterns", () => {
    process.env.TEST_MCP_TOKEN = "abc123";
    expect(resolveEnvVars("Bearer ${TEST_MCP_TOKEN}")).toBe("Bearer abc123");
    expect(resolveEnvVars("${MISSING_ENV}")).toBe("");
  });

  it("transport defaults to auto", () => {
    const cfg: ServerConfig = { url: "https://example.com/mcp" };
    expect(getTransportMode(cfg)).toBe("auto");
  });

  it("enabled: false skips server", () => {
    const servers: Record<string, ServerConfig> = {
      enabledOne: { command: "foo" },
      disabledOne: { command: "bar", enabled: false },
    };

    const enabled = getEnabledServers(servers);
    expect(enabled.map(([name]) => name)).toEqual(["enabledOne"]);
  });
});
