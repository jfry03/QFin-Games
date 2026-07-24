// Imposter — online multiplayer server.
//
// A single Node process that (a) serves the static client and (b) runs a
// WebSocket endpoint at /ws for real-time room state. Rooms live in memory
// keyed by a short code; there is no database. Each player's secret word is
// sent only to that player's own socket — never broadcast — so the game can't
// be won by inspecting network traffic.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// ---------------------------------------------------------------------------
// Word data + round logic (moved verbatim from the old client)
// ---------------------------------------------------------------------------

// Each category is a list of clusters. A cluster is an ORDERED similarity
// gradient: adjacent words are most alike, the ends are most different.
const WORDS = {
  "Everyday": [
    ["Comb","Hairbrush","Toothbrush","Razor","Nail clippers"],
    ["Cushion","Pillow","Blanket","Duvet","Sleeping bag"],
    ["Candle","Lantern","Flashlight","Desk lamp","Ceiling light"],
    ["Wallet","Handbag","Backpack","Suitcase","Briefcase"],
    ["Sponge","Mop","Broom","Bucket","Dustpan"],
    ["Paperclip","Stapler","Sticky tape","Glue stick","Scissors"],
    ["Touchpad","Mouse","Keyboard","Game controller","Remote control"],
    ["Sun hat","Sunglasses","Umbrella","Raincoat","Wellies"],
    ["Magnifying glass","Mirror","Window","Binoculars","Telescope"],
    ["Kettle","Toaster","Microwave","Oven","Stove"]
  ],
  "Food": [
    ["Pita","Naan","Flatbread","Calzone","Pizza"],
    ["Crepe","Pancake","Waffle","French toast","Bagel"],
    ["Noodles","Spaghetti","Macaroni","Ravioli","Lasagna"],
    ["Taco","Wrap","Sandwich","Hot dog","Cheeseburger"],
    ["Slushie","Sorbet","Frozen yogurt","Gelato","Ice cream"],
    ["Scone","Muffin","Cupcake","Croissant","Donut"],
    ["Mango","Pineapple","Honeydew","Cantaloupe","Watermelon"],
    ["Nuts","Crackers","Crisps","Pretzel","Popcorn"],
    ["Wonton","Dumpling","Spring roll","Sashimi","Sushi"],
    ["Tea","Espresso","Latte","Cappuccino","Coffee"]
  ],
  "Animals": [
    ["Lion","Tiger","Jaguar","Cheetah","Leopard"],
    ["Seal","Shark","Whale","Porpoise","Dolphin"],
    ["Starfish","Jellyfish","Cuttlefish","Squid","Octopus"],
    ["Lizard","Salamander","Newt","Toad","Frog"],
    ["Vulture","Eagle","Falcon","Hawk","Owl"],
    ["Albatross","Pelican","Seagull","Puffin","Penguin"],
    ["Bison","Buffalo","Hippo","Rhino","Elephant"],
    ["Squirrel","Hare","Rabbit","Wallaby","Kangaroo"],
    ["Gecko","Iguana","Lizard","Alligator","Crocodile"],
    ["Horse","Deer","Antelope","Zebra","Giraffe"]
  ],
  "Places": [
    ["Taxi rank","Subway","Bus terminal","Train station","Airport"],
    ["Waterfall","River","Lake","Swimming pool","Beach"],
    ["Office","Classroom","Study hall","Bookshop","Library"],
    ["Vet","Dentist","Pharmacy","Clinic","Hospital"],
    ["Pub","Nightclub","Bar","Arcade","Casino"],
    ["Botanical garden","Zoo","Aquarium","Art gallery","Museum"],
    ["Cottage","Mansion","Fortress","Palace","Castle"],
    ["Cave","Canyon","Glacier","Mountain","Volcano"],
    ["Opera house","Stadium","Concert hall","Theatre","Cinema"],
    ["Food truck","Diner","Restaurant","Cafe","Bakery"]
  ],
  "Movies": [
    ["Jumanji","Godzilla","King Kong","Jurassic Park","Jaws"],
    ["Brave","Encanto","Moana","Tangled","Frozen"],
    ["Coco","Cars","Up","Finding Nemo","Toy Story"],
    ["Dune","Interstellar","Guardians of the Galaxy","Star Trek","Star Wars"],
    ["Looper","Tenet","Interstellar","Inception","The Matrix"],
    ["Tarzan","Mulan","The Lion King","Aladdin","Shrek"],
    ["300","Braveheart","Gladiator","Creed","Rocky"],
    ["Goosebumps","Gremlins","Beetlejuice","Men in Black","Ghostbusters"],
    ["Percy Jackson","Eragon","Narnia","Lord of the Rings","Harry Potter"],
    ["Notting Hill","Pretty Woman","La La Land","The Notebook","Titanic"]
  ],
  "Sports": [
    ["Dodgeball","Handball","Volleyball","Netball","Basketball"],
    ["Racquetball","Table tennis","Squash","Badminton","Tennis"],
    ["Skiing","Snowboarding","Skateboarding","Bodyboarding","Surfing"],
    ["Wrestling","Judo","Karate","Kickboxing","Boxing"],
    ["Polo","Lacrosse","Hockey","Rugby","Football"],
    ["Tee-ball","Rounders","Cricket","Softball","Baseball"],
    ["Rowing","Cycling","Hurdles","Sprinting","Running"],
    ["Snooker","Darts","Bowling","Mini golf","Golf"],
    ["Discus","Javelin","Fencing","Shooting","Archery"],
    ["Trampolining","Diving","Gymnastics","Bouldering","Climbing"]
  ]
};

const ALL_CLUSTERS = Object.values(WORDS).flat();

// Exactly one imposter every round.
const IMPOSTER_COUNT = 1;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Returns an array of length `playerCount`: each entry { imposter, word }.
function buildRound(playerCount, similarity) {
  const cluster = pick(ALL_CLUSTERS);
  const ci = Math.floor(Math.random() * cluster.length);
  const crewWord = cluster[ci];

  const candidates = cluster
    .map((w, i) => ({ w, d: Math.abs(i - ci) }))
    .filter(o => o.d > 0)
    .sort((a, b) => a.d - b.d)
    .map(o => o.w);

  const frac = (5 - similarity) / 4;                 // 0..1
  const pos = candidates.length ? Math.round(frac * (candidates.length - 1)) : 0;
  const imposterWords = candidates.length
    ? [candidates[pos], ...candidates.filter((_, i) => i !== pos)]
    : [crewWord];

  const nImposters = Math.min(IMPOSTER_COUNT, playerCount - 1, imposterWords.length);

  const idx = [...Array(playerCount).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const imposters = idx.slice(0, nImposters);
  const wordFor = {};
  imposters.forEach((p, i) => { wordFor[p] = imposterWords[i]; });

  const roles = [];
  for (let p = 0; p < playerCount; p++) {
    if (p in wordFor) roles.push({ imposter: true, word: wordFor[p] });
    else roles.push({ imposter: false, word: crewWord });
  }
  return roles;
}

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

function createRoom() {
  const code = newCode();
  const room = {
    code,
    players: new Map(),   // playerId -> { id, name, ws, connected, word }
    hostId: null,
    settings: { similarity: 4, laps: 2, inPerson: false },
    phase: "lobby",       // lobby | round | assigned | vote | guess | result
    order: [],            // playerIds in clue-giving turn order
    turnIndex: 0,         // whose turn it is within order
    lap: 0,               // which clue lap (round) we're on, 0-based
    clues: [],            // shared history: { name, word }
    imposterId: null,     // SECRET: which player is the imposter
    crewWord: null,       // SECRET: the crew's word
    votes: {},            // voterId -> targetId
    result: null,         // reveal payload, populated when the game ends
    chat: [],             // shared chat log: { name, text }
  };
  rooms.set(code, room);
  return room;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Public view of the room shared with everyone. Never contains the crew word
// or the imposter's identity until the game reaches the reveal.
function lobbyState(room) {
  const st = {
    type: "state",
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    similarity: room.settings.similarity,
    laps: room.settings.laps,
    inPerson: room.settings.inPerson,
    lap: room.lap,
    order: room.order,
    turnIndex: room.turnIndex,
    clues: room.clues,
    chat: room.chat.slice(-60),
    players: [...room.players.values()]
      .filter(p => p.connected)
      .map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
    // public suspicion marks: voterId -> { targetId: 'like'|'dislike' }
    marks: Object.fromEntries(
      [...room.players.values()]
        .filter(p => p.connected && Object.keys(p.marks).length)
        .map(p => [p.id, p.marks])),
  };
  if (room.phase === "vote") {
    st.voters = Object.keys(room.votes);           // who has voted (not their choice)
    st.needed = connectedPlayers(room).length;
  }
  if (room.phase === "guess") {
    // The imposter has been caught, so revealing who is guessing is fine.
    st.caughtId = room.imposterId;
    st.caughtName = room.players.get(room.imposterId)?.name || "?";
  }
  if (room.phase === "result") st.result = room.result;
  return st;
}

function broadcastState(room) {
  const state = lobbyState(room);
  for (const p of room.players.values()) send(p.ws, state);
}

// If the host left, hand the crown to the next connected player.
function ensureHost(room) {
  if (room.hostId && room.players.get(room.hostId)?.connected) return;
  const next = connectedPlayers(room)[0];
  room.hostId = next ? next.id : null;
}

function destroyIfEmpty(room) {
  if (connectedPlayers(room).length === 0) rooms.delete(room.code);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handle(ws, msg) {
  switch (msg.type) {
    case "create": return onJoin(ws, { name: msg.name });
    case "join":   return onJoin(ws, { name: msg.name, code: msg.code, playerId: msg.playerId });
    case "rejoin": return onJoin(ws, { code: msg.code, playerId: msg.playerId, rejoinOnly: true });
    case "settings": return onSettings(ws, msg);
    case "start":  return onStart(ws);
    case "reveal": return onReveal(ws);
    case "clue":   return onClue(ws, msg);
    case "skip":   return onSkip(ws);
    case "vote":   return onVote(ws, msg);
    case "tally":  return onTally(ws);
    case "guess":  return onGuess(ws, msg);
    case "forfeit": return onForfeit(ws);
    case "lobby":  return onLobby(ws);
    case "chat":   return onChat(ws, msg);
    case "mark":   return onMark(ws, msg);
    case "leave":  return onLeave(ws);
  }
}

function onJoin(ws, { name, code, playerId, rejoinOnly }) {
  let room;
  if (code) {
    room = rooms.get(code.toUpperCase());
    if (!room) return send(ws, { type: "error", code: "no_room", message: "No room with that code." });
  } else {
    room = createRoom();
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
    player = { id: newId(), name: cleanName, ws, connected: true, word: null, marks: {} };
    room.players.set(player.id, player);
  }

  ws.roomCode = room.code;
  ws.playerId = player.id;
  ensureHost(room);

  send(ws, {
    type: "joined",
    code: room.code,
    playerId: player.id,
    you: { id: player.id, name: player.name },
  });
  // If they reconnected mid-round, resend their secret word + private marks.
  if ((room.phase === "round" || room.phase === "assigned") && player.word != null) {
    send(ws, { type: "round", word: player.word });
  }
  if (room.phase === "guess" && player.id === room.imposterId) {
    send(ws, { type: "guessPrompt" });
  }
  broadcastState(room);
}

function roomFor(ws) { return rooms.get(ws.roomCode); }
function isHost(ws, room) { return room && room.hostId === ws.playerId; }

function onSettings(ws, msg) {
  const room = roomFor(ws);
  if (!isHost(ws, room)) return;
  const s = parseInt(msg.similarity, 10);
  if (s >= 1 && s <= 5) room.settings.similarity = s;
  const l = parseInt(msg.laps, 10);
  if (l >= 1 && l <= 6) room.settings.laps = l;
  if (typeof msg.inPerson === "boolean") room.settings.inPerson = msg.inPerson;
  broadcastState(room);
}

function onStart(ws) {
  const room = roomFor(ws);
  if (!isHost(ws, room)) return;
  const players = connectedPlayers(room);
  if (players.length < 3) {
    return send(ws, { type: "error", code: "too_few", message: "Need at least 3 players." });
  }
  const roles = buildRound(players.length, room.settings.similarity);
  // "inPerson" mode just hands out the words; there is no on-phone clue/vote
  // flow, so the round sits in the "assigned" phase until the host reveals.
  room.phase = room.settings.inPerson ? "assigned" : "round";
  room.clues = [];
  room.turnIndex = 0;
  room.lap = 0;
  room.votes = {};
  room.result = null;
  room.imposterId = null;
  room.crewWord = null;
  // fresh suspicion marks each game
  players.forEach(p => { p.marks = {}; });
  // randomized clue-giving order (Fisher–Yates over the connected players)
  const order = players.map(p => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  room.order = order;
  players.forEach((p, i) => {
    p.word = roles[i].word;
    if (roles[i].imposter) room.imposterId = p.id;
    else room.crewWord = roles[i].word;   // every crew member shares this word
    send(p.ws, { type: "round", word: p.word });
  });
  broadcastState(room);
}

// "Just assign words" mode: the host ends the round and everyone sees the
// reveal (imposter + both words). There is no on-phone vote, so no winner.
function onReveal(ws) {
  const room = roomFor(ws);
  if (!isHost(ws, room) || room.phase !== "assigned") return;
  const nameOf = id => room.players.get(id)?.name || "?";
  room.result = {
    mode: "reveal",
    imposterId: room.imposterId,
    imposterName: nameOf(room.imposterId),
    crewWord: room.crewWord,
    imposterWord: room.players.get(room.imposterId)?.word || null,
  };
  room.phase = "result";
  broadcastState(room);
}

// Advance the turn. At the end of a lap, start the next lap; once all laps
// (rounds) are done, move everyone to the vote.
function advanceTurn(room) {
  room.turnIndex++;
  if (room.turnIndex >= room.order.length) {
    room.lap++;
    if (room.lap >= room.settings.laps) { startVote(room); return; }
    room.turnIndex = 0;   // next lap, same order
  }
  broadcastState(room);
}

function startVote(room) {
  room.phase = "vote";
  room.votes = {};
  broadcastState(room);
}

// Each player votes for who they think the imposter is.
function onVote(ws, msg) {
  const room = roomFor(ws);
  if (!room || room.phase !== "vote") return;
  const target = msg.target;
  if (!room.players.has(target) || target === ws.playerId) return;  // must pick another player
  room.votes[ws.playerId] = target;
  const allVoted = connectedPlayers(room).every(p => room.votes[p.id]);
  if (allVoted) resolveVotes(room);
  else broadcastState(room);
}

// Host can force the tally (e.g. someone dropped and can't vote).
function onTally(ws) {
  const room = roomFor(ws);
  if (isHost(ws, room) && room.phase === "vote") resolveVotes(room);
}

// The imposter is "caught" only if they receive a strict majority of the votes
// cast. Otherwise the imposter escapes and wins immediately.
function resolveVotes(room) {
  const cast = Object.values(room.votes);
  const total = cast.length;
  const forImposter = cast.filter(t => t === room.imposterId).length;
  const caught = total > 0 && forImposter * 2 > total;
  if (caught) {
    room.phase = "guess";
    send(room.players.get(room.imposterId)?.ws, { type: "guessPrompt" });
    broadcastState(room);
  } else {
    finalize(room, { caught: false, guess: null, winner: "imposter",
      reason: "The imposter dodged a majority vote and escaped." });
  }
}

// A caught imposter guesses the crew word. An exact match, or a guess that is a
// substring or superstring of the real word (case-insensitive), steals the win.
function onGuess(ws, msg) {
  const room = roomFor(ws);
  if (!room || room.phase !== "guess" || ws.playerId !== room.imposterId) return;
  const g = (msg.word || "").toString().trim();
  const gl = g.toLowerCase(), wl = (room.crewWord || "").toLowerCase();
  const correct = gl.length > 0 && (gl === wl || wl.includes(gl) || gl.includes(wl));
  finalize(room, {
    caught: true,
    guess: g,
    winner: correct ? "imposter" : "crew",
    reason: correct
      ? "Caught — but nailed the word and stole the win!"
      : "Caught, and the guess was wrong. Crew wins!",
  });
}

// Host fallback if a caught imposter disconnects before guessing.
function onForfeit(ws) {
  const room = roomFor(ws);
  if (isHost(ws, room) && room.phase === "guess") {
    finalize(room, { caught: true, guess: null, winner: "crew",
      reason: "No guess from the imposter. Crew wins!" });
  }
}

// Build the full reveal and end the game.
function finalize(room, o) {
  const nameOf = id => room.players.get(id)?.name || "?";
  const tallyMap = {};
  for (const t of Object.values(room.votes)) tallyMap[t] = (tallyMap[t] || 0) + 1;
  const tally = Object.entries(tallyMap)
    .map(([id, count]) => ({ id, name: nameOf(id), count }))
    .sort((a, b) => b.count - a.count);
  const votes = Object.entries(room.votes)
    .map(([voter, target]) => ({ voterName: nameOf(voter), targetName: nameOf(target) }));
  room.result = {
    imposterId: room.imposterId,
    imposterName: nameOf(room.imposterId),
    crewWord: room.crewWord,
    imposterWord: room.players.get(room.imposterId)?.word || null,
    caught: o.caught,
    guess: o.guess,
    winner: o.winner,          // "crew" | "imposter"
    reason: o.reason,
    tally,
    votes,
  };
  room.phase = "result";
  broadcastState(room);
}

// Host returns the room to the lobby (e.g. to change settings between games).
function onLobby(ws) {
  const room = roomFor(ws);
  if (!isHost(ws, room)) return;
  room.phase = "lobby";
  broadcastState(room);
}

// ---- chat + suspicion marks ----
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

// Public suspicion marks: each player marks others "like" / "dislike" (or
// clears it). Everyone sees the tallies via the broadcast state.
function onMark(ws, msg) {
  const room = roomFor(ws);
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player) return;
  const target = msg.target;
  if (!room.players.has(target) || target === ws.playerId) return;
  if (msg.value === "like" || msg.value === "dislike") player.marks[target] = msg.value;
  else delete player.marks[target];
  broadcastState(room);
}

// The player whose turn it is submits their one-word clue.
function onClue(ws, msg) {
  const room = roomFor(ws);
  if (!room || room.phase !== "round") return;
  if (room.order[room.turnIndex] !== ws.playerId) return;   // not your turn
  const word = (msg.word || "").toString().trim().slice(0, 40);
  if (!word) return;
  const player = room.players.get(ws.playerId);
  room.clues.push({ name: player ? player.name : "?", word });
  advanceTurn(room);
}

// Host can skip the current player (e.g. they disconnected or are stalling).
function onSkip(ws) {
  const room = roomFor(ws);
  if (!isHost(ws, room) || room.phase !== "round") return;
  const skippedId = room.order[room.turnIndex];
  const player = room.players.get(skippedId);
  room.clues.push({ name: player ? player.name : "?", word: "—", skipped: true });
  advanceTurn(room);
}

function onLeave(ws) {
  const room = roomFor(ws);
  if (!room) return;
  room.players.delete(ws.playerId);
  ensureHost(room);
  broadcastState(room);
  destroyIfEmpty(room);
}

function onDisconnect(ws) {
  const room = roomFor(ws);
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (player) player.connected = false;
  ensureHost(room);
  broadcastState(room);
  // Keep the room alive briefly so a reconnecting phone can rejoin; only tear
  // down once nobody has been connected for a while.
  setTimeout(() => { if (room) destroyIfEmpty(room); }, 60 * 1000);
}

// ---------------------------------------------------------------------------
// HTTP static server + WebSocket upgrade
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html", ".png": "image/png", ".css": "text/css", ".js": "text/javascript", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
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

server.listen(PORT, () => console.log(`Imposter server on http://localhost:${PORT}`));
