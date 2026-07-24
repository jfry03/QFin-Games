# Imposter

Online multiplayer "Imposter" word game. A host creates a room and shares a
4-character code; everyone else joins from any device. Each round, the crew all
receive the same secret word while one **imposter** gets a similar-but-different
word — players give one-word clues, then vote on who they think the imposter is.

## Stack

- **Node.js** single process — serves the static client and runs a WebSocket
  endpoint at `/ws`. Rooms live in memory; there is no database.
- **[ws](https://www.npmjs.com/package/ws)** — the only runtime dependency.
- Deployed behind **Caddy** (TLS + reverse proxy) as a `systemd` service.

## Run locally

```bash
npm install
npm start          # serves on http://localhost:3000  (override with PORT=…)
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

## Files

| File            | Purpose                                             |
|-----------------|-----------------------------------------------------|
| `server.js`     | HTTP static server + WebSocket game logic           |
| `index.html`    | Game client (lobby, clue/vote/guess flow)           |
| `teams.html`    | Team-mode variant                                   |
| `package.json`  | Metadata + the single `ws` dependency               |
