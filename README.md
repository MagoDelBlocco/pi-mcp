# pi-mcp-client

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that bridges [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers into pi as native tools.

Configure MCP servers in `~/.pi/agent/mcp.json`, and their tools become available directly in your pi sessions — with automatic schema conversion, reconnection, and timeout handling.

## Features

- **Multiple transport protocols**: Streamable HTTP, SSE, and stdio
- **Automatic tool registration**: MCP tools are discovered and registered as pi tools at startup
- **Schema conversion**: MCP JSON Schema `inputSchema` is converted to TypeBox schemas for pi's tool system
- **Auto-reconnect**: Exponential backoff reconnection for failed servers
- **Tool control**: Exclude specific tools or use direct naming (no server prefix)
- **Configurable timeouts**: Per-server connect and call timeouts
- **Session notifications**: Connection status shown on session start

## Installation

Place this extension in your pi extensions directory:

```
~/.pi/agent/extensions/mcp-client/
```

Install dependencies:

```bash
cd ~/.pi/agent/extensions/mcp-client
npm install
```

## Configuration

Create `~/.pi/agent/mcp.json` with your server definitions:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/bogdan"],
      "timeout": 60
    },
    "github": {
      "url": "https://mcp.example.com/github",
      "headers": {
        "Authorization": "Bearer ghp_..."
      },
      "transport": "streamable-http",
      "timeout": 120
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-key-here"
      },
      "directTools": true,
      "excludeTools": ["search_web"]
    }
  }
}
```

### Server Configuration Options

| Option            | Type       | Default  | Description                                                |
| ----------------- | ---------- | -------- | ---------------------------------------------------------- |
| `url`             | `string`   | —        | HTTP/SSE endpoint (for HTTP transports)                    |
| `headers`         | `object`   | —        | Custom HTTP headers (e.g., auth tokens)                    |
| `command`         | `string`   | —        | Command to run (for stdio transport)                       |
| `args`            | `string[]` | `[]`     | Arguments for the stdio command                            |
| `env`             | `object`   | —        | Extra environment variables for stdio                      |
| `transport`       | `string`   | `"auto"` | Force transport: `"auto"`, `"streamable-http"`, or `"sse"` |
| `timeout`         | `number`   | `120`    | Tool call timeout in seconds                               |
| `connectTimeout`  | `number`   | `60`     | Connection timeout in seconds (alias: `connect_timeout`)   |
| `directTools`     | `boolean`  | `false`  | Register tools without server prefix                       |
| `excludeTools`    | `string[]` | `[]`     | Tool names to skip                                         |

### Tool Naming

By default, tools are prefixed with the server name: `mcp_servername_toolname`.

Set `"directTools": true` to register tools under their original names (useful when tool names won't conflict across servers).

## Commands

| Command      | Description                                      |
| ------------ | ------------------------------------------------ |
| `mcp-status` | Show connection status of all configured servers |
| `mcp-reload` | Disconnect and reconnect all MCP servers         |

## Transport Selection

When `url` is provided, the transport is determined by the `transport` option:

- `"auto"` (default): Tries Streamable HTTP first, then falls back to SSE if the connection fails
- `"streamable-http"`: Explicitly uses Streamable HTTP (no fallback)
- `"sse"`: Uses SSE transport

When `command` is provided, stdio transport is used automatically.

## Reconnection

Failed connections are retried with exponential backoff (capped at 60s). Servers
that drop after a successful connection are detected and reconnected
automatically.

## Testing

```bash
node test.mjs
```

## License

MIT — see [LICENSE](LICENSE)
