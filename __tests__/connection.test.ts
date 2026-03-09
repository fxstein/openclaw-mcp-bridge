import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectUrlTransport, type ServerConfig } from "../index";

class FakeStreamableHTTPClientTransport {
  static shouldFail = false;
  static created = 0;

  constructor(_url: URL, _opts: any) {
    FakeStreamableHTTPClientTransport.created++;
  }
}

class FakeSSEClientTransport {
  static created = 0;

  constructor(_url: URL, _opts: any) {
    FakeSSEClientTransport.created++;
  }
}

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: FakeSSEClientTransport,
}));

function makeClient() {
  return {
    connect: vi.fn(async (_transport: any) => {
      if (
        FakeStreamableHTTPClientTransport.shouldFail &&
        _transport instanceof FakeStreamableHTTPClientTransport
      ) {
        throw new Error("streamable unavailable");
      }
    }),
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("connectUrlTransport", () => {
  beforeEach(() => {
    FakeStreamableHTTPClientTransport.shouldFail = false;
    FakeStreamableHTTPClientTransport.created = 0;
    FakeSSEClientTransport.created = 0;
  });

  it("connects with Streamable HTTP when available", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const cfg: ServerConfig = { url: "https://example.com/mcp", transport: "auto" };

    await connectUrlTransport(client, "qmd", cfg, logger);

    expect(FakeStreamableHTTPClientTransport.created).toBe(1);
    expect(FakeSSEClientTransport.created).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("streamable-http"));
  });

  it("falls back to SSE in auto mode", async () => {
    FakeStreamableHTTPClientTransport.shouldFail = true;

    const client = makeClient();
    const logger = makeLogger();
    const cfg: ServerConfig = { url: "https://example.com/sse", transport: "auto" };

    await connectUrlTransport(client, "legacy", cfg, logger);

    expect(FakeStreamableHTTPClientTransport.created).toBe(1);
    expect(FakeSSEClientTransport.created).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to sse"));
  });

  it("transport: sse skips Streamable HTTP attempt", async () => {
    const client = makeClient();
    const logger = makeLogger();
    const cfg: ServerConfig = { url: "https://example.com/sse", transport: "sse" };

    await connectUrlTransport(client, "legacy", cfg, logger);

    expect(FakeStreamableHTTPClientTransport.created).toBe(0);
    expect(FakeSSEClientTransport.created).toBe(1);
  });

  it("transport: streamable-http does not fall back", async () => {
    FakeStreamableHTTPClientTransport.shouldFail = true;

    const client = makeClient();
    const logger = makeLogger();
    const cfg: ServerConfig = {
      url: "https://example.com/mcp",
      transport: "streamable-http",
    };

    await expect(connectUrlTransport(client, "qmd", cfg, logger)).rejects.toThrow(
      "streamable unavailable"
    );
    expect(FakeSSEClientTransport.created).toBe(0);
  });

  it("connection retry uses a fresh connection object on second attempt", async () => {
    const makeFresh = () => makeClient();
    const first = makeFresh();
    const second = makeFresh();

    FakeStreamableHTTPClientTransport.shouldFail = true;
    await expect(
      connectUrlTransport(first, "retry", { url: "https://example.com/mcp", transport: "streamable-http" }, makeLogger())
    ).rejects.toThrow();

    FakeStreamableHTTPClientTransport.shouldFail = false;
    await expect(
      connectUrlTransport(second, "retry", { url: "https://example.com/mcp", transport: "streamable-http" }, makeLogger())
    ).resolves.toBeUndefined();

    expect(first).not.toBe(second);
  });
});
