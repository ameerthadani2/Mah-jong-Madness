# @mjm/signal

WebSocket signaling and relay server for Mahjong Madness rooms.

```bash
PORT=8787 HOST_TABLES=1 npm start
```

## Protocol (JSON frames)

Client → server
| Message | Purpose |
| --- | --- |
| `{t:"hello", peerId?}` | Identify; server replies `{t:"hello", peerId}` |
| `{t:"create", room?, hosted?, rules?}` | Create a room. `hosted:true` makes the server run the table |
| `{t:"join", room}` | Join by code (case-insensitive) |
| `{t:"to", to, data}` | Relay `data` to a peer in the same room |
| `{t:"leave"}` | Leave the room |

Server → client
| Message | Purpose |
| --- | --- |
| `{t:"room", room, peers, host}` | Room joined/created; `host` is the peer to send game messages to |
| `{t:"peer", peerId, event}` | A peer joined/left |
| `{t:"from", from, data}` | Relayed data |
| `{t:"error", message}` | Something went wrong |

Game traffic is wrapped as `{ch:"game", msg}` and WebRTC signaling as `{ch:"rtc", msg}` so both can share one socket.

`GET /health` returns `{ ok, peers, rooms, hostedTables }`.
