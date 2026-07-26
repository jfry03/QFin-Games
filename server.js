// QFin Games — online multiplayer party-game host.
//
// A single Node process that (a) serves the static clients and (b) runs a
// WebSocket endpoint at /ws for real-time room state. Rooms live in memory
// keyed by a short code; there is no database.
//
// This file is game-agnostic plumbing: it owns rooms, players, host handoff,
// chat, connection lifecycle, and phase timers. Each game (Imposter, Avalon)
// is a self-contained module under ./games that plugs into a small interface
// (see `api` below). Anything secret — a player's word, an Avalon role — is
// sent only to that player's own socket, never in the broadcast state.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room

// Avoid ambiguous characters (0/O, 1/I) in codes players type in.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function newId() { return crypto.randomBytes(9).toString("base64url"); }

function createRoom(gameId) {
  const game = GAMES[gameId] || GAMES.imposter;
  const code = newCode();
  const room = {
    code,
    gameId: game.id,
    game,
    players: new Map(),   // playerId -> { id, name, ws, connected, ... game fields }
    hostId: null,
    phase: "lobby",
    chat: [],             // shared chat log: { name, text }
    g: {},                // game-specific state (namespaced so games can't collide)
    timers: {},           // name -> { handle, at }  (phase countdowns)
  };
  game.init(room);
  rooms.set(code, room);
  return room;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}
function nameOf(room, id) { return room.players.get(id)?.name || "?"; }

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---- phase timers ----------------------------------------------------------
// Games use these for nomination / voting countdowns. Each timer stores its
// fire-at wall-clock time so the public state can carry a `deadline` the client
// counts down to. Firing removes the entry, then runs the callback.
function setTimer(room, name, ms, fn) {
  clearTimer(room, name);
  const at = Date.now() + ms;
  const handle = setTimeout(() => {
    delete room.timers[name];
    if (rooms.has(room.code)) fn();
  }, ms);
  room.timers[name] = { handle, at };
  return at;
}
function clearTimer(room, name) {
  const t = room.timers[name];
  if (t) { clearTimeout(t.handle); delete room.timers[name]; }
}
function clearTimers(room) { for (const n of Object.keys(room.timers)) clearTimer(room, n); }
function timerDeadline(room, name) { return room.timers[name]?.at || null; }

// ---- broadcast -------------------------------------------------------------
// The base state is common to every game; the game module contributes the rest
// via publicState(). Secrets never appear here.
function baseState(room) {
  return {
    type: "state",
    code: room.code,
    game: room.gameId,
    phase: room.phase,
    hostId: room.hostId,
    players: [...room.players.values()]
      .filter(p => p.connected)
      .map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
    // Everyone in the room, including players who dropped (connected: false), so
    // the host can see who's missing and hand them a reconnect link.
    roster: [...room.players.values()]
      .map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected, chips: p.chips })),
    chat: room.chat.slice(-60),
  };
}
function broadcastState(room) {
  const state = Object.assign(baseState(room), room.game.publicState(room) || {});
  for (const p of room.players.values()) send(p.ws, state);
}

// If the host left, hand the crown to the next connected player.
function ensureHost(room) {
  if (room.hostId && room.players.get(room.hostId)?.connected) return;
  const next = connectedPlayers(room)[0];
  room.hostId = next ? next.id : null;
}
function destroyIfEmpty(room) {
  if (connectedPlayers(room).length === 0) { clearTimers(room); rooms.delete(room.code); }
}

function roomFor(ws) { return rooms.get(ws.roomCode); }
function isHost(ws, room) { return room && room.hostId === ws.playerId; }

// The toolkit handed to each game module so it never touches `rooms` directly.
const api = {
  send, broadcastState, connectedPlayers, ensureHost,
  isHost: (ws, room) => isHost(ws, room),
  playerId: ws => ws.playerId,
  nameOf,
  newId,
  setTimer, clearTimer, clearTimers, timerDeadline,
  now: () => Date.now(),
};

// Games are loaded as factories so they capture `api` once.
const GAMES = {
  imposter: require("./games/imposter")(api),
  avalon:   require("./games/avalon")(api),
};

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handle(ws, msg) {
  switch (msg.type) {
    case "create": return onJoin(ws, { name: msg.name, gameId: msg.game });
    case "join":   return onJoin(ws, { name: msg.name, code: msg.code, playerId: msg.playerId });
    case "rejoin": return onJoin(ws, { code: msg.code, playerId: msg.playerId, rejoinOnly: true });
    case "chat":   return onChat(ws, msg);
    case "kick":   return onKick(ws, msg);
    case "leave":  return onLeave(ws);
    default: {
      // Everything else is game-specific.
      const room = roomFor(ws);
      if (room) room.game.onMessage(ws, msg, room);
    }
  }
}

function onJoin(ws, { name, code, playerId, gameId, rejoinOnly }) {
  let room;
  if (code) {
    room = rooms.get(code.toUpperCase());
    if (!room) return send(ws, { type: "error", code: "no_room", message: "No room with that code." });
  } else {
    room = createRoom(gameId);
  }

  // Reconnect path: known player rejoining (e.g. after a phone screen lock).
  let player = playerId ? room.players.get(playerId) : null;
  if (player) {
    player.ws = ws;
    player.connected = true;
    if (name) player.name = name;
  } else {
    if (rejoinOnly) return send(ws, { type: "error", code: "gone", message: "That session expired." });
    const cleanName = (name || "Player").toString().trim().slice(0, 20) || "Player";
    player = { id: newId(), name: cleanName, ws, connected: true };
    room.game.initPlayer(room, player);
    room.players.set(player.id, player);
  }

  ws.roomCode = room.code;
  ws.playerId = player.id;
  ensureHost(room);

  send(ws, {
    type: "joined",
    code: room.code,
    game: room.gameId,
    playerId: player.id,
    you: { id: player.id, name: player.name },
  });
  // Resend any per-player private info (secret word, Avalon role, prompts).
  room.game.onReconnect(room, player);
  broadcastState(room);
}

function onChat(ws, msg) {
  const room = roomFor(ws);
  if (!room) return;
  const text = (msg.text || "").toString().trim().slice(0, 240);
  if (!text) return;
  const player = room.players.get(ws.playerId);
  room.chat.push({ name: player ? player.name : "?", text });
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
  broadcastState(room);
}

function onLeave(ws) {
  const room = roomFor(ws);
  if (!room) return;
  room.players.delete(ws.playerId);
  ensureHost(room);
  if (room.game.onPlayerGone) room.game.onPlayerGone(room);
  broadcastState(room);
  destroyIfEmpty(room);
}

// Host removes another player from the room. The kicked player's client is told
// so it can drop its session (otherwise it would just auto-rejoin).
function onKick(ws, msg) {
  const room = roomFor(ws);
  if (!isHost(ws, room)) return;
  const target = msg.target;
  if (!target || target === ws.playerId) return;   // can't kick yourself
  const player = room.players.get(target);
  if (!player) return;
  send(player.ws, { type: "kicked", message: "The host removed you from the room." });
  if (player.ws) { player.ws.roomCode = null; player.ws.playerId = null; }
  room.players.delete(target);
  ensureHost(room);
  if (room.game.onPlayerGone) room.game.onPlayerGone(room);
  broadcastState(room);
  destroyIfEmpty(room);
}

function onDisconnect(ws) {
  const room = roomFor(ws);
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (player) player.connected = false;
  ensureHost(room);
  if (room.game.onPlayerGone) room.game.onPlayerGone(room);
  broadcastState(room);
  // Keep the room alive briefly so a reconnecting phone can rejoin; only tear
  // down once nobody has been connected for a while.
  setTimeout(() => { if (rooms.get(room.code) === room) destroyIfEmpty(room); }, 60 * 1000);
}

// ---------------------------------------------------------------------------
// HTTP static server + WebSocket upgrade
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html", ".png": "image/png", ".css": "text/css", ".js": "text/javascript", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

// Friendly routes -> files in public/. Anything else is looked up literally.
const ROUTES = {
  "/": "/home.html",
  "/imposter": "/imposter.html",
  "/avalon": "/avalon.html",
  "/teams": "/teams.html",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (ROUTES[urlPath]) urlPath = ROUTES[urlPath];
  // Resolve within PUBLIC_DIR and reject path traversal.
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // Always revalidate so a redeploy is picked up immediately (no stale page).
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg.type === "string") handle(ws, msg);
  });
  ws.on("close", () => onDisconnect(ws));
  ws.on("error", () => {});
});

// Ping every 30s and drop sockets that stopped answering (dead phones/tabs).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000);

server.listen(PORT, () => console.log(`QFin Games server on http://localhost:${PORT}`));
