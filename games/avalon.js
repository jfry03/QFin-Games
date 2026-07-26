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

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Every named role the host can toggle in or out, in priority order per team.
// (Loyal Servant and Minion are automatic fillers — never toggled.)
const GOOD_TOGGLES = ["merlin", "percival"];
const EVIL_TOGGLES = ["assassin", "morgana", "mordred", "oberon"];

// The exact list of roles that will be dealt for `n` players under `settings`.
// Enabled special roles beyond a team's count are dropped in priority order
// (higher priority kept); each team fills the rest with Loyal Servants / Minions.
function buildRoleList(n, settings) {
  const evilCount = EVIL_COUNT[n];
  const goodCount = n - evilCount;

  const good = GOOD_TOGGLES.filter(r => settings.roles[r]);
  good.length = Math.min(good.length, goodCount);
  while (good.length < goodCount) good.push("servant");

  const evil = EVIL_TOGGLES.filter(r => settings.roles[r]);
  evil.length = Math.min(evil.length, evilCount);
  while (evil.length < evilCount) evil.push("minion");

  return { roles: [...good, ...evil], evilCount, goodCount };
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
  }

  function init(room) {
    room.g = {
      settings: {
        proposeSeconds: 90,   // nomination time limit
        voteSeconds: 60,      // voting window once a team is nominated
        // Which named roles are dealt. Merlin + Assassin are on by default (they
        // are the heart of the game) but the host may toggle any of them.
        roles: { merlin: true, percival: true, assassin: true, morgana: true, mordred: false, oberon: false },
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
      assassinId: null,
      result: null,
    };
  }

  // ---- role dealing + night knowledge -------------------------------------
  function deal(room) {
    const g = room.g;
    const players = connectedPlayers(room);
    const n = players.length;
    const order = shuffle(players.map(p => p.id));
    const { roles } = buildRoleList(n, g.settings);
    const dealt = shuffle(roles);

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
    return {
      type: "role",
      role: player.role,
      roleLabel: meta.label,
      team: meta.team,
      blurb: ROLE_BLURB[player.role],
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
        roles: Object.assign({}, g.settings.roles),
      },
      order: g.order,
      quest: g.quest,
      questResults: g.questResults,
      rejectCount: g.rejectCount,
      score: { good, evil },
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
    if (room.phase === "lobby") {
      const c = connectedPlayers(room).length;
      const ok = c >= MIN_PLAYERS && c <= MAX_PLAYERS;
      st.playerCount = c;
      st.canStart = ok;
      st.teamSizes = ok ? QUEST_TEAMS[c] : null;
      st.rolePreview = ok ? buildRoleList(c, g.settings).roles.map(r => ROLE_META[r].label) : null;
    }
    if (room.phase === "proposal" || room.phase === "teamVote" || room.phase === "voteReveal") {
      st.leaderId = g.order[g.leaderIndex];
      st.teamSize = QUEST_TEAMS[n] ? QUEST_TEAMS[n][g.quest] : 0;
      st.team = g.team;
    }
    if (room.phase === "proposal") st.deadline = timerDeadline(room, "phase");
    if (room.phase === "teamVote") {
      st.deadline = timerDeadline(room, "phase");
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
    if (msg.roles && typeof msg.roles === "object") {
      for (const r of [...GOOD_TOGGLES, ...EVIL_TOGGLES])
        if (typeof msg.roles[r] === "boolean") s.roles[r] = msg.roles[r];
    }
    broadcastState(room);
  }

  function onStart(ws, room) {
    if (!isHost(ws, room)) return;
    const c = connectedPlayers(room).length;
    if (c < MIN_PLAYERS || c > MAX_PLAYERS) {
      return send(ws, { type: "error", code: "bad_count",
        message: `Avalon needs ${MIN_PLAYERS}–${MAX_PLAYERS} players (you have ${c}).` });
    }
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
    setTimer(room, "phase", g.settings.voteSeconds * 1000, () => resolveVotes(room, true));
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
    room.phase = "voteReveal";
    broadcastState(room);
    setTimer(room, "phase", 6000, () => afterVoteReveal(room, approved));
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
    const success = player.team === "good" ? true : !!msg.success;
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
    room.phase = "questReveal";
    broadcastState(room);
    setTimer(room, "phase", 7000, () => afterQuestReveal(room));
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
    const players = g.order.map(id => {
      const p = room.players.get(id);
      const role = p?.role || "servant";
      return { id, name: nameOf(room, id), role, roleLabel: ROLE_META[role].label, team: ROLE_META[role].team };
    });
    const merlin = g.order.find(id => room.players.get(id)?.role === "merlin");
    g.result = {
      winner, reason,
      players,
      questResults: g.questResults,
      merlinName: merlin ? nameOf(room, merlin) : null,
      assassinName: g.assassinId ? nameOf(room, g.assassinId) : null,
      assassinatedName: assassinatedId ? nameOf(room, assassinatedId) : null,
    };
    room.phase = "result";
    broadcastState(room);
  }

  function onLobby(ws, room) {
    if (!isHost(ws, room)) return;
    clearTimers(room);
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
