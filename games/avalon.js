// Avalon — "The Resistance: Avalon", as a QFin Games module.
//
// Good (Loyal Servants of Arthur) vs Evil (Minions of Mordred). Over five
// quests a rotating leader nominates a team; everyone votes to approve or
// reject it; an approved team runs the quest, where evil players may secretly
// sabotage. Good wins by passing three quests — but then the Assassin gets one
// shot to name Merlin and steal the game. Evil wins on three failed quests, or
// five rejected nominations in a row.
//
// Secrets (each player's role and what they secretly see at night) are sent
// only to that player's own socket. The broadcast state never contains them
// until the final reveal. Rooms/players/chat/host handoff live in ../server.js.

const MIN_PLAYERS = 5, MAX_PLAYERS = 10;

// Team size for each quest, indexed by player count then quest (0-based).
const QUEST_TEAMS = {
  5:  [2, 3, 2, 3, 3],
  6:  [2, 3, 4, 3, 4],
  7:  [2, 3, 3, 4, 4],
  8:  [3, 4, 4, 5, 5],
  9:  [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};
// Number of evil players by player count (the rest are good).
const EVIL_COUNT = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

const ROLE_META = {
  merlin:   { team: "good", label: "Merlin" },
  percival: { team: "good", label: "Percival" },
  servant:  { team: "good", label: "Loyal Servant of Arthur" },
  drunkpercival:     { team: "good", label: "Drunk Percival" },
  unreliableservant: { team: "good", label: "Unreliable Loyal Servant" },
  assassin: { team: "evil", label: "Assassin" },
  morgana:  { team: "evil", label: "Morgana" },
  mordred:  { team: "evil", label: "Mordred" },
  oberon:   { team: "evil", label: "Oberon" },
  minion:   { team: "evil", label: "Minion of Mordred" },
};
const ROLE_BLURB = {
  merlin:   "You know who the evil players are — but Mordred is hidden from you. Guide good subtly: if evil identifies you, the Assassin will kill you at the end.",
  percival: "You can see Merlin — but Morgana looks just like him. Work out which is real and protect them.",
  servant:  "A loyal servant of Arthur. You know nothing for certain — reason from how the quests go.",
  // The Drunk Percival never sees this blurb — they're shown Percival's instead.
  drunkpercival: "You think you're Percival, but the two you see are random — your info can't be trusted.",
  unreliableservant: "A loyal servant of Arthur — but shaky. On the first two quests your success card has a 1-in-3 chance of coming out as a FAIL, and you won't know when.",
  assassin: "A minion of Mordred. If good passes three quests, you get one shot to name Merlin and steal the win.",
  morgana:  "A minion of Mordred who appears to Percival as Merlin. Sow confusion.",
  mordred:  "A minion of Mordred hidden from Merlin — Merlin does not know you are evil.",
  oberon:   "A minion of Mordred who works alone: you don't know the other evil players, and they don't know you.",
  minion:   "A minion of Mordred. Sabotage quests and stay hidden.",
};
const EVIL_ROLES = ["assassin", "morgana", "mordred", "oberon", "minion"];

// How long the vote/quest reveal screens linger before the game moves on.
// Overridable via env so automated tests can run fast.
const VOTE_REVEAL_MS  = parseInt(process.env.AV_VOTE_REVEAL_MS  || "6000", 10);
const QUEST_REVEAL_MS = parseInt(process.env.AV_QUEST_REVEAL_MS || "7000", 10);
// A player's "time chip" freezes the current nomination/voting clock for a break.
const TIMEOUT_MS = parseInt(process.env.AV_TIMEOUT_MS || "180000", 10);   // 3 minutes
const CHIPS_PER_GAME = 1;

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The host builds an explicit line-up: one role per seat (= per player), chosen
// from dropdowns, then the roles are shuffled out to players when dealt. Special
// roles may appear at most once; Loyal Servant / Minion are unlimited fillers.
const SPECIAL_ROLES = ["merlin", "percival", "drunkpercival", "unreliableservant", "assassin", "morgana", "mordred", "oberon"];
const ALL_ROLE_KEYS = [...SPECIAL_ROLES, "servant", "minion"];

// A sensible starting line-up for `n` players — the host can change every seat.
function defaultComposition(n) {
  const evilCount = EVIL_COUNT[n] || Math.max(1, Math.round(n / 3));
  const goodCount = Math.max(1, n - evilCount);
  const good = ["merlin"];
  if (goodCount >= 3) good.push("percival");
  while (good.length < goodCount) good.push("servant");
  const evil = ["assassin"];
  if (evilCount >= 2) evil.push("morgana");
  while (evil.length < evilCount) evil.push("minion");
  return [...good.slice(0, goodCount), ...evil.slice(0, evilCount)];
}

// Is a line-up legal to deal? Specials unique, at least one of each side.
function validateComposition(comp) {
  for (const r of comp) if (!ALL_ROLE_KEYS.includes(r)) return { valid: false, reason: "Unknown role in the line-up." };
  for (const s of SPECIAL_ROLES) if (comp.filter(r => r === s).length > 1)
    return { valid: false, reason: ROLE_META[s].label + " can only be in the game once." };
  const evil = comp.filter(r => ROLE_META[r].team === "evil").length;
  const good = comp.length - evil;
  if (evil < 1) return { valid: false, reason: "Add at least one evil role." };
  if (good < 1) return { valid: false, reason: "Add at least one good role." };
  return { valid: true, reason: null, good, evil };
}

module.exports = (api) => {
  const { send, broadcastState, connectedPlayers, isHost,
          setTimer, clearTimer, clearTimers, timerDeadline } = api;
  const nameOf = (room, id) => api.nameOf(room, id);

  function initPlayer(room, player) {
    player.role = null;
    player.team = null;
    player.knows = null;      // [{ id, note }] — SECRET
    player.seesLabel = null;  // heading for the "you see" list — SECRET
    player.chips = room.g.settings.chipCount;   // "time chip" timeouts left this game
  }

  function init(room) {
    room.g = {
      settings: {
        proposeSeconds: 90,   // nomination time limit
        voteSeconds: 60,      // voting window once a team is nominated
        // The role line-up: one entry per seat. null = derive a default from the
        // player count; the host edits it seat-by-seat in the lobby.
        composition: null,
        chipCount: CHIPS_PER_GAME,                        // time-out chips per player per game
        chipSeconds: Math.max(1, Math.round(TIMEOUT_MS / 1000)),  // how long a time-out freezes the clock
      },
      order: [],            // seat order (playerIds), fixed for the game
      leaderIndex: 0,
      quest: 0,             // current quest, 0-based
      questResults: [],     // [{ success, fails }]
      rejectCount: 0,       // consecutive rejected nominations
      team: [],             // currently proposed / active team (ids)
      votes: {},            // id -> bool (approve)
      cards: {},            // id -> bool (success)  SECRET counts only until reveal
      lastVote: null,       // reveal payload for the just-finished team vote
      lastQuest: null,      // reveal payload for the just-finished quest
      voteHistory: [],      // every resolved nomination (public once revealed)
      missionHistory: [],   // every completed quest
      paused: false,        // host paused the current nomination/vote timer
      pauseRemaining: 0,    // ms left on the timer when it was paused
      timeout: null,        // { by, remaining, until } while a time-chip break runs
      assassinId: null,
      result: null,
    };
  }

  // The role line-up to deal, always resized to the current player count. An
  // unset or stale line-up falls back to (or extends from) the default. Persists
  // the resized version so the host's dropdowns stay in sync as players join/leave.
  function getComposition(room) {
    const n = connectedPlayers(room).length;
    let comp = room.g.settings.composition;
    if (!Array.isArray(comp) || comp.length === 0) comp = defaultComposition(n);
    if (comp.length < n) comp = [...comp, ...Array(n - comp.length).fill("servant")];
    else if (comp.length > n) comp = comp.slice(0, n);
    room.g.settings.composition = comp;
    return comp;
  }

  // ---- role dealing + night knowledge -------------------------------------
  function deal(room) {
    const g = room.g;
    const players = connectedPlayers(room);
    const n = players.length;
    const order = shuffle(players.map(p => p.id));
    const dealt = shuffle(getComposition(room));

    order.forEach((id, i) => {
      const p = room.players.get(id);
      p.role = dealt[i];
      p.team = ROLE_META[p.role].team;
      p.knows = [];
      p.seesLabel = null;
    });

    const roleOf = id => room.players.get(id).role;
    const evilIds   = order.filter(id => ROLE_META[roleOf(id)].team === "evil");
    const oberonId  = order.find(id => roleOf(id) === "oberon");
    const merlinId  = order.find(id => roleOf(id) === "merlin");
    const morganaId = order.find(id => roleOf(id) === "morgana");
    const knownEvil = evilIds.filter(id => id !== oberonId); // evil who know each other

    order.forEach(id => {
      const p = room.players.get(id);
      const role = p.role;
      if (role === "merlin") {
        // Merlin sees all evil except Mordred (and does see Oberon).
        p.seesLabel = "Minions of Mordred (Mordred himself is hidden)";
        p.knows = evilIds.filter(e => roleOf(e) !== "mordred").map(e => ({ id: e, note: "Evil" }));
      } else if (role === "percival") {
        const cands = shuffle([merlinId, morganaId].filter(Boolean));
        p.seesLabel = morganaId ? "Merlin — but one of these is the impostor Morgana" : "Merlin";
        p.knows = cands.map(c => ({ id: c, note: "Merlin?" }));
      } else if (role === "drunkpercival") {
        // Thinks they're Percival, but sees two RANDOM players (bad info).
        const two = shuffle(order.filter(x => x !== id)).slice(0, 2);
        p.seesLabel = "Merlin — but one of these is the impostor Morgana";
        p.knows = two.map(c => ({ id: c, note: "Merlin?" }));
      } else if (role === "oberon") {
        p.seesLabel = null;
        p.knows = [];
      } else if (ROLE_META[role].team === "evil") {
        p.seesLabel = "Your fellow minions of Mordred";
        p.knows = knownEvil.filter(e => e !== id).map(e => ({ id: e, note: "Evil" }));
      } else {
        p.seesLabel = null;
        p.knows = [];
      }
    });

    g.order = order;
    g.leaderIndex = Math.floor(Math.random() * n);
  }

  function roleMessage(room, player) {
    const meta = ROLE_META[player.role];
    // The Drunk Percival is shown the ordinary Percival card so they don't know
    // their sight is unreliable.
    const disguised = player.role === "drunkpercival";
    return {
      type: "role",
      role: disguised ? "percival" : player.role,
      roleLabel: disguised ? "Percival" : meta.label,
      team: meta.team,
      blurb: disguised ? ROLE_BLURB.percival : ROLE_BLURB[player.role],
      seesLabel: player.seesLabel,
      sees: (player.knows || []).map(k => ({ name: nameOf(room, k.id), note: k.note })),
    };
  }

  // ---- public (secret-free) state -----------------------------------------
  function publicState(room) {
    const g = room.g, n = g.order.length;
    const good = g.questResults.filter(q => q && q.success).length;
    const evil = g.questResults.filter(q => q && !q.success).length;
    const st = {
      settings: {
        proposeSeconds: g.settings.proposeSeconds,
        voteSeconds: g.settings.voteSeconds,
        chipCount: g.settings.chipCount,
        chipSeconds: g.settings.chipSeconds,
      },
      order: g.order,
      leaderId: g.order.length ? g.order[g.leaderIndex] : null,
      quest: g.quest,
      questResults: g.questResults,
      rejectCount: g.rejectCount,
      score: { good, evil },
      voteHistory: g.voteHistory,        // all past nominations (public once revealed)
      missionHistory: g.missionHistory,  // all completed quests
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
    if (room.phase === "lobby") {
      const c = connectedPlayers(room).length;
      const ok = c >= MIN_PLAYERS && c <= MAX_PLAYERS;
      st.playerCount = c;
      st.teamSizes = ok ? QUEST_TEAMS[c] : null;
      if (ok) {
        const comp = getComposition(room);
        const v = validateComposition(comp);
        st.composition = comp;                                        // one role per seat
        st.goodCount = comp.filter(r => ROLE_META[r].team === "good").length;
        st.evilCount = comp.filter(r => ROLE_META[r].team === "evil").length;
        st.compValid = v.valid;
        st.compReason = v.reason;
        st.canStart = v.valid;
      } else {
        st.composition = null;
        st.canStart = false;
      }
    }
    if (room.phase === "proposal" || room.phase === "teamVote" || room.phase === "voteReveal") {
      st.leaderId = g.order[g.leaderIndex];
      st.teamSize = QUEST_TEAMS[n] ? QUEST_TEAMS[n][g.quest] : 0;
      st.team = g.team;
    }
    if (room.phase === "proposal" || room.phase === "teamVote") {
      st.paused = g.paused;
      st.pauseRemaining = g.pauseRemaining;
      st.timeout = g.timeout ? { by: g.timeout.by, until: g.timeout.until } : null;
      st.deadline = (g.paused || g.timeout) ? null : timerDeadline(room, "phase");
    }
    if (room.phase === "teamVote") {
      st.voted = Object.keys(g.votes);
      st.voteNeeded = electorate(room).length;
    }
    if (room.phase === "voteReveal") st.lastVote = g.lastVote;
    if (room.phase === "quest") {
      st.team = g.team;
      st.cardsIn = Object.keys(g.cards).length;
      st.teamCount = g.team.length;
    }
    if (room.phase === "questReveal") st.lastQuest = g.lastQuest;
    if (room.phase === "assassinate") {
      st.assassinId = g.assassinId;
      st.assassinName = nameOf(room, g.assassinId);
    }
    if (room.phase === "result") st.result = g.result;
    return st;
  }

  function onReconnect(room, player) {
    if (player.role && room.phase !== "lobby") send(player.ws, roleMessage(room, player));
  }

  // players in seat order who are currently connected (the electorate).
  function electorate(room) {
    return room.g.order.map(id => room.players.get(id)).filter(p => p && p.connected);
  }

  // ---- message dispatch ----------------------------------------------------
  function onMessage(ws, msg, room) {
    switch (msg.type) {
      case "settings":       return onSettings(ws, msg, room);
      case "start":          return onStart(ws, room);
      case "avBegin":        return onBegin(ws, room);
      case "avPropose":      return onPropose(ws, msg, room);
      case "avVote":         return onVote(ws, msg, room);
      case "avCard":         return onCard(ws, msg, room);
      case "avAssassinate":  return onAssassinate(ws, msg, room);
      case "avForce":        return onForce(ws, room);
      case "avPause":        return onPause(ws, room);
      case "avChip":         return onChip(ws, room);
      case "lobby":          return onLobby(ws, room);
    }
  }

  function onSettings(ws, msg, room) {
    if (!isHost(ws, room)) return;
    const s = room.g.settings;
    const ps = parseInt(msg.proposeSeconds, 10);
    if (ps >= 15 && ps <= 600) s.proposeSeconds = ps;
    const vs = parseInt(msg.voteSeconds, 10);
    if (vs >= 15 && vs <= 600) s.voteSeconds = vs;
    if (Array.isArray(msg.composition)) {
      // Keep only known role keys; empty means "reset to default" (null).
      const comp = msg.composition.filter(r => ALL_ROLE_KEYS.includes(r));
      s.composition = comp.length ? comp : null;
    }
    if ("chipCount" in msg) { const c = parseInt(msg.chipCount, 10); if (c >= 0 && c <= 5) s.chipCount = c; }
    if ("chipSeconds" in msg) { const c = parseInt(msg.chipSeconds, 10); if (c >= 30 && c <= 600) s.chipSeconds = c; }
    broadcastState(room);
  }

  function onStart(ws, room) {
    if (!isHost(ws, room)) return;
    const c = connectedPlayers(room).length;
    if (c < MIN_PLAYERS || c > MAX_PLAYERS) {
      return send(ws, { type: "error", code: "bad_count",
        message: `Avalon needs ${MIN_PLAYERS}–${MAX_PLAYERS} players (you have ${c}).` });
    }
    const v = validateComposition(getComposition(room));
    if (!v.valid) return send(ws, { type: "error", code: "bad_roles", message: v.reason });
    clearTimers(room);
    const g = room.g;
    g.quest = 0;
    g.questResults = [];
    g.rejectCount = 0;
    g.team = [];
    g.votes = {};
    g.cards = {};
    g.lastVote = null;
    g.lastQuest = null;
    g.voteHistory = [];
    g.missionHistory = [];
    g.paused = false;
    g.pauseRemaining = 0;
    g.timeout = null;
    for (const p of room.players.values()) p.chips = g.settings.chipCount;   // fresh time chips
    g.assassinId = null;
    g.result = null;
    deal(room);
    room.phase = "roleReveal";
    for (const p of connectedPlayers(room)) send(p.ws, roleMessage(room, p));
    broadcastState(room);
  }

  function onBegin(ws, room) {
    if (!isHost(ws, room) || room.phase !== "roleReveal") return;
    startProposal(room);
  }

  function leaderId(room) { return room.g.order[room.g.leaderIndex]; }
  function teamSize(room) { return QUEST_TEAMS[room.g.order.length][room.g.quest]; }

  function startProposal(room) {
    const g = room.g;
    room.phase = "proposal";
    g.team = [];
    g.votes = {};
    g.cards = {};
    g.paused = false; g.pauseRemaining = 0;
    g.timeout = null; clearTimer(room, "timeout");
    setTimer(room, "phase", g.settings.proposeSeconds * 1000, () => autoPropose(room));
    broadcastState(room);
  }

  // Timer fired without a nomination: fill the leader's team at random.
  function autoPropose(room) {
    if (room.phase !== "proposal") return;
    const g = room.g;
    const need = teamSize(room);
    const lead = leaderId(room);
    const pool = shuffle(g.order.filter(id => id !== lead));
    const team = [lead, ...pool].slice(0, need);
    g.team = team;
    startVote(room);
  }

  function onPropose(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "proposal" || ws.playerId !== leaderId(room)) return;
    const members = Array.isArray(msg.members) ? [...new Set(msg.members)] : [];
    const need = teamSize(room);
    if (members.length !== need) return;
    if (!members.every(id => g.order.includes(id) && room.players.get(id)?.connected)) return;
    g.team = members;
    startVote(room);
  }

  function startVote(room) {
    const g = room.g;
    clearTimer(room, "phase");
    room.phase = "teamVote";
    g.votes = {};
    g.paused = false; g.pauseRemaining = 0;
    g.timeout = null; clearTimer(room, "timeout");
    setTimer(room, "phase", g.settings.voteSeconds * 1000, () => resolveVotes(room, true));
    broadcastState(room);
  }

  // A player spends a "time chip": freeze the current nomination/voting clock
  // for a 3-minute break, then auto-resume with the time that was left.
  function onChip(ws, room) {
    const g = room.g;
    const player = room.players.get(ws.playerId);
    if (!player) return;
    if (room.phase !== "proposal" && room.phase !== "teamVote") return;
    if (g.paused || g.timeout) return;              // one break at a time
    if (!(player.chips > 0)) return;
    const at = timerDeadline(room, "phase");
    const remaining = at ? Math.max(0, at - api.now())
      : (room.phase === "proposal" ? g.settings.proposeSeconds * 1000 : g.settings.voteSeconds * 1000);
    const breakMs = g.settings.chipSeconds * 1000;
    clearTimer(room, "phase");
    player.chips--;
    g.timeout = { by: player.name, remaining, until: api.now() + breakMs };
    setTimer(room, "timeout", breakMs, () => resumeFromTimeout(room));
    broadcastState(room);
  }

  function resumeFromTimeout(room) {
    const g = room.g;
    if (!g.timeout) return;
    const ms = g.timeout.remaining || 1000;
    g.timeout = null;
    if (room.phase === "proposal") setTimer(room, "phase", ms, () => autoPropose(room));
    else if (room.phase === "teamVote") setTimer(room, "phase", ms, () => resolveVotes(room, true));
    broadcastState(room);
  }

  // Host pauses/resumes the current nomination or voting timer.
  function onPause(ws, room) {
    if (!isHost(ws, room)) return;
    const g = room.g;
    if (room.phase !== "proposal" && room.phase !== "teamVote") return;
    if (g.timeout) return;   // a time-chip break is running
    if (!g.paused) {
      const at = timerDeadline(room, "phase");
      g.pauseRemaining = at ? Math.max(0, at - api.now()) : 0;
      clearTimer(room, "phase");
      g.paused = true;
    } else {
      g.paused = false;
      const ms = g.pauseRemaining || 1000;
      if (room.phase === "proposal") setTimer(room, "phase", ms, () => autoPropose(room));
      else setTimer(room, "phase", ms, () => resolveVotes(room, true));
    }
    broadcastState(room);
  }

  function onVote(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "teamVote") return;
    if (!g.order.includes(ws.playerId)) return;
    g.votes[ws.playerId] = !!msg.approve;
    if (electorate(room).every(p => p.id in g.votes)) resolveVotes(room, false);
    else broadcastState(room);
  }

  function resolveVotes(room, byTimer) {
    const g = room.g;
    clearTimer(room, "phase");
    clearTimer(room, "timeout"); g.timeout = null;
    const voters = electorate(room);
    // On a timeout, anyone who didn't vote counts as a reject.
    const tally = voters.map(p => ({ id: p.id, name: p.name, approve: g.votes[p.id] === true }));
    const approves = tally.filter(t => t.approve).length;
    const approved = approves * 2 > voters.length && voters.length > 0;
    g.lastVote = {
      tally, approved,
      leaderName: nameOf(room, leaderId(room)),
      team: g.team.map(id => ({ id, name: nameOf(room, id) })),
      timedOut: !!byTimer,
    };
    // Keep a running record of every nomination for the history panel.
    g.voteHistory.push(Object.assign({ quest: g.quest, attempt: g.rejectCount + 1 }, g.lastVote));
    room.phase = "voteReveal";
    broadcastState(room);
    setTimer(room, "phase", VOTE_REVEAL_MS, () => afterVoteReveal(room, approved));
  }

  function afterVoteReveal(room, approved) {
    const g = room.g;
    if (approved) {
      g.rejectCount = 0;
      startQuest(room);
    } else {
      g.rejectCount++;
      if (g.rejectCount >= 5) {
        return endGame(room, "evil", "Five nominations were rejected in a row — the realm descends into chaos. Evil wins!");
      }
      g.leaderIndex = (g.leaderIndex + 1) % g.order.length;
      startProposal(room);
    }
  }

  function startQuest(room) {
    room.phase = "quest";
    room.g.cards = {};
    broadcastState(room);
  }

  function onCard(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "quest") return;
    if (!g.team.includes(ws.playerId)) return;      // only team members
    const player = room.players.get(ws.playerId);
    // Good players cannot sabotage — their card is always a success.
    let success = player.team === "good" ? true : !!msg.success;
    // The Unreliable Loyal Servant: on the first two quests a success has a
    // hidden 1-in-3 chance of coming out as a fail. They aren't told.
    if (player.role === "unreliableservant" && g.quest < 2 && success && Math.random() < 1 / 3) {
      success = false;
    }
    g.cards[ws.playerId] = success;
    const pending = g.team.filter(id => room.players.get(id)?.connected && !(id in g.cards));
    if (pending.length === 0) resolveQuest(room);
    else broadcastState(room);
  }

  function resolveQuest(room) {
    const g = room.g, n = g.order.length;
    const fails = g.team.filter(id => g.cards[id] === false).length;
    // Quest 4 needs two fails with 7+ players; otherwise a single fail sinks it.
    const required = (g.quest === 3 && n >= 7) ? 2 : 1;
    const success = fails < required;
    g.questResults[g.quest] = { success, fails };
    g.lastQuest = { quest: g.quest, fails, success, required };
    g.missionHistory.push({ quest: g.quest, fails, success, required, team: g.team.map(id => nameOf(room, id)) });
    room.phase = "questReveal";
    broadcastState(room);
    setTimer(room, "phase", QUEST_REVEAL_MS, () => afterQuestReveal(room));
  }

  function afterQuestReveal(room) {
    const g = room.g;
    const good = g.questResults.filter(q => q && q.success).length;
    const evil = g.questResults.filter(q => q && !q.success).length;
    if (evil >= 3) return endGame(room, "evil", "Evil sabotaged three quests. The Minions of Mordred win!");
    if (good >= 3) return startAssassinate(room);
    g.leaderIndex = (g.leaderIndex + 1) % g.order.length;
    g.quest++;
    startProposal(room);
  }

  function startAssassinate(room) {
    const g = room.g;
    const assassin = g.order.find(id => room.players.get(id)?.role === "assassin");
    if (!assassin) {
      // No assassin in play (shouldn't happen) — good simply wins.
      return endGame(room, "good", "Three quests succeeded and there is no Assassin. Good wins!");
    }
    g.assassinId = assassin;
    room.phase = "assassinate";
    broadcastState(room);
  }

  function onAssassinate(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "assassinate" || ws.playerId !== g.assassinId) return;
    const target = msg.target;
    if (!g.order.includes(target)) return;
    const targetName = nameOf(room, target);
    const hitMerlin = room.players.get(target)?.role === "merlin";
    if (hitMerlin) {
      endGame(room, "evil", `The Assassin struck down ${targetName} — who was Merlin! Evil wins.`, target);
    } else {
      endGame(room, "good", `The Assassin named ${targetName}, but Merlin lived. Good wins!`, target);
    }
  }

  // Host escape hatch to unstick any phase (dropped leader, AFK team, etc.).
  function onForce(ws, room) {
    if (!isHost(ws, room)) return;
    switch (room.phase) {
      case "roleReveal": return startProposal(room);
      case "proposal":   return autoPropose(room);
      case "teamVote":   return resolveVotes(room, true);
      case "voteReveal": clearTimer(room, "phase");
        return afterVoteReveal(room, room.g.lastVote?.approved);
      case "quest":      return resolveQuest(room);
      case "questReveal": clearTimer(room, "phase"); return afterQuestReveal(room);
    }
  }

  function endGame(room, winner, reason, assassinatedId) {
    const g = room.g;
    clearTimers(room);
    // Roles are NOT revealed at the end — only the outcome. The one exception is
    // the assassination: revealing who was shot and who Merlin actually was is
    // the whole payoff of that ending.
    const result = { winner, reason, questResults: g.questResults };
    if (assassinatedId) {
      const merlin = g.order.find(id => room.players.get(id)?.role === "merlin");
      result.assassin = { name: nameOf(room, g.assassinId), target: nameOf(room, assassinatedId), merlin: merlin ? nameOf(room, merlin) : null };
    }
    g.result = result;
    room.phase = "result";
    broadcastState(room);
  }

  function onLobby(ws, room) {
    if (!isHost(ws, room)) return;
    clearTimers(room);
    room.g.timeout = null;
    room.phase = "lobby";
    broadcastState(room);
  }

  // A disconnect/leave may complete the current vote or quest early.
  function onPlayerGone(room) {
    const g = room.g;
    if (room.phase === "teamVote") {
      const elec = electorate(room);
      if (elec.length && elec.every(p => p.id in g.votes)) resolveVotes(room, false);
    } else if (room.phase === "quest") {
      const pending = g.team.filter(id => room.players.get(id)?.connected && !(id in g.cards));
      if (pending.length === 0 && g.team.length) resolveQuest(room);
    }
  }

  return {
    id: "avalon",
    init,
    initPlayer,
    publicState,
    onReconnect,
    onMessage,
    onPlayerGone,
  };
};
