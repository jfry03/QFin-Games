// Build games/word-vectors.json for Imposter's "embedding" similarity mode.
//
// Reads an open-source word-vector file in GloVe/fastText plain-text format
// (each line: "word f1 f2 … fN") and writes unit vectors for exactly the words
// in the Imposter word list. Multi-word / hyphenated entries (e.g. "Great Dane",
// "Drum and bass") use the average of their token vectors. Vectors are
// L2-normalised so a dot product at runtime equals cosine similarity.
//
// Usage:
//   node scripts/build-word-vectors.js path/to/glove.6B.50d.txt
//
// Get vectors from an open-source source, e.g.:
//   GloVe (Stanford, Apache-2.0):  https://nlp.stanford.edu/data/glove.6B.zip
//   fastText (Meta, MIT):          https://fasttext.cc/docs/en/english-vectors.html

const fs = require("fs");
const path = require("path");

const vecPath = process.argv[2];
if (!vecPath) { console.error("usage: node scripts/build-word-vectors.js <vectors.txt>"); process.exit(1); }

// --- gather the game's words from games/imposter.js -------------------------
const src = fs.readFileSync(path.join(__dirname, "..", "games", "imposter.js"), "utf8");
const WORDS = new Function("return " + src.match(/const WORDS = (\{[\s\S]*?\n\});/)[1])();
const gameWords = [...new Set(Object.values(WORDS).flat().flat())];

// Which raw tokens do we need to look up? (lowercased words + phrase tokens)
const need = new Set();
const tokensFor = w => w.toLowerCase().split(/[\s\-'/]+/).filter(Boolean);
for (const w of gameWords) for (const t of tokensFor(w)) need.add(t);

// --- stream the vector file, keeping only tokens we need --------------------
console.error("reading vectors from", vecPath, "…");
const raw = {};
let dim = 0;
for (const line of fs.readFileSync(vecPath, "utf8").split("\n")) {
  const sp = line.indexOf(" ");
  if (sp < 0) continue;
  const tok = line.slice(0, sp);
  if (!need.has(tok)) continue;
  const nums = line.slice(sp + 1).trim().split(/\s+/).map(Number);
  if (nums.length < 2) continue;
  dim = nums.length;
  raw[tok] = nums;
}
console.error("matched", Object.keys(raw).length, "of", need.size, "tokens (dim " + dim + ")");

// --- build a unit vector per game word (averaging phrase tokens) ------------
function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); }
const out = {};
let missing = [];
for (const w of gameWords) {
  const toks = tokensFor(w).filter(t => raw[t]);
  if (!toks.length) { missing.push(w); continue; }
  const acc = new Array(dim).fill(0);
  for (const t of toks) for (let i = 0; i < dim; i++) acc[i] += raw[t][i];
  out[w] = unit(acc).map(x => Math.round(x * 1e4) / 1e4);   // trim precision to shrink the file
}

const outPath = path.join(__dirname, "..", "games", "word-vectors.json");
fs.writeFileSync(outPath, JSON.stringify(out));
console.error("wrote", Object.keys(out).length, "word vectors ->", outPath,
  "(" + (fs.statSync(outPath).size / 1024 | 0) + " KB)");
if (missing.length) console.error("no vector for", missing.length, "words:", missing.slice(0, 30).join(", ") + (missing.length > 30 ? " …" : ""));
