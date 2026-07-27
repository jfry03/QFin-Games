// Account system for QFin Games — username + password.
//
// Security basics:
//  - Passwords are never stored in plaintext. Each is hashed with scrypt
//    (memory-hard KDF, built into Node's crypto) using a unique random salt.
//  - Verification uses a constant-time comparison to avoid timing leaks.
//  - Session tokens are stateless and HMAC-signed with a server secret, so a
//    tampered or forged token is rejected. The secret is generated once and
//    persisted (never shipped in the repo).
//  - Accounts live in a JSON file outside version control (DATA_DIR, default
//    ./data), so a redeploy — which hard-resets tracked files — keeps them.
//
// This is deliberately dependency-free (crypto + fs only).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "accounts.json");
const SECRET_FILE = path.join(DATA_DIR, "auth-secret");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };   // ~solid defaults for a small app
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;          // 30 days

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ---- persistence -----------------------------------------------------------
let users = {};   // usernameLower -> { username, hash, created }
function load() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || {}; }
  catch { users = {}; }
}
function save() {
  ensureDir();
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users));
  fs.renameSync(tmp, USERS_FILE);   // atomic replace
}

// Server secret for signing tokens: env override, else a persisted random one.
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try { return fs.readFileSync(SECRET_FILE, "utf8").trim(); }
  catch {
    ensureDir();
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}
let SECRET = "";

// ---- password hashing ------------------------------------------------------
// Stored format: "scrypt$<saltHex>$<hashHex>"
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}
function verifyPassword(password, stored) {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  let actual;
  try { actual = crypto.scryptSync(password, salt, expected.length, SCRYPT); }
  catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---- stateless session tokens ---------------------------------------------
// token = base64url(payload) + "." + base64url(hmac(payload))
function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + mac;
}
function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(mac || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
  if (!data || !data.u || !data.exp || data.exp < Date.now()) return null;
  const acct = users[data.u.toLowerCase()];
  if (!acct) return null;
  return { username: acct.username };
}

// ---- validation ------------------------------------------------------------
function cleanUsername(name) {
  const u = (name || "").toString().trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return null;   // letters/digits/underscore, 3–20
  return u;
}

// ---- public API ------------------------------------------------------------
function register(username, password) {
  const u = cleanUsername(username);
  if (!u) return { error: "Username must be 3–20 letters, numbers, or underscores." };
  if (typeof password !== "string" || password.length < 8)
    return { error: "Password must be at least 8 characters." };
  if (password.length > 200) return { error: "Password is too long." };
  if (users[u.toLowerCase()]) return { error: "That username is taken." };
  users[u.toLowerCase()] = { username: u, hash: hashPassword(password), created: new Date().toISOString() };
  save();
  return { token: sign({ u, exp: Date.now() + TOKEN_TTL_MS }), username: u };
}

function login(username, password) {
  const u = cleanUsername(username);
  const acct = u && users[u.toLowerCase()];
  // Verify even when the account is missing, against a dummy hash, so response
  // time doesn't reveal whether the username exists.
  const ok = verifyPassword(password, acct ? acct.hash : "scrypt$00$00");
  if (!acct || !ok) return { error: "Wrong username or password." };
  return { token: sign({ u: acct.username, exp: Date.now() + TOKEN_TTL_MS }), username: acct.username };
}

function init() { SECRET = loadSecret(); load(); }

module.exports = { init, register, login, verifyToken, cleanUsername };
