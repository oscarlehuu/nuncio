# Nuncio MCP

Nuncio ships a local stdio MCP server for agents that should inspect or steer
the running daemon. It is a thin proxy over the existing HTTP API; Nuncio does
not call model APIs.

## Run

Start the daemon first:

```bash
bun run --filter @nuncio/server start
```

Register the MCP entrypoint with your agent host:

```bash
bun --silent run mcp
```

The server reads:

- `NUNCIO_API_ORIGIN` — daemon origin, default `http://127.0.0.1:3000`
- `NUNCIO_AUTH_TOKEN` — optional Bearer token for non-loopback origins

## Claude Code

```json
{
  "mcpServers": {
    "nuncio": {
      "command": "bun",
      "args": ["--silent", "run", "mcp"],
      "cwd": "/Users/a1241968/Desktop/Oscar/nuncio-mission-control",
      "env": {
        "NUNCIO_API_ORIGIN": "http://127.0.0.1:3000"
      }
    }
  }
}
```

## Codex

```toml
[mcp_servers.nuncio]
command = "bun"
args = ["--silent", "run", "mcp"]
cwd = "/Users/a1241968/Desktop/Oscar/nuncio-mission-control"

[mcp_servers.nuncio.env]
NUNCIO_API_ORIGIN = "http://127.0.0.1:3000"
```

For a remote or tailnet daemon, set `NUNCIO_API_ORIGIN` to that URL and include
`NUNCIO_AUTH_TOKEN`. HTTP MCP is intentionally not shipped yet; the future
`/api/mcp` transport will reuse AuthGuard and ADR-008 token/tailnet auth.

## Tools

- `nuncio_list_sessions`
- `nuncio_get_session`
- `nuncio_get_timeline`
- `nuncio_get_attention`
- `nuncio_get_fleet`
- `nuncio_list_loops`
- `nuncio_enqueue_task`
- `nuncio_pause_loop`

Only `nuncio_enqueue_task` and `nuncio_pause_loop` mutate state. There are no
archive, delete, restore, settings, cancel, or retry tools in v1.
