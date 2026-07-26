// Fast in-process backend test: drives the game modules directly with a fake
// `api`, firing phase timers manually so there are no real-time waits.
const path = require("path");
const crypto = require("crypto");
const ROOT = require("path").join(__dirname, "..");

const QUEST_TEAMS = { 5:[2,3,2,3,3], 6:[2,3,4,3,4], 7:[2,3,3,4,4], 8:[3,4,4,5,5], 9:[3,4,4,5,5], 10:[3,4,4,5,5] };
let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log("  ✓ " + l); } else { failed++; console.log("  ✗ FAIL: " + l); } }
const newId = () => crypto.randomBytes(9).toString("base64url");

// ---- fake harness mimicking server.js plumbing ----
function harness(factory, gameId) {
  const timers = {};
  const api = {
    send: (ws, msg) => { if (ws) ws._recv(msg); },
    broadcastState: (room) => {
      const base = {
        type: "state", code: room.code, game: room.gameId, phase: room.phase, hostId: room.hostId,
        players: [...room.players.values()].filter(p => p.connected).map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
        chat: room.chat.slice(-60),
      };
      room._state = Object.assign(base, game.publicState(room) || {});
      for (const p of room.players.values()) if (p.ws) p.ws._recv(room._state);
    },
    connectedPlayers: (room) => [...room.players.values()].filter(p => p.connected),
    ensureHost: () => {},
    isHost: (ws, room) => room.hostId === ws.playerId,
    playerId: (ws) => ws.playerId,
    nameOf: (room, id) => room.players.get(id)?.name || "?",
    newId,
    setTimer: (room, name, ms, fn) => { const at = Date.now() + ms; timers[room.code + ":" + name] = { fn, at }; return at; },
    clearTimer: (room, name) => { delete timers[room.code + ":" + name]; },
    clearTimers: (room) => { for (const k of Object.keys(timers)) if (k.startsWith(room.code + ":")) delete timers[k]; },
    timerDeadline: (room, name) => timers[room.code + ":" + name]?.at || null,
    now: () => Date.now(),
  };
  const game = factory(api);
  const fire = (room, name) => { const k = room.code + ":" + name; const t = timers[k]; if (t) { delete timers[k]; t.fn(); } };
  const hasTimer = (room, name) => !!timers[room.code + ":" + name];
  return { api, game, fire, hasTimer };
}

function makeRoom(game, gameId) {
  const room = { code: "TEST" + Math.floor(Math.random() * 1e6), gameId, game, players: new Map(), hostId: null, phase: "lobby", chat: [], g: {}, timers: {} };
  game.init(room);
  return room;
}
function join(room, game, name) {
  const player = { id: newId(), name, connected: true };
  player.ws = { playerId: player.id, _recv(m) { this.last = m; if (m.type === "role") this.role = m; if (m.type === "round") this.word = m.word; if (m.type === "guessPrompt") this.guessPrompt = true; } };
  game.initPlayer(room, player);
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}
const wsOf = (room, id) => room.players.get(id).ws;

// =====================================================================
function testImposter() {
  console.log("Imposter (backend):");
  const { game } = harness(require(path.join(ROOT, "games/imposter")), "imposter");
  const room = makeRoom(game, "imposter");
  const ps = ["Ann", "Bo", "Cy"].map(n => join(room, game, n));
  const host = ps[0].ws;
  game.onMessage(host, { type: "start" }, room);
  ok(room.phase === "round", "start -> round");
  ok(ps.every(p => p.ws.word), "everyone got a word");
  const impId = room.g.imposterId;
  const crewWords = ps.filter(p => p.id !== impId).map(p => p.ws.word);
  ok(crewWords[0] === crewWords[1], "crew share one word");
  ok(ps.find(p => p.id === impId).ws.word !== crewWords[0], "imposter word differs");

  // Play clues until vote (default 2 laps).
  let g = 0;
  while (room.phase === "round" && g++ < 20) {
    const turnId = room.g.order[room.g.turnIndex];
    game.onMessage(wsOf(room, turnId), { type: "clue", word: "c" + g }, room);
  }
  ok(room.phase === "vote", "clues done -> vote");
  // Crew vote imposter; imposter votes a crewmate -> 2/3 majority -> caught.
  const crew = ps.filter(p => p.id !== impId);
  crew.forEach(p => game.onMessage(p.ws, { type: "vote", target: impId }, room));
  game.onMessage(wsOf(room, impId), { type: "vote", target: crew[0].id }, room);
  ok(room.phase === "guess", "majority -> guess");
  ok(wsOf(room, impId).guessPrompt === true, "imposter got guessPrompt");
  game.onMessage(wsOf(room, impId), { type: "guess", word: "totally-wrong" }, room);
  ok(room.phase === "result" && room.g.result.winner === "crew", "wrong guess -> crew wins");

  // in-person "just assign words" mode
  game.onMessage(host, { type: "lobby" }, room);
  game.onMessage(host, { type: "settings", inPerson: true }, room);
  game.onMessage(host, { type: "start" }, room);
  ok(room.phase === "assigned", "inPerson -> assigned phase");
  game.onMessage(host, { type: "reveal" }, room);
  ok(room.phase === "result" && room.g.result.mode === "reveal", "reveal -> result");
}

// =====================================================================
function driveAvalon(game, room, fire, { sabotage }) {
  let guard = 0;
  while (guard++ < 80) {
    const g = room.g;
    if (room.phase === "proposal") {
      const n = g.order.length, size = QUEST_TEAMS[n][g.quest], lead = g.order[g.leaderIndex];
      let team;
      if (sabotage) { const evil = g.order.find(id => room.players.get(id).team === "evil"); team = [evil, ...g.order.filter(x => x !== evil)].slice(0, size); }
      else team = g.order.slice(0, size);
      game.onMessage(wsOf(room, lead), { type: "avPropose", members: team }, room);
    } else if (room.phase === "teamVote") {
      for (const id of g.order) game.onMessage(wsOf(room, id), { type: "avVote", approve: true }, room);
      fire(room, "phase"); // voteReveal -> next
    } else if (room.phase === "quest") {
      for (const id of g.team) { const ev = room.players.get(id).team === "evil"; game.onMessage(wsOf(room, id), { type: "avCard", success: sabotage && ev ? false : true }, room); }
      fire(room, "phase"); // questReveal -> next
    } else break; // assassinate | result
  }
}

function testAvalon() {
  console.log("Avalon (backend):");
  const { game, fire, hasTimer } = harness(require(path.join(ROOT, "games/avalon")), "avalon");
  const room = makeRoom(game, "avalon");
  const ps = ["Al", "Bea", "Cai", "Dee", "Eli"].map(n => join(room, game, n));
  const host = ps[0].ws;

  game.onMessage(host, { type: "start" }, room);
  ok(room.phase === "roleReveal", "start -> roleReveal");
  const roles = ps.map(p => p.ws.role.role).sort();
  ok(roles.includes("merlin") && roles.includes("assassin"), "Merlin + Assassin dealt");
  ok(ps.filter(p => p.team === "evil").length === 2, "2 evil for 5 players");
  const merlin = ps.find(p => p.role === "merlin");
  const merlinSeesEvil = merlin.ws.role.sees.length; // sees non-Mordred evil (>=1)
  ok(merlinSeesEvil >= 1, "Merlin sees evil player(s)");
  // evil (non-oberon) see each other
  const evils = ps.filter(p => p.team === "evil" && p.role !== "oberon");
  if (evils.length >= 2) ok(evils[0].ws.role.sees.length >= 1, "evil see fellow evil");

  game.onMessage(host, { type: "avBegin" }, room);
  ok(room.phase === "proposal", "avBegin -> proposal");
  ok(hasTimer(room, "phase"), "proposal has a nomination timer");
  ok(room._state.deadline > Date.now(), "state carries a nomination deadline");

  driveAvalon(game, room, fire, { sabotage: false });
  ok(room.phase === "assassinate", "3 quests passed -> assassinate");
  ok(room._state.score.good === 3, "good score = 3");

  // Morgana is the shooter (falls back to Assassin if absent).
  const shooter = () => ps.find(p => p.id === room.g.assassinId);
  ok(shooter().role === "morgana", "Morgana takes the assassination shot");
  const nonMerlin = ps.find(p => p.id !== shooter().id && p.role !== "merlin");
  game.onMessage(shooter().ws, { type: "avAssassinate", target: nonMerlin.id }, room);
  ok(room.phase === "result" && room.g.result.winner === "good", "shooter misses Merlin -> good wins");

  // play again, assassinate Merlin -> evil
  game.onMessage(host, { type: "start" }, room);
  game.onMessage(host, { type: "avBegin" }, room);
  driveAvalon(game, room, fire, { sabotage: false });
  ok(room.phase === "assassinate", "reached assassinate again");
  const merlin2 = ps.find(p => p.role === "merlin");
  game.onMessage(shooter().ws, { type: "avAssassinate", target: merlin2.id }, room);
  ok(room.g.result.winner === "evil", "shooter finds Merlin -> evil wins");

  // play again, evil sabotages 3 quests -> evil wins (no assassin phase)
  game.onMessage(host, { type: "start" }, room);
  game.onMessage(host, { type: "avBegin" }, room);
  driveAvalon(game, room, fire, { sabotage: true });
  ok(room.phase === "result" && room.g.result.winner === "evil", "3 sabotaged quests -> evil wins");
  const evilFails = room.g.questResults.filter(q => q && !q.success).length;
  ok(evilFails === 3, "exactly 3 failed quests recorded");
}

function testAvalonTimers() {
  console.log("Avalon timed nomination + voting (backend):");
  const { game, fire } = harness(require(path.join(ROOT, "games/avalon")), "avalon");
  const room = makeRoom(game, "avalon");
  const ps = ["Al", "Bea", "Cai", "Dee", "Eli"].map(n => join(room, game, n));
  const host = ps[0].ws;
  game.onMessage(host, { type: "settings", proposeSeconds: 45, voteSeconds: 30 }, room);
  ok(room.g.settings.proposeSeconds === 45 && room.g.settings.voteSeconds === 30, "settings applied");
  game.onMessage(host, { type: "start" }, room);
  game.onMessage(host, { type: "avBegin" }, room);
  ok(room.phase === "proposal", "at proposal");
  // Nomination timer fires with no team submitted -> auto-fill -> teamVote.
  fire(room, "phase");
  ok(room.phase === "teamVote", "nomination timeout -> auto-nominated team -> teamVote");
  ok(room.g.team.length === QUEST_TEAMS[5][0], "auto team is correct size");
  const leader = room.g.order[room.g.leaderIndex];
  ok(room.g.team.includes(leader), "auto team includes the leader");
  // Voting timer fires with NOBODY voting -> all count as reject -> rejected.
  fire(room, "phase");
  ok(room.phase === "voteReveal", "vote timeout -> voteReveal");
  ok(room.g.lastVote.approved === false && room.g.lastVote.timedOut === true, "no votes -> rejected on timeout");
  fire(room, "phase");
  ok(room.phase === "proposal" && room.g.rejectCount === 1, "rejection advances leader, rejectCount=1");

  // Five straight rejects -> evil wins.
  let guard = 0;
  while (room.phase === "proposal" && guard++ < 10) {
    fire(room, "phase"); // auto-nominate -> teamVote
    fire(room, "phase"); // vote timeout -> voteReveal (reject)
    fire(room, "phase"); // -> proposal or result
  }
  ok(room.phase === "result" && room.g.result.winner === "evil", "5 rejects in a row -> evil wins");
}

function testAvalonComposition() {
  console.log("Avalon per-seat role line-up (backend):");
  const { game } = harness(require(path.join(ROOT, "games/avalon")), "avalon");
  const room = makeRoom(game, "avalon");
  const ps = ["a", "b", "c", "d", "e"].map(n => join(room, game, n));
  const host = ps[0].ws;
  let st = game.publicState(room);
  ok(Array.isArray(st.composition) && st.composition.length === 5, "default line-up has one role per seat");
  ok(st.goodCount === 3 && st.evilCount === 2 && st.compValid === true, "default is 3 good / 2 evil and valid");

  // Custom line-up: 3 evil, no Merlin.
  game.onMessage(host, { type: "settings", composition: ["percival", "servant", "assassin", "morgana", "minion"] }, room);
  st = game.publicState(room);
  ok(st.evilCount === 3 && st.goodCount === 2 && st.compValid === true, "custom line-up -> 3 evil / 2 good");
  game.onMessage(host, { type: "start" }, room);
  ok(ps.filter(p => p.team === "evil").length === 3, "deals exactly the chosen 3 evil");
  ok(ps.map(p => p.role).sort().join(",") === "assassin,minion,morgana,percival,servant", "deals exactly the chosen roles");

  // Invalid: two Merlins -> can't start.
  game.onMessage(host, { type: "lobby" }, room);
  game.onMessage(host, { type: "settings", composition: ["merlin", "merlin", "servant", "assassin", "minion"] }, room);
  st = game.publicState(room);
  ok(st.compValid === false && /Merlin/.test(st.compReason), "duplicate special is invalid");
  let err = null; host._recv = m => { if (m.type === "error") err = m; };
  game.onMessage(host, { type: "start" }, room);
  ok(room.phase === "lobby" && err && /Merlin/.test(err.message), "start blocked on invalid line-up");

  // Invalid: all good -> needs an evil.
  game.onMessage(host, { type: "settings", composition: ["merlin", "percival", "servant", "servant", "servant"] }, room);
  ok(game.publicState(room).compValid === false, "no evil is invalid");

  // A 6th player joins -> line-up resizes to 6 seats.
  const p6 = join(room, game, "f");
  ok(game.publicState(room).composition.length === 6, "line-up resizes when a player joins");
}

testImposter();
testAvalon();
testAvalonTimers();
testAvalonComposition();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
