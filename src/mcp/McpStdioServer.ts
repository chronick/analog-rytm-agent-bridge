import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RytmMcpAdapter } from "./RytmMcpAdapter.ts";

/**
 * Serves an existing {@link RytmMcpAdapter} over MCP stdio.
 *
 * The adapter already owns the tool catalogue and the dispatch table, so this
 * file is only the transport seam: it maps `listTools()` onto `tools/list` and
 * `callTool()` onto `tools/call`, and converts a thrown tool error into an
 * `isError` result rather than a protocol-level failure. A protocol error would
 * tell the client the *server* is broken; a failed Rytm operation only means
 * the operation was refused, and the agent should see the reason and adapt.
 */
export interface McpStdioServerOptions {
  name?: string;
  version?: string;
  /** Called when the client disconnects, so the caller can close the daemon. */
  onClose?: () => void | Promise<void>;
}

export function createRytmMcpServer(
  adapter: RytmMcpAdapter,
  options: McpStdioServerOptions = {},
): Server {
  const server = new Server(
    {
      name: options.name ?? "analog-rytm-agent-bridge",
      version: options.version ?? "0.1.0",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: adapter.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await adapter.callTool(name, args ?? {});
      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      // A refused or failed Rytm operation is a normal outcome the agent must
      // be able to read and react to, not a transport fault.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  if (options.onClose) {
    const onClose = options.onClose;
    server.onclose = () => {
      void onClose();
    };
  }

  return server;
}

/** Connects the server to stdio. Resolves once the transport is attached. */
export async function serveRytmMcpOverStdio(
  adapter: RytmMcpAdapter,
  options: McpStdioServerOptions = {},
): Promise<Server> {
  const server = createRytmMcpServer(adapter, options);
  await server.connect(new StdioServerTransport());
  return server;
}
