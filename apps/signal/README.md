# @mjm/signal

The WebSocket relay and club server for Mahjong Madness. By default every table runs on the server, which acts as a neutral host, and players connect to it through the relay.

```bash
PORT=8787 npm start
```

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | TCP port for both HTTP and WebSocket traffic |
| `HOST_TABLES` | on | Set to `0` to stop the server hosting tables. A hosted `create` is then refused with `Hosted tables are disabled` (never turned into a relay-only room) |
| `DATA_DIR` | `./data` | Directory that holds `clubs.json`. Tables do not survive a restart, so club tables still open or playing at shutdown are marked finished when the file is loaded |
| `TRUST_PROXY` | `0` (off) | The number of reverse proxies you run in front of the server. The client IP is then the `x-forwarded-for` entry that many places from the right: `1` takes the rightmost entry (the address your proxy appended), `2` the one before it, and so on. Entries further left are written by the client and are never used. Set it to exactly the number of proxies; with `0` the header is ignored and the TCP peer address is used. `true`/`on` still mean `1` |
| `CORS_ORIGINS` | none | Comma-separated list of browser origins allowed to call the HTTP API. With no list, CORS headers are never sent, so only same-origin pages (and native apps, which are not subject to CORS) can call it. For the Expo web preview use `CORS_ORIGINS=http://localhost:8081`. `*` allows any origin |
| `MAX_HOSTED_TABLES` | `500` | Maximum number of tables the server hosts at once |
| `P2P_ROOMS` | off | Set to `1` to allow relay-only rooms in which a player's device is the host. For development only |

## Limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| WebSockets per IP | 20 at once | The extra socket is closed with 1008 `Too many connections` |
| Messages per socket | 30/s, burst 60 | The socket is closed with 1008 `Rate limit exceeded` |
| Message size | 64 KiB | The socket is closed with 1009 (message too big). A malformed frame closes it with 1002 (or 1007 for text that is not UTF-8). Other sockets are unaffected |
| HTTP requests per IP | 10/s, burst 30 | `429 {error:"rate_limited"}` with `retry-after: 1` |
| HTTP body | 64 KiB (bytes) | `400 {error:"invalid"}` |
| Room creation | 1 per 10 s per connection | `{t:"error", message:"Please wait a few seconds before creating another room"}` |
| Join attempts | 5 per 10 s per connection (refills at one every 2 s) | `{t:"error", message:"Too many join attempts; please wait a few seconds"}` |
| Hosted tables | `MAX_HOSTED_TABLES` | Socket: `The server is full right now; …`. API: `503 {error:"unavailable"}` |
| Peers per room | 12 | `Room not found or full` (the same reply as for an unknown code, so codes cannot be probed) |
| Clubs per user | 10 (owned, joined or pending) | `409 {error:"limit"}` |
| Members per club | 200 (pending requests have the same cap) | `409 {error:"limit"}` |
| Open tables per club | 5 (finished tables do not count) | `409 {error:"limit"}` |
| Stored identities | 50,000 | The least recently used identity that belongs to no club is forgotten. A user's secret is stored only after a successful create or join; requests that fail, or leave the user in no club, store nothing |

Room codes, club codes and peer ids come from the platform's secure random source. Each random byte is masked with `& 31` to index a 32-character alphabet, which avoids modulo bias.

Every rule set received from a client (WebSocket `create`, club create/update, table create) goes through `sanitizeRules`. Unknown keys are dropped, numbers are clamped to `RULE_LIMITS`, and booleans must be real booleans. Club settings keep only the two known booleans. A field that has the wrong type returns `400`, never `500`.

## Protocol (JSON frames)

Client → server
| Message | Purpose |
| --- | --- |
| `{t:"hello"}` | Identify. The server replies `{t:"hello", peerId}`; the id is assigned by the server and never changes |
| `{t:"create", hosted:true, rules?, botSkill?}` | Create a room whose table the server hosts. `botSkill` is `beginner`, `club` or `pro`. Without `hosted:true` the request is refused unless `P2P_ROOMS=1`; with `hosted:true` and `HOST_TABLES=0` it is refused with `Hosted tables are disabled` |
| `{t:"join", room}` | Join by code (case-insensitive) |
| `{t:"to", to, data}` | Relay `data` to a peer in the same room |
| `{t:"leave"}` | Leave the room |

Server → client
| Message | Purpose |
| --- | --- |
| `{t:"room", room, peers, host}` | Sent once in reply to each successful `create` or `join`. `host` is the peer to send game messages to |
| `{t:"peer", peerId, event}` | A peer joined or left |
| `{t:"from", from, data}` | Relayed data |
| `{t:"error", message}` | Sent once in reply to a refused `create` or `join` |
| `{t:"error", code:"closed", message}` | The host of a relay-only room left, so the room has closed. Sent unprompted to every peer still in it; they are no longer in a room |

The host role never moves: a relay-only room closes when its host leaves, because a guest promoted to host would hold none of the table's state.

Game traffic is wrapped as `{ch:"game", msg}`, so other channels can share the same socket.

`GET /health` returns `{ ok, peers, rooms, hostedTables }`.
