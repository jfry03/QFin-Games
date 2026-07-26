# QFin Games

Online multiplayer party games. A host creates a room and shares a 4-character
code; everyone else joins from their own device. Two games so far:

- **Imposter** — the crew all get the same secret word while one *imposter* gets
  a similar one. Players give one-word clues, then vote on who the imposter is; a
  caught imposter can steal the win by guessing the crew's word. 3+ players.
- **Avalon** — "The Resistance: Avalon". Good (Loyal Servants of Arthur) vs Evil
  (Minions of Mordred) with hidden roles (Merlin, Percival, Assassin, Morgana,
  Mordred, Oberon). A rotating leader nominates a quest team; everyone votes to
  approve it; approved teams run the quest, where evil may secretly sabotage.
  Good wins three quests — then must survive the Assassin's guess at Merlin.
  5–10 players. Team nomination and voting are on host-configurable timers.

The landing page at `/` lets players pick a game.

## Stack

- **Node.js** single process — serves the static clients and runs a WebSocket
  endpoint at `/ws`. Rooms live in memory; there is no database.
- **[ws](https://www.npmjs.com/package/ws)** — the only runtime dependency.
- Deployed behind **Caddy** (TLS + reverse proxy) as a `systemd` service.

Secrets (a player's word, an Avalon role) are sent only to that player's own
socket — never in the broadcast state — so the game can't be won by inspecting
network traffic.

## Run locally

```bash
npm install
npm start          # serves on http://localhost:3000  (override with PORT=…)
npm test           # fast in-process test of both games' rules
```

## Deploy

Deployment is a separate, manual step from pushing to GitHub:

```bash
git push           # 1. publish your changes to GitHub
./update.sh        # 2. make the live server run the latest committed code
```

`update.sh` SSHes into the server, pulls `main` from GitHub, installs
dependencies, and restarts the service. It's safe to re-run and bootstraps
itself on first use. It never pushes — it only *pulls* what's already on GitHub,
so always `git push` first.

## Layout

| Path                    | Purpose                                                   |
|-------------------------|-----------------------------------------------------------|
| `server.js`             | Game-agnostic host: rooms, players, chat, timers, routing |
| `games/imposter.js`     | Imposter rules (words, clues, vote, guess)                |
| `games/avalon.js`       | Avalon rules (roles, quests, timed votes, assassination)  |
| `public/home.html`      | Landing page — pick a game                                |
| `public/imposter.html`  | Imposter client                                           |
| `public/avalon.html`    | Avalon client                                             |
| `public/teams.html`     | Imposter team-mode variant                                |
| `tests/backend.test.js` | In-process rules test for both games                      |

### Adding a game

Each game is a factory `module.exports = (api) => ({ id, init, initPlayer,
publicState, onReconnect, onMessage, onPlayerGone? })` that `server.js` loads
into the `GAMES` map. The host provides `api` (send, broadcast, timers, host
checks, …); the module owns only its own rules and keeps state under `room.g`.
Add a static client at `public/<id>.html`, a route in `server.js`, and a card on
`public/home.html`.
