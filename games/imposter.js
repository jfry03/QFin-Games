// Imposter — the word game, as a QFin Games module.
//
// The crew all receive the same secret word; one (or more, in "just assign
// words" mode) imposters get a similar-but-different word. Players give
// one-word clues, then vote on who the imposter is. A caught imposter can
// steal the win by guessing the crew's word.
//
// This module owns only Imposter's rules. Rooms, players, chat, host handoff
// and connection lifecycle live in ../server.js and reach us through `api`.

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
    ["Kettle","Toaster","Microwave","Oven","Stove"],
    ["Pen","Pencil","Marker","Crayon","Chalk"],
    ["Cup","Mug","Glass","Bottle","Flask"],
    ["Fork","Spoon","Ladle","Chopsticks","Knife"],
    ["Watch","Bracelet","Ring","Necklace","Earring"],
    ["Towel","Flannel","Washcloth","Bathrobe","Loofah"],
    ["Key","Latch","Bolt","Padlock","Deadbolt"],
    ["Notebook","Diary","Journal","Ledger","Binder"],
    ["Plate","Bowl","Saucer","Platter","Tray"],
    ["Clock","Alarm clock","Stopwatch","Timer","Hourglass"],
    ["Envelope","Letter","Postcard","Parcel","Stamp"],
    ["Sofa","Armchair","Stool","Bench","Beanbag"],
    ["Blender","Whisk","Grater","Peeler","Rolling pin"],
    ["Coaster","Placemat","Napkin","Tablecloth","Table runner"],
    ["Battery","Charger","Power bank","Extension lead","Plug socket"],
    ["Coat hanger","Clothes peg","Hook","Shelf bracket","Curtain rail"],
    ["Doormat","Rug","Carpet","Curtain","Blind"],
    ["Sieve","Colander","Strainer","Funnel","Measuring jug"],
    ["Ruler","Protractor","Set square","Compass","Calculator"],
    ["Doorknob","Handle","Hinge","Doorbell","Knocker"],
    ["Basket","Crate","Box","Chest","Trunk"]
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
    ["Tea","Espresso","Latte","Cappuccino","Coffee"],
    ["Apple","Pear","Peach","Plum","Apricot"],
    ["Carrot","Parsnip","Turnip","Beetroot","Radish"],
    ["Cheddar","Gouda","Mozzarella","Feta","Parmesan"],
    ["Ketchup","Mustard","Mayonnaise","Relish","Barbecue sauce"],
    ["Rice","Quinoa","Couscous","Barley","Oats"],
    ["Fudge","Toffee","Caramel","Nougat","Marshmallow"],
    ["Lemon","Lime","Orange","Grapefruit","Tangerine"],
    ["Broccoli","Cauliflower","Cabbage","Kale","Spinach"],
    ["Bacon","Ham","Sausage","Salami","Pepperoni"],
    ["Almond","Walnut","Cashew","Pistachio","Hazelnut"],
    ["Yogurt","Custard","Pudding","Mousse","Jelly"],
    ["Chickpea","Lentil","Kidney bean","Black bean","Butter bean"],
    ["Cracker","Rice cake","Breadstick","Wafer","Rusk"],
    ["Jam","Marmalade","Honey","Syrup","Chocolate spread"],
    ["Cereal","Granola","Muesli","Porridge","Oatmeal"],
    ["Soup","Broth","Stew","Curry","Chilli"],
    ["Milkshake","Smoothie","Juice","Lemonade","Soda"],
    ["Tofu","Tempeh","Seitan","Halloumi","Paneer"],
    ["Sausage roll","Pasty","Pie","Quiche","Tart"],
    ["Fries","Wedges","Hash brown","Tater tot","Mash"]
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
    ["Horse","Deer","Antelope","Zebra","Giraffe"],
    ["Ant","Beetle","Ladybug","Grasshopper","Cricket"],
    ["Bee","Wasp","Hornet","Fly","Mosquito"],
    ["Cow","Goat","Sheep","Pig","Donkey"],
    ["Duck","Goose","Swan","Chicken","Turkey"],
    ["Mouse","Rat","Hamster","Gerbil","Guinea pig"],
    ["Trout","Salmon","Cod","Tuna","Mackerel"],
    ["Spider","Scorpion","Tick","Mite","Centipede"],
    ["Wolf","Fox","Coyote","Jackal","Dingo"],
    ["Bear","Panda","Sloth","Badger","Wolverine"],
    ["Parrot","Cockatoo","Budgie","Canary","Finch"],
    ["Snail","Slug","Worm","Leech","Caterpillar"],
    ["Bat","Mole","Hedgehog","Shrew","Vole"],
    ["Chihuahua","Beagle","Bulldog","Labrador","Great Dane"],
    ["Housecat","Bobcat","Lynx","Cougar","Panther"],
    ["Clownfish","Guppy","Goldfish","Angelfish","Betta"],
    ["Otter","Beaver","Platypus","Muskrat","Capybara"],
    ["Camel","Llama","Alpaca","Vicuna","Guanaco"],
    ["Moth","Butterfly","Dragonfly","Damselfly","Mayfly"],
    ["Ferret","Weasel","Stoat","Mink","Marten"],
    ["Chick","Hen","Rooster","Peacock","Ostrich"]
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
    ["Food truck","Diner","Restaurant","Cafe","Bakery"],
    ["Kitchen","Pantry","Dining room","Living room","Bedroom"],
    ["Attic","Loft","Basement","Cellar","Garage"],
    ["Meadow","Field","Prairie","Savanna","Desert"],
    ["Island","Peninsula","Cape","Reef","Atoll"],
    ["Hamlet","Village","Town","City","Metropolis"],
    ["Bridge","Overpass","Underpass","Tunnel","Viaduct"],
    ["Farm","Ranch","Orchard","Vineyard","Plantation"],
    ["Harbor","Dock","Pier","Marina","Wharf"],
    ["Chapel","Church","Cathedral","Temple","Mosque"],
    ["Gym","Spa","Sauna","Steam room","Pool"],
    ["Bank","Post office","Town hall","Courthouse","Embassy"],
    ["Alley","Lane","Street","Avenue","Boulevard"],
    ["Hut","Cabin","Bungalow","Townhouse","Skyscraper"],
    ["Pond","Fountain","Well","Reservoir","Dam"],
    ["Bus stop","Layby","Car park","Roundabout","Motorway"],
    ["Stall","Kiosk","Shop","Supermarket","Mall"],
    ["Playground","Park","Common","Reserve","National park"],
    ["Runway","Hangar","Terminal","Control tower","Departure lounge"],
    ["Crypt","Tomb","Mausoleum","Cemetery","Catacomb"]
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
    ["Trampolining","Diving","Gymnastics","Bouldering","Climbing"],
    ["Marathon","Triathlon","Decathlon","Pentathlon","Heptathlon"],
    ["Sailing","Kayaking","Canoeing","Rafting","Paddleboarding"],
    ["Curling","Ice hockey","Figure skating","Speed skating","Bobsled"],
    ["Long jump","Triple jump","High jump","Pole vault","Shot put"],
    ["Weightlifting","Powerlifting","Bodybuilding","CrossFit","Strongman"],
    ["Motocross","Rally","Formula 1","Karting","Drag racing"],
    ["Horse racing","Show jumping","Dressage","Polo","Rodeo"],
    ["Water polo","Synchronised swimming","Freediving","Snorkelling","Surfing"],
    ["Abseiling","Mountaineering","Caving","Hiking","Orienteering"],
    ["Cheerleading","Acrobatics","Parkour","Breakdancing","Tumbling"],
    ["Yoga","Pilates","Aerobics","Zumba","Spin class"],
    ["Frisbee","Ultimate","Disc golf","Cornhole","Horseshoes"],
    ["Freestyle","Backstroke","Breaststroke","Butterfly","Medley"],
    ["Slalom","Downhill","Cross-country","Ski jump","Biathlon"],
    ["Sabre","Épée","Foil","Rapier","Kendo"],
    ["Skipping","Hula hoop","Pogo stick","Jump rope","Hopscotch"]
  ],
  "Clothing": [
    ["Vest","T-shirt","Shirt","Jumper","Coat"],
    ["Socks","Tights","Leggings","Trousers","Jeans"],
    ["Sandals","Flip-flops","Trainers","Boots","Heels"],
    ["Cap","Beanie","Beret","Fedora","Top hat"],
    ["Scarf","Shawl","Poncho","Cardigan","Cloak"],
    ["Bikini","Swimsuit","Wetsuit","Leotard","Onesie"],
    ["Gloves","Mittens","Wristband","Bracelet","Watch"],
    ["Belt","Braces","Sash","Tie","Bow tie"],
    ["Apron","Overalls","Dungarees","Boiler suit","Uniform"],
    ["Slippers","Loafers","Brogues","Oxfords","Clogs"],
    ["Shorts","Skort","Skirt","Dress","Gown"],
    ["Hoodie","Sweatshirt","Blazer","Suit jacket","Tuxedo"]
  ],
  "Music": [
    ["Whistle","Recorder","Flute","Clarinet","Oboe"],
    ["Ukulele","Guitar","Banjo","Mandolin","Sitar"],
    ["Violin","Viola","Cello","Double bass","Harp"],
    ["Bongos","Drum","Timpani","Xylophone","Gong"],
    ["Harmonica","Accordion","Bagpipes","Organ","Piano"],
    ["Trumpet","Cornet","Trombone","Tuba","French horn"],
    ["Pop","Rock","Metal","Punk","Grunge"],
    ["Jazz","Blues","Soul","Funk","Reggae"],
    ["Techno","House","Trance","Dubstep","Drum and bass"],
    ["Hymn","Carol","Anthem","Ballad","Opera"],
    ["Choir","Duet","Solo","Orchestra","Band"],
    ["Microphone","Amplifier","Speaker","Headphones","Earbuds"]
  ],
  "Jobs": [
    ["Nurse","Paramedic","Doctor","Surgeon","Pharmacist"],
    ["Waiter","Barista","Chef","Baker","Butcher"],
    ["Teacher","Tutor","Lecturer","Professor","Principal"],
    ["Cleaner","Janitor","Caretaker","Plumber","Electrician"],
    ["Cashier","Salesperson","Manager","Accountant","Banker"],
    ["Actor","Singer","Dancer","Comedian","Magician"],
    ["Farmer","Gardener","Vet","Zookeeper","Ranger"],
    ["Pilot","Cabin crew","Sailor","Captain","Astronaut"],
    ["Journalist","Author","Editor","Translator","Librarian"],
    ["Painter","Sculptor","Architect","Designer","Photographer"],
    ["Police officer","Detective","Firefighter","Soldier","Bodyguard"],
    ["Carpenter","Bricklayer","Welder","Mechanic","Blacksmith"]
  ],
  "Weather & Nature": [
    ["Breeze","Wind","Gust","Gale","Hurricane"],
    ["Drizzle","Shower","Rain","Downpour","Thunderstorm"],
    ["Mist","Fog","Cloud","Overcast","Smog"],
    ["Frost","Sleet","Snow","Blizzard","Hail"],
    ["Puddle","Pond","Lake","Sea","Ocean"],
    ["Hill","Ridge","Mountain","Peak","Summit"],
    ["Spark","Flame","Fire","Blaze","Inferno"],
    ["Pebble","Stone","Rock","Boulder","Cliff"],
    ["Seed","Sprout","Bush","Shrub","Tree"],
    ["Sunrise","Dawn","Noon","Dusk","Midnight"],
    ["Stream","Brook","Creek","River","Rapids"],
    ["Tremor","Earthquake","Landslide","Avalanche","Eruption"]
  ]
};

const ALL_CLUSTERS = Object.values(WORDS).flat();

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// How many players get an "off" (adjacent) word instead of the main crew word.
// Drawn from a zero-modified Poisson: with probability `pNone` nobody is off;
// otherwise the count follows a Poisson(lambda) truncated to >= 1. Result is
// clamped to [0, maxOff] so at least one player always holds the main word.
function samplePoisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
function sampleOffCount(pNone, lambda, maxOff) {
  if (maxOff <= 0) return 0;
  if (Math.random() < pNone) return 0;
  let k;
  do { k = samplePoisson(lambda); } while (k < 1);   // truncate to >= 1
  return Math.min(k, maxOff);
}

// Returns an array of length `playerCount`: each entry { imposter, word }.
// `wantOff` is how many players should get an adjacent word (0..playerCount-1).
function buildRound(playerCount, similarity, wantOff) {
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

  const nImposters = Math.max(0, Math.min(wantOff, playerCount - 1, imposterWords.length));

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
// Module
// ---------------------------------------------------------------------------

module.exports = (api) => {
  const { send, broadcastState, connectedPlayers, isHost } = api;

  function initPlayer(room, player) {
    player.word = null;
    player.marks = {};
  }

  function init(room) {
    room.g = {
      // dist: zero-modified Poisson for how many players get an off word
      // (pNone = chance nobody is off; lambda = shape of the >=1 tail).
      settings: { similarity: 4, laps: 2, inPerson: false, dist: { pNone: 0.07, lambda: 0.91 } },
      order: [],            // playerIds in clue-giving turn order
      turnIndex: 0,         // whose turn it is within order
      lap: 0,               // which clue lap (round) we're on, 0-based
      clues: [],            // shared history: { name, word }
      imposterId: null,     // SECRET: the single imposter (on-phone vote game)
      imposterIds: [],      // SECRET: every player who got an off word
      crewWord: null,       // SECRET: the crew's word
      votes: {},            // voterId -> targetId
      result: null,         // reveal payload, populated when the game ends
    };
  }

  // Public view — never contains the crew word or imposter identity until reveal.
  function publicState(room) {
    const g = room.g;
    const st = {
      similarity: g.settings.similarity,
      laps: g.settings.laps,
      inPerson: g.settings.inPerson,
      dist: { pNone: g.settings.dist.pNone, lambda: g.settings.dist.lambda },
      lap: g.lap,
      order: g.order,
      turnIndex: g.turnIndex,
      clues: g.clues,
      // public suspicion marks: voterId -> { targetId: 'like'|'dislike' }
      marks: Object.fromEntries(
        [...room.players.values()]
          .filter(p => p.connected && p.marks && Object.keys(p.marks).length)
          .map(p => [p.id, p.marks])),
    };
    if (room.phase === "vote") {
      st.voters = Object.keys(g.votes);           // who has voted (not their choice)
      st.needed = connectedPlayers(room).length;
    }
    if (room.phase === "guess") {
      st.caughtId = g.imposterId;
      st.caughtName = room.players.get(g.imposterId)?.name || "?";
    }
    if (room.phase === "result") st.result = g.result;
    return st;
  }

  // Resend per-player private info after a (re)connect.
  function onReconnect(room, player) {
    if ((room.phase === "round" || room.phase === "assigned") && player.word != null) {
      send(player.ws, { type: "round", word: player.word });
    }
    if (room.phase === "guess" && player.id === room.g.imposterId) {
      send(player.ws, { type: "guessPrompt" });
    }
  }

  function onMessage(ws, msg, room) {
    switch (msg.type) {
      case "settings": return onSettings(ws, msg, room);
      case "start":    return onStart(ws, room);
      case "reveal":   return onReveal(ws, room);
      case "clue":     return onClue(ws, msg, room);
      case "skip":     return onSkip(ws, room);
      case "vote":     return onVote(ws, msg, room);
      case "tally":    return onTally(ws, room);
      case "guess":    return onGuess(ws, msg, room);
      case "forfeit":  return onForfeit(ws, room);
      case "lobby":    return onLobby(ws, room);
      case "mark":     return onMark(ws, msg, room);
    }
  }

  function onSettings(ws, msg, room) {
    if (!isHost(ws, room)) return;
    const s = room.g.settings;
    const sim = parseInt(msg.similarity, 10);
    if (sim >= 1 && sim <= 5) s.similarity = sim;
    const l = parseInt(msg.laps, 10);
    if (l >= 1 && l <= 6) s.laps = l;
    if (typeof msg.inPerson === "boolean") s.inPerson = msg.inPerson;
    if (typeof msg.pNone === "number" && msg.pNone >= 0 && msg.pNone <= 0.9)
      s.dist.pNone = msg.pNone;
    if (typeof msg.lambda === "number" && msg.lambda >= 0.05 && msg.lambda <= 5)
      s.dist.lambda = msg.lambda;
    broadcastState(room);
  }

  function onStart(ws, room) {
    if (!isHost(ws, room)) return;
    const g = room.g;
    const players = connectedPlayers(room);
    if (players.length < 3) {
      return send(ws, { type: "error", code: "too_few", message: "Need at least 3 players." });
    }
    // How many players get an off word. In the on-phone vote game the
    // catch/guess flow assumes exactly one imposter, so it's always 1 there.
    // In "just assign words" mode the count is drawn from the distribution.
    const wantOff = g.settings.inPerson
      ? sampleOffCount(g.settings.dist.pNone, g.settings.dist.lambda, players.length - 1)
      : 1;
    const roles = buildRound(players.length, g.settings.similarity, wantOff);
    room.phase = g.settings.inPerson ? "assigned" : "round";
    g.clues = [];
    g.turnIndex = 0;
    g.lap = 0;
    g.votes = {};
    g.result = null;
    g.imposterIds = [];
    g.imposterId = null;
    g.crewWord = null;
    players.forEach(p => { p.marks = {}; });
    const order = players.map(p => p.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    g.order = order;
    players.forEach((p, i) => {
      p.word = roles[i].word;
      if (roles[i].imposter) g.imposterIds.push(p.id);
      else g.crewWord = roles[i].word;
      send(p.ws, { type: "round", word: p.word });
    });
    g.imposterId = g.imposterIds[0] || null;
    broadcastState(room);
  }

  // "Just assign words" mode: host ends the round and everyone sees the reveal.
  function onReveal(ws, room) {
    if (!isHost(ws, room) || room.phase !== "assigned") return;
    const g = room.g;
    const nameOf = id => room.players.get(id)?.name || "?";
    const odd = (g.imposterIds || [])
      .map(id => ({ name: nameOf(id), word: room.players.get(id)?.word || null }))
      .filter(o => o.word != null);
    g.result = { mode: "reveal", crewWord: g.crewWord, odd };
    room.phase = "result";
    broadcastState(room);
  }

  function advanceTurn(room) {
    const g = room.g;
    g.turnIndex++;
    if (g.turnIndex >= g.order.length) {
      g.lap++;
      if (g.lap >= g.settings.laps) { startVote(room); return; }
      g.turnIndex = 0;
    }
    broadcastState(room);
  }

  function startVote(room) {
    room.phase = "vote";
    room.g.votes = {};
    broadcastState(room);
  }

  function onVote(ws, msg, room) {
    if (room.phase !== "vote") return;
    const target = msg.target;
    if (!room.players.has(target) || target === ws.playerId) return;
    room.g.votes[ws.playerId] = target;
    const allVoted = connectedPlayers(room).every(p => room.g.votes[p.id]);
    if (allVoted) resolveVotes(room);
    else broadcastState(room);
  }

  function onTally(ws, room) {
    if (isHost(ws, room) && room.phase === "vote") resolveVotes(room);
  }

  // The imposter is "caught" only on a strict majority of votes cast.
  function resolveVotes(room) {
    const g = room.g;
    const cast = Object.values(g.votes);
    const total = cast.length;
    const forImposter = cast.filter(t => t === g.imposterId).length;
    const caught = total > 0 && forImposter * 2 > total;
    if (caught) {
      room.phase = "guess";
      send(room.players.get(g.imposterId)?.ws, { type: "guessPrompt" });
      broadcastState(room);
    } else {
      finalize(room, { caught: false, guess: null, winner: "imposter",
        reason: "The imposter dodged a majority vote and escaped." });
    }
  }

  // A caught imposter guesses the crew word. Exact match, or a guess inside/
  // around the real word (case-insensitive), steals the win.
  function onGuess(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "guess" || ws.playerId !== g.imposterId) return;
    const guess = (msg.word || "").toString().trim();
    const gl = guess.toLowerCase(), wl = (g.crewWord || "").toLowerCase();
    const correct = gl.length > 0 && (gl === wl || wl.includes(gl) || gl.includes(wl));
    finalize(room, {
      caught: true,
      guess,
      winner: correct ? "imposter" : "crew",
      reason: correct
        ? "Caught — but nailed the word and stole the win!"
        : "Caught, and the guess was wrong. Crew wins!",
    });
  }

  function onForfeit(ws, room) {
    if (isHost(ws, room) && room.phase === "guess") {
      finalize(room, { caught: true, guess: null, winner: "crew",
        reason: "No guess from the imposter. Crew wins!" });
    }
  }

  function finalize(room, o) {
    const g = room.g;
    const nameOf = id => room.players.get(id)?.name || "?";
    const tallyMap = {};
    for (const t of Object.values(g.votes)) tallyMap[t] = (tallyMap[t] || 0) + 1;
    const tally = Object.entries(tallyMap)
      .map(([id, count]) => ({ id, name: nameOf(id), count }))
      .sort((a, b) => b.count - a.count);
    const votes = Object.entries(g.votes)
      .map(([voter, target]) => ({ voterName: nameOf(voter), targetName: nameOf(target) }));
    g.result = {
      imposterId: g.imposterId,
      imposterName: nameOf(g.imposterId),
      crewWord: g.crewWord,
      imposterWord: room.players.get(g.imposterId)?.word || null,
      caught: o.caught,
      guess: o.guess,
      winner: o.winner,
      reason: o.reason,
      tally,
      votes,
    };
    room.phase = "result";
    broadcastState(room);
  }

  function onLobby(ws, room) {
    if (!isHost(ws, room)) return;
    room.phase = "lobby";
    broadcastState(room);
  }

  function onMark(ws, msg, room) {
    const player = room.players.get(ws.playerId);
    if (!player) return;
    const target = msg.target;
    if (!room.players.has(target) || target === ws.playerId) return;
    if (msg.value === "like" || msg.value === "dislike") player.marks[target] = msg.value;
    else delete player.marks[target];
    broadcastState(room);
  }

  function onClue(ws, msg, room) {
    const g = room.g;
    if (room.phase !== "round") return;
    if (g.order[g.turnIndex] !== ws.playerId) return;   // not your turn
    const word = (msg.word || "").toString().trim().slice(0, 40);
    if (!word) return;
    const player = room.players.get(ws.playerId);
    g.clues.push({ name: player ? player.name : "?", word });
    advanceTurn(room);
  }

  function onSkip(ws, room) {
    const g = room.g;
    if (!isHost(ws, room) || room.phase !== "round") return;
    const skippedId = g.order[g.turnIndex];
    const player = room.players.get(skippedId);
    g.clues.push({ name: player ? player.name : "?", word: "—", skipped: true });
    advanceTurn(room);
  }

  return {
    id: "imposter",
    init,
    initPlayer,
    publicState,
    onReconnect,
    onMessage,
  };
};
