import { getStore } from "@netlify/blobs";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const DEV = "weathercodevelopment";
// Site-wide stores (getStore, not getDeployStore) so data survives every redeploy.
const st = (name) => getStore({ name, consistency: "strong" });
const WINDOW = 150; // newest posts considered for feeds, tags and profiles
const ID_RE = /^\d{13}-[at]-[a-f0-9]{8}$/;
const KEY_RE = /^[a-z0-9_]{3,20}$/;
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const EARLY = Date.UTC(2026, 9, 3, 4, 0, 0); // Early Access badge: joined before Oct 3, 2026 00:00 US Eastern
const CID_RE = /^\d{13}-[a-f0-9]{8}$/;
const REASONS = ["rating", "harassment", "inappropriate", "spam", "other"];
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const tempPassword = () => Array.from(randomBytes(10), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");
const slugOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

class Fail extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const send = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const hash = async (pw) => {
  const s = randomBytes(16);
  return s.toString("hex") + ":" + (await scryptAsync(pw, s, 64)).toString("hex");
};
const verify = async (pw, stored) => {
  const [s, k] = stored.split(":");
  const d = await scryptAsync(pw, Buffer.from(s, "hex"), 64);
  const kb = Buffer.from(k, "hex");
  return kb.length === d.length && timingSafeEqual(kb, d);
};
const ageOf = (b) => {
  const [y, m, d] = b.split("-").map(Number), n = new Date();
  let a = n.getUTCFullYear() - y;
  if (n.getUTCMonth() + 1 < m || (n.getUTCMonth() + 1 === m && n.getUTCDate() < d)) a--;
  return a;
};
// "restricted" is on for everyone under 13, and on for anyone who chose it.
const view = (key, rec) => {
  const age = ageOf(rec.birthdate);
  return { key, username: rec.username, displayName: rec.displayName, age, forced: age < 13,
    restricted: age < 13 || rec.restricted === true, theme: rec.theme || null,
    bio: rec.bio || "", early: rec.createdAt < EARLY, mustChange: rec.mustChange === true,
    flair: SHOP[rec.flair]?.emoji || null, color: rec.color ? rec.color.split(":")[1] : null,
    premium: (rec.premiumUntil || 0) > Date.now(), premiumUntil: rec.premiumUntil || 0, friendRequests: rec.friendRequests !== false, halloween: (rec.halloweenClaimed || 0) > 0,
    halloweenOk: (rec.halloweenClaimed || 0) > 0 && (Date.now() < HW_END || (rec.premiumUntil || 0) > Date.now()) };
};
const pub = (u) => ({ username: u.username, displayName: u.displayName, forced: u.forced, restricted: u.restricted, theme: u.theme, bio: u.bio, early: u.early, mustChange: u.mustChange, flair: u.flair, color: u.color, premium: u.premium, premiumUntil: u.premiumUntil, friendRequests: u.friendRequests, halloween: u.halloween, halloweenOk: u.halloweenOk, isDev: u.key === DEV });

const getUser = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await st("sessions").get(token, { type: "json" });
  if (!s || Date.now() - s.t > 30 * 864e5) return null;
  const u = await st("users").get(s.u, { type: "json" });
  if (!u || u.suspended || u.deleted || (u.validAfter && s.t < u.validAfter)) return null;
  return view(s.u, u);
};
const newSession = async (key) => {
  const t = randomBytes(32).toString("hex");
  await st("sessions").set(t, JSON.stringify({ u: key, t: Date.now() }));
  return t;
};

const hits = new Map(); // best-effort, per function instance
const limit = (ip, max) => {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (a.length >= max) throw new Fail(429, "Too many attempts. Wait a minute and try again.");
  a.push(now);
  hits.set(ip, a);
};
const count = async (store, prefix) => (await st(store).list({ prefix })).blobs.length;

const cleanPost = (body) => {
  const t = String(body.title ?? "").trim(), tp = String(body.topic ?? "").trim().toLowerCase(), bo = String(body.body ?? "").trim();
  if (!t || t.length > 100) throw new Fail(400, "Title must be 1–100 characters.");
  if (!tp || tp.length > 30) throw new Fail(400, "Topic must be 1–30 characters.");
  if (!bo || bo.length > 5000) throw new Fail(400, "Post text must be 1–5000 characters.");
  if (!["all", "13+"].includes(body.rating)) throw new Fail(400, "Choose a rating.");
  return { t, tp, bo };
};
const checkImage = (img, max = 900000) => {
  if (typeof img !== "string" || img.length > max || !IMG_RE.test(img)) throw new Fail(400, "That image is invalid or too large.");
};
const postId = (ts, rating, rand) => `${ts}-${rating === "13+" ? "t" : "a"}-${rand}`;
const likeKey = (who, p, id) => `u~${who}~${slugOf(p.topic)}~${p.username.toLowerCase()}~${id}`;

// Move (or, with newPost = null, delete) every like on a post when it is re-keyed or removed.
async function moveLikes(oldPost, id, newPost, newId) {
  const likes = st("likes");
  const { blobs } = await likes.list({ prefix: `p~${id}~` });
  for (const b of blobs) {
    const who = b.key.split("~")[2];
    await likes.delete(b.key);
    await likes.delete(likeKey(who, oldPost, id));
    if (newPost) {
      await likes.set(`p~${newId}~${who}`, "1");
      await likes.set(likeKey(who, newPost, newId), "1");
    }
  }
}

// ---------- Weather Credits (play money: no cash value, can't be bought or cashed out) ----------
const dayKey = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const FEE_PCT = 10, BOOST_PRICE = 150, TIPS = [5, 10, 25];
const SHOP = {
  freeze: { name: "Streak Freeze", price: 50, kind: "freeze" },
  "color:sunset": { name: "Sunset name colour", price: 100, kind: "color" },
  "color:ocean": { name: "Ocean name colour", price: 100, kind: "color" },
  "color:aurora": { name: "Aurora name colour", price: 150, kind: "color" },
  "color:gold": { name: "Gold name colour", price: 250, kind: "color" },
  "flair:sun": { name: "Sunny badge", price: 75, kind: "flair", emoji: "☀️" },
  "flair:storm": { name: "Storm badge", price: 75, kind: "flair", emoji: "⛈️" },
  "flair:snow": { name: "Snowflake badge", price: 75, kind: "flair", emoji: "❄️" },
  "flair:rainbow": { name: "Rainbow badge", price: 75, kind: "flair", emoji: "🌈" },
  "flair:tornado": { name: "Tornado badge", price: 75, kind: "flair", emoji: "🌪️" },
  "flair:pumpkin": { name: "Pumpkin badge (Halloween exclusive)", price: 0, kind: "flair", emoji: "🎃", event: true },
  "flair:ghost": { name: "Ghost Hunter badge (find every Halloween secret)", price: 0, kind: "flair", emoji: "👻", event: true },
};
for (const [k, i] of Object.entries(SHOP)) i.section = k === "freeze" ? "wcd" : "style"; // shop sections: WCD / Style
const DAY_MS = 864e5, PREMIUM_PRICE = 200, PREMIUM_DAYS = 30, VIDEO_MAX = 3.5 * 1024 * 1024;
// Halloween: free for everyone to claim during the event; after October 31 (US Eastern) only Premium members can claim or use it.
const HW_END = Date.UTC(2026, 10, 1, 4, 0, 0);
const HW_SECRETS = ["spider", "cobweb", "moon", "brand", "konami", "boo", "treat", "trick", "witching", "haunted"];
const premiumActive = (w) => (w.premiumUntil || 0) > Date.now();
const freezeCap = (w) => (premiumActive(w) ? 5 : 3);
const newWallet = () => ({ balance: 0, streak: 0, best: 0, lastDay: null, freezes: 0, owned: [], log: [] });
const addLog = (w, type, n, note) => { w.log.unshift({ type, n, note, ts: Date.now() }); w.log = w.log.slice(0, 25); };
const earn = (w, n, type, note) => { w.balance += n; addLog(w, type, n, note); };
const spend = (w, n, note) => {
  if (w.balance < n) throw new Fail(402, "You don't have enough Weather Credits.");
  w.balance -= n; addLog(w, "spend", -n, note);
};
// Compare-and-swap on the wallet's ETag, retried, so two requests can never both spend the same credits.
async function updateWallet(key, fn) {
  const s = st("wallets");
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const w = cur ? cur.data : newWallet();
    fn(w);
    const r = cur ? await s.set(key, JSON.stringify(w), { onlyIfMatch: cur.etag }) : await s.set(key, JSON.stringify(w), { onlyIfNew: true });
    if (r?.modified === true) return w;
    await new Promise((res) => setTimeout(res, 10 + Math.random() * 40));
  }
  throw new Fail(409, "That's busy right now. Try again in a moment.");
}
const walletOf = async (key) => (await st("wallets").get(key, { type: "json" })) || newWallet();
async function mirrorPremium(key, until) { // the user record keeps a copy of the expiry so names and gates don't need the wallet
  const rec = await st("users").get(key, { type: "json" });
  if (rec) { rec.premiumUntil = until; await st("users").set(key, JSON.stringify(rec)); }
}
async function maybeRenew(key, w0) { // auto-renew an expired Premium if the member can pay; otherwise let it lapse (once)
  if (!w0.premiumUntil || w0.premiumUntil > Date.now() || !w0.autoRenew) return null;
  try {
    const w = await updateWallet(key, (w) => {
      if (!(w.premiumUntil && w.premiumUntil <= Date.now() && w.autoRenew)) return;
      spend(w, PREMIUM_PRICE, "WC Blog Premium (monthly renewal)");
      w.premiumUntil = Date.now() + PREMIUM_DAYS * DAY_MS;
      w.freezes = Math.min(freezeCap(w), w.freezes + 1);
    });
    if (w.premiumUntil > Date.now()) await mirrorPremium(key, w.premiumUntil);
    return w;
  } catch (e) {
    if (!(e instanceof Fail) || e.status !== 402) throw e;
    const w = await updateWallet(key, (w) => { w.autoRenew = false; });
    await notify(key, { type: "premium", title: "Your WC Blog Premium ended because there weren't enough credits to renew it." }, "all");
    return w;
  }
}
function parseVideo(v) {
  const m = typeof v === "string" && /^data:(video\/(?:mp4|webm|quicktime));base64,/.exec(v);
  if (!m) throw new Fail(400, "Videos must be MP4, WebM or MOV files.");
  const b64 = v.slice(m[0].length);
  if (b64.length > 4.95e6 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Fail(400, "That video file is too large or damaged.");
  const buf = Buffer.from(b64, "base64");
  if (buf.length > VIDEO_MAX) throw new Fail(400, "Videos can be up to 3.5 MB (about 10 to 20 seconds).");
  const mp4 = buf.length > 12 && buf.subarray(4, 8).toString("latin1") === "ftyp";
  const webm = buf.length > 12 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (m[1] === "video/webm" ? !webm : !mp4) throw new Fail(400, "That doesn't look like a real video file.");
  return { type: m[1], data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}
const streakInfo = (w) => {
  if (!w.lastDay) return { alive: false, canCheckIn: true, effective: 0, gap: null };
  const gap = dayDiff(w.lastDay, dayKey()), alive = gap <= 1 || (gap === 2 && w.freezes > 0);
  return { alive, canCheckIn: gap !== 0, effective: alive ? w.streak : 0, gap };
};
const rewardFor = (n) => 10 + Math.min(n - 1, 9) * 2 + (n % 7 === 0 ? 25 : 0) + (n % 30 === 0 ? 100 : 0);
const walletView = (w) => {
  const i = streakInfo(w), next = i.canCheckIn ? (i.alive ? w.streak + 1 : 1) : w.streak + 1;
  return { balance: w.balance, streak: i.effective, best: w.best, freezes: w.freezes, canCheckIn: i.canCheckIn, nextReward: rewardFor(next) + (premiumActive(w) ? 5 : 0), owned: w.owned,
    premium: { active: premiumActive(w), until: w.premiumUntil || 0, auto: w.autoRenew === true, price: PREMIUM_PRICE } };
};

// ---------- friends + private messages ----------
// Safety rules: friends only (both must agree), minors only friend minors within 4 years of their age and adults only adults,
// blocks work both ways, and every message can be reported (the report keeps the last few messages as context).
const friendOk = (a, b) => (a >= 18 && b >= 18) || (a < 18 && b < 18 && Math.abs(a - b) <= 4);
let lastMsgTs = 0;
const nextTs = () => (lastMsgTs = Math.max(Date.now(), lastMsgTs + 1)); // strictly increasing, so rapid messages keep their order
const convId = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);
const MSG_ID_RE = /^\d{13}-[a-f0-9]{8}$/, CONV_RE = /^[a-z0-9_]{3,20}~[a-z0-9_]{3,20}$/;
const areFriends = async (a, b) => (await st("friends").get(`f~${a}~${b}`)) !== null;
const blockedEither = async (a, b) => { const [x, y] = await Promise.all([st("blocks").get(`${a}~${b}`), st("blocks").get(`${b}~${a}`)]); return x !== null || y !== null; };
async function makeFriends(a, b) {
  const F = st("friends");
  await F.set(`f~${a}~${b}`, "1"); await F.set(`f~${b}~${a}`, "1");
  for (const k of [`req~${a}~${b}`, `req~${b}~${a}`, `out~${a}~${b}`, `out~${b}~${a}`]) await F.delete(k);
}
async function friendStatus(me, other) {
  const F = st("friends");
  if ((await F.get(`f~${me}~${other}`)) !== null) return "friends";
  if ((await F.get(`req~${me}~${other}`)) !== null) return "received";
  if ((await F.get(`req~${other}~${me}`)) !== null) return "sent";
  return "none";
}

// ---------- saved rate limits (shared by every server instance), word filter, activity ----------
async function hitLimit(kind, id, max, windowMs) {
  const s = st("ratelimit"), key = `${kind}~${id}`.slice(0, 120);
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" }), now = Date.now();
    let rec = cur?.data;
    if (!rec || now - rec.start > windowMs) rec = { n: 0, start: now };
    if (rec.n >= max) throw new Fail(429, `Too many attempts. Please try again in ${Math.max(1, Math.ceil((rec.start + windowMs - now) / 60000))} minute(s).`);
    rec.n += 1;
    const r = cur ? await s.set(key, JSON.stringify(rec), { onlyIfMatch: cur.etag }) : await s.set(key, JSON.stringify(rec), { onlyIfNew: true });
    if (r?.modified === true) return;
    await new Promise((res) => setTimeout(res, 5 + Math.random() * 25));
  }
  throw new Fail(429, "Too many attempts. Please try again in a minute."); // under heavy contention, fail closed
}
const clearHits = (kind, id) => st("ratelimit").delete(`${kind}~${id}`.slice(0, 120));

let wfCache = { at: 0, data: { words: [], mode: "block" } };
const lower = (t) => String(t).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const plain = (t) => " " + lower(t).replace(/[^a-z0-9]+/g, " ").trim() + " ";
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };
const leet = (t) => " " + lower(t).replace(/[0134578@$]/g, (c) => LEET[c]).replace(/[^a-z0-9]+/g, " ").trim() + " ";
async function getFilter() {
  if (Date.now() - wfCache.at < 30000) return wfCache.data;
  const d = await st("config").get("wordfilter", { type: "json" });
  wfCache = { at: Date.now(), data: d && Array.isArray(d.words) ? d : { words: [], mode: "block" } };
  return wfCache.data;
}
async function checkWords(who, where, ...texts) { // whole-word match, ignoring case, accents, punctuation and number-for-letter swaps
  const f = await getFilter();
  if (!f.words.length) return;
  const hays = texts.flatMap((t) => [plain(t), leet(t)]);
  const hit = f.words.find((w) => hays.some((h) => h.includes(" " + w + " ")));
  if (!hit) return;
  if (f.mode === "flag") {
    const ts = Date.now();
    await st("reports").set(`r~${String(9e12 - ts).padStart(13, "0")}-${randomBytes(4).toString("hex")}`,
      JSON.stringify({ type: "filtered", where, author: who, by: "word filter", reason: "filter", note: `matched "${hit}"`, text: texts.join(" ").slice(0, 200), ts }));
    return;
  }
  throw new Fail(400, "That contains a word that isn't allowed on WC Blog. Please change it and try again.");
}
const seenActive = new Set();
async function markActive(key) { // one tiny write per person per day, for the "active users" chart
  const k = `${dayKey()}~${key}`;
  if (seenActive.has(k)) return;
  if (seenActive.size > 5000) seenActive.clear();
  seenActive.add(k);
  await st("active").set(k, "1");
}
const shiftDay = (k, n) => new Date(Date.parse(k + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);

async function removeListing(id, listing, refund) { // deletes a listing for good; optionally gives every buyer their credits back
  const { blobs } = await st("sales").list({ prefix: `${id}~` });
  for (const b of blobs) {
    const buyerKey = b.key.split("~")[1];
    if (refund) {
      const sale = await st("sales").get(b.key, { type: "json" });
      await updateWallet(buyerKey, (w) => earn(w, sale?.price || listing.price, "refund", `Refund: "${listing.title}" was removed`));
    }
    await st("bought").delete(`${buyerKey}~${id}`); await st("sales").delete(b.key);
  }
  await st("mimages").delete(id); await st("listings").delete(id); await st("lsell").delete(`${listing.seller}~${id}`);
}

// Erases a person's content and personal data. The username stays reserved so nobody else can ever take it over.
async function eraseUser(un) {
  const rec = await st("users").get(un, { type: "json" });
  if (!rec) return false;
  const P = st("posts");
  for (const b of (await P.list()).blobs.slice(0, 5000)) {
    const post = await P.get(b.key, { type: "json" });
    if (post && post.username.toLowerCase() === un) {
      await moveLikes(post, b.key, null, null); await moveComments(b.key, null);
      await st("images").delete(b.key); await st("videos").delete(b.key); await P.delete(b.key);
    }
  }
  const C = st("comments");
  for (const b of (await C.list()).blobs.slice(0, 20000)) { const c = await C.get(b.key, { type: "json" }); if (c && c.username.toLowerCase() === un) await C.delete(b.key); }
  const L = st("likes");
  for (const b of (await L.list({ prefix: "p~" })).blobs) if (b.key.split("~")[2] === un) await L.delete(b.key);
  for (const b of (await L.list({ prefix: `u~${un}~` })).blobs) await L.delete(b.key);
  for (const b of (await st("follows").list({ prefix: `${un}~` })).blobs) { await st("followers").delete(`${b.key.split("~")[1]}~${un}`); await st("follows").delete(b.key); }
  for (const b of (await st("followers").list({ prefix: `${un}~` })).blobs) { await st("follows").delete(`${b.key.split("~")[1]}~${un}`); await st("followers").delete(b.key); }
  const F = st("friends");
  for (const b of (await F.list({ prefix: `f~${un}~` })).blobs) {
    const other = b.key.split("~")[2];
    for (const m of (await st("dms").list({ prefix: `${convId(un, other)}~` })).blobs) await st("dms").delete(m.key);
    await F.delete(`f~${other}~${un}`); await F.delete(b.key);
    for (const k of [`${un}~${other}`, `${other}~${un}`]) { await st("convs").delete(k); await st("dmunread").delete(k); }
  }
  for (const b of (await F.list({ prefix: `req~${un}~` })).blobs) { await F.delete(`out~${b.key.split("~")[2]}~${un}`); await F.delete(b.key); }
  for (const b of (await F.list({ prefix: `out~${un}~` })).blobs) { await F.delete(`req~${b.key.split("~")[2]}~${un}`); await F.delete(b.key); }
  for (const b of (await st("blocks").list({ prefix: `${un}~` })).blobs) await st("blocks").delete(b.key);
  for (const b of (await st("lsell").list({ prefix: `${un}~` })).blobs) {
    const id = b.key.split("~")[1], l = await st("listings").get(id, { type: "json" });
    if (l) await removeListing(id, l, true); else await st("lsell").delete(b.key);
  }
  for (const b of (await st("bought").list({ prefix: `${un}~` })).blobs) { await st("sales").delete(`${b.key.split("~")[1]}~${un}`); await st("bought").delete(b.key); }
  for (const b of (await st("notifs").list({ prefix: `${un}~` })).blobs) await st("notifs").delete(b.key);
  for (const b of (await st("active").list()).blobs) if (b.key.endsWith(`~${un}`)) await st("active").delete(b.key);
  for (const b of (await st("hwsecrets").list({ prefix: `${un}~` })).blobs) await st("hwsecrets").delete(b.key);
  await st("wallets").delete(un); await st("avatars").delete(un);
  await st("users").set(un, JSON.stringify({ username: rec.username, displayName: "Deleted user", pass: "x:x", birthdate: "1900-01-01", createdAt: rec.createdAt, deleted: true }));
  return true;
}
const BACKUP_STORES = ["users", "wallets", "posts", "comments", "likes", "follows", "followers", "friends", "blocks", "dms", "convs", "dmunread", "notifs", "reports", "listings", "sales", "bought", "lsell", "images", "mimages", "videos", "avatars", "config", "active", "hwsecrets"];
const JSON_STORES = new Set(["users", "wallets", "posts", "comments", "dms", "convs", "notifs", "reports", "listings"]);
const IMAGE_STORES = new Set(["images", "mimages", "avatars"]);

async function notify(toKey, n, rating) {
  const ts = Date.now();
  await st("notifs").set(`${toKey}~${String(9e12 - ts).padStart(13, "0")}-${rating === "13+" ? "t" : "a"}-${randomBytes(4).toString("hex")}`, JSON.stringify({ ...n, ts }));
}
async function notifyOnce(marker, toKey, n, rating) {
  const s = st("notifs");
  if ((await s.get(`m~${marker}`)) !== null) return;
  await s.set(`m~${marker}`, "1");
  await notify(toKey, n, rating);
}
async function moveComments(id, newId) { // newId = null deletes them
  const c = st("comments");
  const { blobs } = await c.list({ prefix: `${id}~` });
  for (const b of blobs) {
    const v = await c.get(b.key, { type: "json" });
    await c.delete(b.key);
    if (newId && v) await c.set(`${newId}~${b.key.split("~")[1]}`, JSON.stringify({ ...v, postId: newId }));
  }
}
async function addReport(target, user, body) {
  if (!REASONS.includes(body.reason)) throw new Fail(400, "Pick a reason.");
  const note = String(body.note ?? "").trim().slice(0, 200), s = st("reports");
  const dk = `x~${target.type}~${target.postId}~${target.cid || "-"}~${user.key}`;
  if ((await s.get(dk)) !== null) return { ok: true, already: true };
  await s.set(dk, "1");
  const ts = Date.now();
  await s.set(`r~${String(9e12 - ts).padStart(13, "0")}-${randomBytes(4).toString("hex")}`, JSON.stringify({ ...target, reason: body.reason, note, by: user.username, ts }));
  return { ok: true };
}
const authorNames = async (items, field = "username") => new Map(await Promise.all([...new Set(items.map((x) => x[field].toLowerCase()))].map(async (k) => {
  const r = await st("users").get(k, { type: "json" });
  return [k, { name: r?.displayName, user: r?.username, early: !!r && r.createdAt < EARLY, flair: SHOP[r?.flair]?.emoji || null, color: r?.color ? r.color.split(":")[1] : null, premium: (r?.premiumUntil || 0) > Date.now() }];
})));

async function route(req, context) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const method = req.method;
  let body = {};
  if (method === "POST") {
    const raw = await req.text();
    if (raw.length > (path === "/posts" || path === "/admin/restore" ? 5300000 : 1500000)) throw new Fail(413, "That upload is too large.");
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Fail(400, "Bad request."); }
    if (!body || typeof body !== "object") body = {};
  }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const user = token ? await getUser(token) : null;
  const isDev = !!user && user.key === DEV;
  const [m, siteRaw, mk, vk, upd, ck, hk] = await Promise.all([st("config").get("maintenance"), st("config").get("site", { type: "json" }), st("config").get("market"), st("config").get("videos"), st("config").get("update", { type: "json" }), st("config").get("messaging"), st("config").get("halloween")]);
  const maint = m === "on", site = siteRaw || {}, marketOn = mk !== "off", videosOn = vk !== "off", msgOn = ck !== "off", halloweenOn = hk === "on";
  if (maint && !isDev && !["/status", "/login", "/me", "/logout", "/dev-recover", "/admin/restore"].includes(path))
    throw new Fail(503, "WC Blog is in scheduled maintenance.", { maintenance: true, message: site.msg || "", until: site.until || "" });
  const ip = context?.ip || "unknown";
  if (user) await markActive(user.key);

  if (method === "GET" && path === "/status")
    return send({ maintenance: maint, message: site.msg || "", until: site.until || "", announcement: site.announcement || "", market: marketOn, videos: videosOn, messaging: msgOn, halloween: halloweenOn, halloweenEnds: HW_END, update: upd || null });

  if (method === "POST" && path === "/signup") {
    await hitLimit("signup-ip", ip, 10, 60 * 60e3);
    const u = String(body.username ?? "").trim(), dn = String(body.displayName ?? "").trim(), b = String(body.birthdate ?? "");
    const pw = body.password;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new Fail(400, "Username must be 3–20 letters, numbers or underscores.");
    if (dn.length < 1 || dn.length > 30) throw new Fail(400, "Display name must be 1–30 characters.");
    if (typeof pw !== "string" || pw.length < 8 || pw.length > 100) throw new Fail(400, "Password must be 8–100 characters.");
    const bd = /^\d{4}-\d{2}-\d{2}$/.test(b) ? new Date(b + "T00:00:00Z") : null;
    if (!bd || isNaN(bd) || bd.toISOString().slice(0, 10) !== b || bd > new Date() || bd.getUTCFullYear() < 1900)
      throw new Fail(400, "Enter a valid birthdate.");
    if (ageOf(b) < 13 && body.parentOk !== true) throw new Fail(400, "Please ask a parent or guardian first, then tick the box that says they know you're joining.");
    await checkWords(u, "name", u, dn);
    const key = u.toLowerCase();
    if (key === DEV && (!process.env.DEV_CODE || body.devCode !== process.env.DEV_CODE))
      throw new Fail(403, "That username is reserved.");
    // Under-13 accounts are saved with restricted mode on; it stays on until they choose to turn it off at 13+.
    const rec = { username: u, displayName: dn, pass: await hash(pw), birthdate: b, createdAt: Date.now(), restricted: ageOf(b) < 13 };
    // Atomic: the write only succeeds if nobody has ever claimed this username.
    const r = await st("users").set(key, JSON.stringify(rec), { onlyIfNew: true });
    if (typeof r?.modified !== "boolean") throw new Error("Blobs conditional writes unavailable; refusing to create account.");
    if (!r.modified) throw new Fail(409, "That username is already taken.");
    const t = await newSession(key);
    return send({ token: t, user: pub(view(key, rec)) });
  }

  if (method === "POST" && path === "/login") {
    const key = String(body.username ?? "").trim().toLowerCase();
    // Saved attempt counters: they hold across every server instance, per address and per account.
    await hitLimit("login-ip", ip, 25, 15 * 60e3);
    if (KEY_RE.test(key)) await hitLimit("login-user", key, 10, 15 * 60e3);
    const rec = KEY_RE.test(key) ? await st("users").get(key, { type: "json" }) : null;
    if (!rec || rec.deleted || typeof body.password !== "string" || !(await verify(body.password, rec.pass)))
      throw new Fail(401, "Wrong username or password.");
    if (rec.suspended) throw new Fail(403, "This account has been suspended.");
    await clearHits("login-user", key);
    if (maint && key !== DEV) throw new Fail(503, "WC Blog is in scheduled maintenance.", { maintenance: true, message: site.msg || "", until: site.until || "" });
    const t = await newSession(key);
    return send({ token: t, user: pub(view(key, rec)) });
  }

  if (method === "GET" && path === "/me") {
    if (!user) throw new Fail(401, "Not signed in.");
    return send({ user: pub(user) });
  }

  if (method === "POST" && path === "/logout") {
    if (/^[a-f0-9]{64}$/.test(token)) await st("sessions").delete(token);
    return send({ ok: true });
  }

  if (method === "POST" && path === "/dev-recover") {
    await hitLimit("recover-ip", ip, 5, 15 * 60e3);
    await hitLimit("recover-all", "all", 20, 60 * 60e3); // and a global cap, so rotating addresses can't be used to guess the code
    const code = process.env.DEV_CODE;
    if (!code || typeof body.devCode !== "string" || !same(body.devCode, code)) throw new Fail(403, "That developer code isn't right.");
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 100) throw new Fail(400, "Password must be 8–100 characters.");
    const rec = await st("users").get(DEV, { type: "json" });
    if (!rec) throw new Fail(404, "The developer account hasn't been created yet.");
    rec.pass = await hash(body.password);
    rec.validAfter = Date.now();
    delete rec.suspended; delete rec.mustChange;
    await st("users").set(DEV, JSON.stringify(rec));
    return send({ ok: true });
  }

  const restricted = !user || user.restricted; // logged-out viewers and restricted accounts never get 13+ content

  if (method === "POST" && path === "/settings") {
    if (!user) throw new Fail(401, "Log in first.");
    const rec = await st("users").get(user.key, { type: "json" });
    if (body.theme !== undefined) {
      if (!["light", "blue", "dark", "weather", "halloween"].includes(body.theme)) throw new Fail(400, "Unknown theme.");
      if (body.theme === "weather" && !user.premium) throw new Fail(403, "Weather Mode is a WC Blog Premium perk. Get Premium in the Weather Credits shop.");
      if (body.theme === "halloween" && !user.halloweenOk) throw new Fail(403, user.halloween ? "After October 31, the Halloween theme is only for Premium members." : "Claim the Halloween theme first (it shows up as a pop-up during the event).");
      rec.theme = body.theme;
    }
    if (body.restricted !== undefined) {
      if (typeof body.restricted !== "boolean") throw new Fail(400, "Bad request.");
      if (!body.restricted && user.forced) throw new Fail(403, "Restricted mode stays on until you turn 13.");
      rec.restricted = body.restricted;
    }
    if (body.displayName !== undefined) {
      const dn = String(body.displayName).trim();
      if (dn.length < 1 || dn.length > 30) throw new Fail(400, "Display name must be 1–30 characters.");
      await checkWords(user.username, "name", dn);
      rec.displayName = dn;
    }
    if (body.bio !== undefined) {
      const bio = String(body.bio).trim();
      if (bio.length > 160) throw new Fail(400, "Your bio can be up to 160 characters.");
      await checkWords(user.username, "bio", bio);
      rec.bio = bio;
    }
    if (body.friendRequests !== undefined) {
      if (typeof body.friendRequests !== "boolean") throw new Fail(400, "Bad request.");
      rec.friendRequests = body.friendRequests;
    }
    await st("users").set(user.key, JSON.stringify(rec));
    return send({ user: pub(view(user.key, rec)) });
  }

  if (method === "POST" && path === "/account/password") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "w", 10);
    const rec = await st("users").get(user.key, { type: "json" });
    if (typeof body.current !== "string" || !(await verify(body.current, rec.pass))) throw new Fail(403, "Your current password is wrong.");
    if (typeof body.next !== "string" || body.next.length < 8 || body.next.length > 100) throw new Fail(400, "New password must be 8–100 characters.");
    rec.pass = await hash(body.next);
    delete rec.mustChange;
    rec.validAfter = Date.now(); // signs out every other device
    await st("users").set(user.key, JSON.stringify(rec));
    return send({ token: await newSession(user.key) });
  }

  if (method === "POST" && path === "/account/delete") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "x", 5);
    if (user.key === DEV) throw new Fail(400, "The developer account can't be deleted this way.");
    const rec = await st("users").get(user.key, { type: "json" });
    if (typeof body.password !== "string" || !(await verify(body.password, rec.pass))) throw new Fail(403, "That password isn't right.");
    await eraseUser(user.key);
    return send({ ok: true });
  }

  if (method === "POST" && path === "/account/logout-all") {
    if (!user) throw new Fail(401, "Log in first.");
    const rec = await st("users").get(user.key, { type: "json" });
    rec.validAfter = Date.now();
    await st("users").set(user.key, JSON.stringify(rec));
    return send({ ok: true });
  }

  if (method === "GET" && path === "/posts") {
    const tq = url.searchParams.get("tab"), tab = tq === "all" ? "all" : tq === "following" ? "following" : "recommended";
    const tag = (url.searchParams.get("tag") || "").trim().toLowerCase();
    const by = (url.searchParams.get("user") || "").trim().toLowerCase();
    const [{ blobs }, likeList, cmtList, mine, follows] = await Promise.all([
      st("posts").list(),
      st("likes").list({ prefix: "p~" }),
      st("comments").list(),
      user ? st("likes").list({ prefix: `u~${user.key}~` }) : { blobs: [] },
      user ? st("follows").list({ prefix: `${user.key}~` }) : { blobs: [] },
    ]);
    // Key format "<reverse-time>-<a|t>-<random>": sorting gives newest first, and "t" marks 13+.
    const keys = blobs.map((b) => b.key).filter((k) => !(restricted && k.includes("-t-"))).sort().slice(0, WINDOW);
    let items = (await Promise.all(keys.map((k) => st("posts").get(k, { type: "json" })))).filter(Boolean);
    if (tag) items = items.filter((p) => p.topic === tag);
    if (by) items = items.filter((p) => p.username.toLowerCase() === by);
    if (tab === "following" && !tag && !by) {
      const fl = new Set(follows.blobs.map((b) => b.key.split("~")[1]));
      items = items.filter((p) => fl.has(p.username.toLowerCase()));
    }
    const counts = new Map(), iLike = new Set();
    for (const b of likeList.blobs) {
      const [, pid, liker] = b.key.split("~");
      counts.set(pid, (counts.get(pid) || 0) + 1);
      if (user && liker === user.key) iLike.add(pid);
    }
    const cc = new Map();
    for (const b of cmtList.blobs) { const pid = b.key.split("~")[0]; cc.set(pid, (cc.get(pid) || 0) + 1); }
    const names = await authorNames(items);
    const topics = new Map(), authors = new Map();
    for (const b of mine.blobs) {
      const [, , slug, author] = b.key.split("~");
      topics.set(slug, (topics.get(slug) || 0) + 1);
      authors.set(author, (authors.get(author) || 0) + 1);
    }
    const followed = new Set(follows.blobs.map((b) => b.key.split("~")[1]));
    const now = Date.now();
    const out = items.map((p) => {
      const a = p.username.toLowerCase(), slug = slugOf(p.topic), n = counts.get(p.id) || 0;
      const tl = topics.get(slug) || 0, al = authors.get(a) || 0, f = followed.has(a);
      // Recommended: topics and authors you liked, people you follow, what's popular, and what's new.
      const score = 5 * Math.min(tl, 5) + 3 * Math.min(al, 5) + (f ? 6 : 0) + Math.log2(1 + n) + ((p.boostUntil || 0) > now ? 8 : 0) + 3 / (1 + (now - p.createdAt) / 36e5 / 24);
      const nm = names.get(a), name = nm?.name || p.displayName;
      const reason = f ? "From someone you follow" : tl ? `Because you liked #${p.topic} posts` : al ? `Because you liked posts by ${name}` : null;
      return { score, reason, post: { id: p.id, title: p.title, topic: p.topic, body: p.body, rating: p.rating, hasImage: p.hasImage,
        username: p.username, displayName: name, early: nm?.early === true, flair: nm?.flair || null, color: nm?.color || null, premium: nm?.premium === true, hasVideo: !!p.hasVideo,
        boosted: (p.boostUntil || 0) > now, createdAt: p.createdAt, editedAt: p.editedAt || null,
        likes: n, liked: iLike.has(p.id), comments: cc.get(p.id) || 0 } };
    });
    const showRec = tab === "recommended" && !tag && !by;
    if (showRec) out.sort((x, y) => y.score - x.score || (x.post.id < y.post.id ? -1 : 1));
    return send({ posts: out.slice(0, 40).map((o) => ({ ...o.post, reason: showRec ? o.reason : null })) });
  }

  if (method === "POST" && path === "/posts") {
    if (!user) throw new Fail(401, "Log in to post.");
    limit(ip + "p", 20);
    const { t, tp, bo } = cleanPost(body);
    await checkWords(user.username, "post", t, tp, bo);
    const image = body.image ?? null;
    if (image !== null) checkImage(image);
    let vid = null;
    if (body.video != null) {
      if (!user.premium) throw new Fail(403, "Video posts are a WC Blog Premium perk. Get Premium in the Weather Credits shop.");
      if (!videosOn) throw new Fail(403, "Video uploads are paused right now.");
      if (image !== null) throw new Fail(400, "Choose an image or a video, not both.");
      vid = parseVideo(body.video);
    }
    const rating = user.restricted ? "all" : body.rating; // restricted accounts can't publish 13+ posts
    const id = postId(String(9e12 - Date.now()).padStart(13, "0"), rating, randomBytes(4).toString("hex"));
    if (image) await st("images").set(id, image);
    if (vid) await st("videos").set(id, vid.data);
    await st("posts").set(id, JSON.stringify({ id, title: t, topic: tp, body: bo, rating, hasImage: !!image, hasVideo: !!vid, videoType: vid?.type,
      username: user.username, displayName: user.displayName, createdAt: Date.now() }));
    return send({ id });
  }

  if (path === "/notifications" || path === "/notifications/count" || path === "/notifications/read") {
    if (!user) throw new Fail(401, "Log in first.");
    const rec = await st("users").get(user.key, { type: "json" });
    if (method === "POST" && path === "/notifications/read") {
      rec.notifSeen = Date.now();
      await st("users").set(user.key, JSON.stringify(rec));
      return send({ ok: true });
    }
    if (method !== "GET") throw new Fail(404, "Not found.");
    const { blobs } = await st("notifs").list({ prefix: `${user.key}~` });
    const keys = blobs.map((b) => b.key).filter((k) => !(restricted && k.includes("-t-"))).sort();
    const seen = rec.notifSeen || 0, tsOf = (k) => 9e12 - Number(k.split("~")[1].slice(0, 13));
    const unread = Math.min(keys.filter((k) => tsOf(k) > seen).length, 99);
    if (path === "/notifications/count") {
      const reports = isDev ? (await st("reports").list({ prefix: "r~" })).blobs.length : 0;
      let w0 = await walletOf(user.key); w0 = (await maybeRenew(user.key, w0)) || w0;
      const wv = walletView(w0);
      const [um, rq] = await Promise.all([st("dmunread").list({ prefix: `${user.key}~` }), st("friends").list({ prefix: `req~${user.key}~` })]);
      return send({ unread, reports, balance: wv.balance, streak: wv.streak, canCheckIn: wv.canCheckIn, freezes: wv.freezes, dms: um.blobs.length, requests: rq.blobs.length });
    }
    const items = (await Promise.all(keys.slice(0, 30).map((k) => st("notifs").get(k, { type: "json" })))).filter(Boolean);
    return send({ items, unread });
  }

  if (method === "GET" && path === "/halloween/secrets") {
    if (!user) throw new Fail(401, "Log in first.");
    return send({ found: (await st("hwsecrets").list({ prefix: `${user.key}~` })).blobs.map((b) => b.key.split("~")[1]), total: HW_SECRETS.length });
  }
  if (method === "POST" && path === "/halloween/secret") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "hs", 60);
    if (!user.halloweenOk) throw new Fail(403, "Unlock the Halloween theme to hunt for secrets.");
    const id = String(body.id ?? "");
    if (!HW_SECRETS.includes(id)) throw new Fail(400, "Unknown secret.");
    const r = await st("hwsecrets").set(`${user.key}~${id}`, "1", { onlyIfNew: true });
    const found = (await st("hwsecrets").list({ prefix: `${user.key}~` })).blobs.map((b) => b.key.split("~")[1]);
    let badge = false;
    if (HW_SECRETS.every((x) => found.includes(x))) {
      await updateWallet(user.key, (w) => { badge = false; if (w.owned.includes("flair:ghost")) return; w.owned.push("flair:ghost"); badge = true; });
    }
    return send({ id, isNew: r?.modified === true, found, total: HW_SECRETS.length, complete: found.length === HW_SECRETS.length, badge });
  }
  if (method === "POST" && path === "/halloween/claim") {
    if (!user) throw new Fail(401, "Log in to claim it.");
    if (!user.halloween) {
      const after = Date.now() >= HW_END;
      if (after ? !user.premium : !halloweenOn) throw new Fail(403, after ? "After October 31, the Halloween theme is only for Premium members." : "The Halloween event isn't open right now.");
    }
    let gift = false;
    await updateWallet(user.key, (w) => { // the wallet is the gate, so a double-click can never pay twice
      gift = false;
      if (w.owned.includes("flair:pumpkin")) return;
      w.owned.push("flair:pumpkin"); earn(w, 31, "event", "Halloween gift 🎃"); gift = true;
    });
    const rec = await st("users").get(user.key, { type: "json" });
    if (!rec.halloweenClaimed) { rec.halloweenClaimed = Date.now(); await st("users").set(user.key, JSON.stringify(rec)); }
    return send({ user: pub(view(user.key, rec)), gift });
  }
  if (path === "/wallet/top" && method === "GET") {
    const keys = (await st("wallets").list()).blobs.map((b) => b.key).slice(0, 300);
    const rows = (await Promise.all(keys.map(async (k) => ({ username: k, w: await st("wallets").get(k, { type: "json" }) }))))
      .filter((r) => r.w).map((r) => ({ username: r.username, streak: streakInfo(r.w).effective, best: r.w.best }))
      .filter((r) => r.streak > 0).sort((a, b) => b.streak - a.streak || b.best - a.best).slice(0, 10);
    const names = await authorNames(rows);
    return send({ top: rows.map((r) => { const nm = names.get(r.username); return { username: nm?.user || r.username, displayName: nm?.name || r.username, streak: r.streak, flair: nm?.flair || null, color: nm?.color || null, premium: nm?.premium === true }; }) });
  }
  if (path === "/wallet" || path.startsWith("/wallet/") || path === "/shop" || path.startsWith("/shop/")) {
    if (!user) throw new Fail(401, "Log in first.");
    if (method === "GET" && path === "/wallet") { let w = await walletOf(user.key); w = (await maybeRenew(user.key, w)) || w; return send({ ...walletView(w), log: w.log.slice(0, 20) }); }
    if (method === "POST" && path === "/wallet/checkin") {
      limit(ip + "ci", 20);
      let out;
      const w = await updateWallet(user.key, (w) => {
        const info = streakInfo(w);
        if (!info.canCheckIn) throw new Fail(409, "You already checked in today. Come back tomorrow!");
        let used = false;
        if (w.lastDay && info.gap === 2 && w.freezes > 0) { w.freezes -= 1; w.streak += 1; used = true; }
        else if (w.lastDay && info.gap === 1) w.streak += 1;
        else w.streak = 1;
        w.best = Math.max(w.best, w.streak); w.lastDay = dayKey();
        const reward = rewardFor(w.streak) + (premiumActive(w) ? 5 : 0); // Premium members earn +5 a day
        earn(w, reward, "checkin", `Day ${w.streak} streak`);
        out = { reward, streakNow: w.streak, usedFreeze: used };
      });
      return send({ ...out, ...walletView(w) });
    }
    if (method === "GET" && path === "/shop") {
      const [w, rec] = await Promise.all([walletOf(user.key), st("users").get(user.key, { type: "json" })]);
      return send({ items: Object.entries(SHOP).map(([id, i]) => ({ id, name: i.name, price: i.price, kind: i.kind, section: i.section, event: !!i.event, emoji: i.emoji || null })),
        freezeCap: freezeCap(w), premium: walletView(w).premium,
        owned: w.owned, freezes: w.freezes, boostPrice: BOOST_PRICE, tips: TIPS, equipped: { color: rec.color || null, flair: rec.flair || null } });
    }
    if (method === "POST" && path === "/shop/buy") {
      limit(ip + "sh", 30);
      const id = String(body.item ?? "");
      if (!Object.hasOwn(SHOP, id)) throw new Fail(404, "Unknown item.");
      const it = SHOP[id];
      if (it.event) throw new Fail(403, "That's an event exclusive. You can only get it by claiming it during the event.");
      const w = await updateWallet(user.key, (w) => {
        if (it.kind === "freeze") { const cap = freezeCap(w); if (w.freezes >= cap) throw new Fail(409, `You can hold up to ${cap} Streak Freezes.`); }
        else if (w.owned.includes(id)) throw new Fail(409, "You already own that.");
        spend(w, it.price, it.name);
        if (it.kind === "freeze") w.freezes += 1; else w.owned.push(id);
      });
      return send(walletView(w));
    }
    if (method === "POST" && path === "/shop/premium") {
      limit(ip + "pr", 10);
      const w = await updateWallet(user.key, (w) => {
        const now = Date.now(), base = Math.max(w.premiumUntil || 0, now);
        if (base - now > 60 * DAY_MS) throw new Fail(409, "You already have more than two months of Premium.");
        spend(w, PREMIUM_PRICE, (w.premiumUntil || 0) > now ? "WC Blog Premium (extended 30 days)" : "WC Blog Premium");
        w.premiumUntil = base + PREMIUM_DAYS * DAY_MS;
        if (w.autoRenew === undefined) w.autoRenew = true;
        w.freezes = Math.min(freezeCap(w), w.freezes + 1); // a free Streak Freeze with every month
      });
      await mirrorPremium(user.key, w.premiumUntil);
      return send(walletView(w));
    }
    if (method === "POST" && path === "/shop/premium/auto") {
      return send(walletView(await updateWallet(user.key, (w) => { w.autoRenew = body.on === true; })));
    }
    if (method === "POST" && path === "/shop/equip") {
      const [w, rec] = await Promise.all([walletOf(user.key), st("users").get(user.key, { type: "json" })]);
      for (const f of ["color", "flair"]) {
        const v = body[f];
        if (v === undefined) continue;
        if (v === null) delete rec[f];
        else if (typeof v === "string" && Object.hasOwn(SHOP, v) && SHOP[v].kind === f && w.owned.includes(v)) rec[f] = v;
        else throw new Fail(403, "You don't own that yet.");
      }
      await st("users").set(user.key, JSON.stringify(rec));
      return send({ user: pub(view(user.key, rec)) });
    }
  }

  if (path === "/friends" || path.startsWith("/friends/") || path.startsWith("/dm/")) {
    if (!user) throw new Fail(401, "Log in first.");
    if (!msgOn) throw new Fail(403, "Messaging is paused right now.");
    const F = st("friends"), who = (k) => (KEY_RE.test(k) ? k : null);
    const shape = (names, k) => { const nm = names.get(k); return { username: nm?.user || k, displayName: nm?.name || k, flair: nm?.flair || null, color: nm?.color || null, premium: nm?.premium === true }; };
    if (method === "GET" && path === "/friends") {
      const [fl, inc, out, bl, unr] = await Promise.all([F.list({ prefix: `f~${user.key}~` }), F.list({ prefix: `req~${user.key}~` }), F.list({ prefix: `out~${user.key}~` }),
        st("blocks").list({ prefix: `${user.key}~` }), st("dmunread").list({ prefix: `${user.key}~` })]);
      const third = (b) => b.key.split("~")[2], second = (b) => b.key.split("~")[1];
      const friends = fl.blobs.map(third), incoming = inc.blobs.map(third), outgoing = out.blobs.map(third), blocked = bl.blobs.map(second), unread = new Set(unr.blobs.map(second));
      const convs = new Map(await Promise.all(friends.map(async (k) => [k, await st("convs").get(`${user.key}~${k}`, { type: "json" })])));
      const names = await authorNames([...friends, ...incoming, ...outgoing, ...blocked].map((k) => ({ username: k })));
      return send({
        friends: friends.map((k) => ({ ...shape(names, k), unread: unread.has(k), last: convs.get(k)?.last || 0, preview: convs.get(k)?.preview || "", lastFromMe: convs.get(k)?.lastFrom === user.key }))
          .sort((x, y) => (y.unread - x.unread) || y.last - x.last),
        incoming: incoming.map((k) => shape(names, k)), outgoing: outgoing.map((k) => shape(names, k)), blocked: blocked.map((k) => shape(names, k)),
      });
    }
    if (method === "POST" && path.startsWith("/friends/")) {
      const act = path.slice(9), t = who(String(body.username ?? "").toLowerCase());
      if (!["request", "respond", "cancel", "remove", "block"].includes(act)) throw new Fail(404, "Not found.");
      if (!t) throw new Fail(404, "We couldn't find that person.");
      if (t === user.key) throw new Fail(400, "That's you!");
      const rec = await st("users").get(t, { type: "json" });
      if (!rec || rec.suspended || rec.deleted) throw new Fail(404, "We couldn't find that person.");
      if (act === "request") {
        limit(ip + "fr", 20);
        if (await areFriends(user.key, t)) throw new Fail(409, "You're already friends.");
        if (await blockedEither(user.key, t)) throw new Fail(403, "You can't send this person a request.");
        if (!friendOk(user.age, ageOf(rec.birthdate))) throw new Fail(403, "You can only be friends with people close to your own age.");
        if (rec.friendRequests === false) throw new Fail(403, "This person isn't accepting friend requests.");
        if ((await F.get(`req~${user.key}~${t}`)) !== null) { // they already asked you: that makes you friends
          await makeFriends(user.key, t);
          await notify(t, { type: "friend_accept", from: user.username, displayName: user.displayName }, "all");
          return send({ status: "friends" });
        }
        if ((await F.get(`req~${t}~${user.key}`)) !== null) return send({ status: "sent" });
        if ((await F.list({ prefix: `f~${user.key}~` })).blobs.length >= 200) throw new Fail(400, "You have 200 friends already.");
        if ((await F.list({ prefix: `out~${user.key}~` })).blobs.length >= 50) throw new Fail(400, "You have 50 requests waiting. Cancel a few first.");
        await F.set(`req~${t}~${user.key}`, "1"); await F.set(`out~${user.key}~${t}`, "1");
        await notifyOnce(`freq~${user.key}~${t}`, t, { type: "friend_request", from: user.username, displayName: user.displayName }, "all");
        return send({ status: "sent" });
      }
      if (act === "respond") {
        if ((await F.get(`req~${user.key}~${t}`)) === null) throw new Fail(404, "That request is gone.");
        if (body.accept === true) {
          if (await blockedEither(user.key, t)) throw new Fail(403, "You can't accept this request.");
          await makeFriends(user.key, t);
          await notify(t, { type: "friend_accept", from: user.username, displayName: user.displayName }, "all");
          return send({ status: "friends" });
        }
        await F.delete(`req~${user.key}~${t}`); await F.delete(`out~${t}~${user.key}`);
        return send({ status: "none" });
      }
      if (act === "cancel") { await F.delete(`req~${t}~${user.key}`); await F.delete(`out~${user.key}~${t}`); return send({ status: "none" }); }
      const unfriend = async () => {
        for (const k of [`f~${user.key}~${t}`, `f~${t}~${user.key}`, `req~${user.key}~${t}`, `req~${t}~${user.key}`, `out~${user.key}~${t}`, `out~${t}~${user.key}`]) await F.delete(k);
        await st("dmunread").delete(`${user.key}~${t}`); await st("dmunread").delete(`${t}~${user.key}`);
      };
      if (act === "remove") { await unfriend(); return send({ status: "none" }); }
      if (body.block === true) { await unfriend(); await st("blocks").set(`${user.key}~${t}`, "1"); return send({ blocked: true }); }
      await st("blocks").delete(`${user.key}~${t}`);
      return send({ blocked: false });
    }
    const dm = path.match(/^\/dm\/([A-Za-z0-9_]{3,20})(?:\/(delete|report))?$/);
    if (dm) {
      const t = dm[1].toLowerCase(), act = dm[2];
      if (t === user.key) throw new Fail(400, "That's you!");
      if (!(await areFriends(user.key, t))) throw new Fail(403, "You can only message your friends.");
      if (await blockedEither(user.key, t)) throw new Fail(403, "You can't message this person.");
      const cid = convId(user.key, t), M = st("dms");
      const allKeys = async () => (await M.list({ prefix: `${cid}~` })).blobs.map((b) => b.key).sort();
      if (method === "GET" && !act) {
        const after = url.searchParams.get("after") || "";
        const keys = (await allKeys()).filter((k) => k.split("~")[2] > after).slice(-60);
        const msgs = (await Promise.all(keys.map((k) => M.get(k, { type: "json" })))).filter(Boolean);
        await st("dmunread").delete(`${user.key}~${t}`);
        return send({ friend: shape(await authorNames([{ username: t }]), t), messages: msgs.map((m) => ({ id: m.id, from: m.from, text: m.text, ts: m.ts })) });
      }
      if (method === "POST" && !act) {
        limit(ip + "dm", 40);
        const text = String(body.text ?? "").trim();
        if (!text || text.length > 1000) throw new Fail(400, "Messages must be 1–1000 characters.");
        await checkWords(user.username, "message", text);
        const ts = nextTs(), id = `${String(ts).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
        await M.set(`${cid}~${id}`, JSON.stringify({ id, from: user.key, text, ts }));
        const meta = JSON.stringify({ last: ts, lastFrom: user.key, preview: text.slice(0, 60) });
        await Promise.all([st("convs").set(`${user.key}~${t}`, meta), st("convs").set(`${t}~${user.key}`, meta), st("dmunread").set(`${t}~${user.key}`, "1")]);
        return send({ id, ts });
      }
      const mid = String(body.id ?? "");
      if (method === "POST" && act && MSG_ID_RE.test(mid)) {
        const msg = await M.get(`${cid}~${mid}`, { type: "json" });
        if (!msg) throw new Fail(404, "That message is gone.");
        if (act === "delete") {
          if (msg.from !== user.key) throw new Fail(403, "You can only delete your own messages.");
          await M.delete(`${cid}~${mid}`);
          return send({ ok: true });
        }
        limit(ip + "dr", 10);
        if (msg.from === user.key) throw new Fail(400, "You can't report your own message.");
        const keys = await allKeys(), at = keys.indexOf(`${cid}~${mid}`);
        const context = (await Promise.all(keys.slice(Math.max(0, at - 5), at + 1).map((k) => M.get(k, { type: "json" })))).filter(Boolean).map((m) => ({ from: m.from, text: m.text.slice(0, 200) }));
        return send(await addReport({ type: "message", postId: cid, cid: mid, author: msg.from, text: msg.text.slice(0, 200), context }, user, body));
      }
    }
    throw new Fail(404, "Not found.");
  }

  if (path === "/market" || path.startsWith("/market/")) {
    if (!marketOn && !isDev) throw new Fail(403, "The marketplace is paused right now.");
    if (method === "GET" && path === "/market") {
      const mine = url.searchParams.get("mine") === "1", owned = url.searchParams.get("owned") === "1", popular = url.searchParams.get("sort") === "popular";
      if ((mine || owned) && !user) throw new Fail(401, "Log in first.");
      const boughtSet = user ? new Set((await st("bought").list({ prefix: `${user.key}~` })).blobs.map((b) => b.key.split("~")[1])) : new Set();
      let keys;
      if (mine) keys = (await st("lsell").list({ prefix: `${user.key}~` })).blobs.map((b) => b.key.split("~")[1]);
      else if (owned) keys = [...boughtSet];
      else keys = (await st("listings").list()).blobs.map((b) => b.key);
      keys = keys.filter((k) => !(restricted && k.includes("-t-"))).sort().slice(0, 100);
      let items = (await Promise.all(keys.map((k) => st("listings").get(k, { type: "json" })))).filter(Boolean);
      if (!mine && !owned) items = items.filter((l) => l.active);
      const sc = new Map();
      for (const b of (await st("sales").list()).blobs) { const lid = b.key.split("~")[0]; sc.set(lid, (sc.get(lid) || 0) + 1); }
      const names = await authorNames(items, "seller");
      let out = items.map((l) => { const nm = names.get(l.seller); return { id: l.id, title: l.title, desc: l.desc, price: l.price, rating: l.rating, preview: l.preview,
        seller: { username: nm?.user || l.seller, displayName: nm?.name || l.seller, flair: nm?.flair || null, color: nm?.color || null, premium: nm?.premium === true },
        sales: sc.get(l.id) || 0, active: l.active, mine: !!user && l.seller === user.key, owned: boughtSet.has(l.id), createdAt: l.createdAt }; });
      if (popular) out.sort((a, b) => b.sales - a.sales || (a.id < b.id ? -1 : 1));
      return send({ listings: out.slice(0, 40), feePct: FEE_PCT });
    }
    if (method === "POST" && path === "/market") {
      if (!user) throw new Fail(401, "Log in first.");
      limit(ip + "m", 10);
      const title = String(body.title ?? "").trim(), desc = String(body.desc ?? "").trim(), price = body.price;
      if (!title || title.length > 60) throw new Fail(400, "Title must be 1–60 characters.");
      if (desc.length > 200) throw new Fail(400, "Description can be up to 200 characters.");
      if (!Number.isInteger(price) || price < 1 || price > 5000) throw new Fail(400, "Price must be a whole number from 1 to 5000.");
      if (body.rights !== true) throw new Fail(400, "Confirm that you made this image or have the right to sell it.");
      await checkWords(user.username, "listing", title, desc);
      checkImage(body.image); checkImage(body.preview, 25000);
      const cap = user.premium ? 100 : 40;
      if ((await st("lsell").list({ prefix: `${user.key}~` })).blobs.length >= cap) throw new Fail(400, `You already have ${cap} listings.`);
      const rating = "all"; // the market is for safe, all-ages images only
      const id = postId(String(9e12 - Date.now()).padStart(13, "0"), rating, randomBytes(4).toString("hex"));
      await st("mimages").set(id, body.image);
      await st("listings").set(id, JSON.stringify({ id, title, desc, price, rating, seller: user.key, createdAt: Date.now(), active: true, preview: body.preview }));
      await st("lsell").set(`${user.key}~${id}`, "1");
      return send({ id });
    }
    const mm = path.match(/^\/market\/([^/]+)\/(image|buy|takedown|report)$/);
    if (mm) {
      const [, id, act] = mm;
      if (!ID_RE.test(id) || (restricted && id.includes("-t-"))) throw new Fail(404, "Listing not found.");
      const listing = await st("listings").get(id, { type: "json" });
      if (!listing) throw new Fail(404, "Listing not found.");
      if (!user) throw new Fail(401, "Log in first.");
      if (act === "image" && method === "GET") {
        const has = listing.seller === user.key || isDev || (await st("bought").get(`${user.key}~${id}`)) !== null;
        if (!has) throw new Fail(403, "Buy this image to unlock it.");
        const image = await st("mimages").get(id);
        if (image === null) throw new Fail(404, "That image is no longer available.");
        return send({ image, title: listing.title });
      }
      if (method === "POST" && act === "buy") {
        if (!listing.active) throw new Fail(404, "That listing was taken down.");
        if (listing.seller === user.key) throw new Fail(400, "You can't buy your own image.");
        limit(ip + "b", 20);
        if ((await st("bought").get(`${user.key}~${id}`)) !== null) return send({ ok: true, already: true });
        const sale = await st("sales").set(`${id}~${user.key}`, JSON.stringify({ price: listing.price, ts: Date.now() }), { onlyIfNew: true });
        if (sale?.modified !== true) {
          if ((await st("bought").get(`${user.key}~${id}`)) !== null) return send({ ok: true, already: true });
          throw new Fail(409, "Your purchase is still going through. Check My purchases in a moment.");
        }
        const sRec = await st("users").get(listing.seller, { type: "json" }), feePct = (sRec?.premiumUntil || 0) > Date.now() ? 5 : FEE_PCT; // Premium sellers keep 95%
        const payout = listing.price - Math.floor(listing.price * feePct / 100);
        let buyer;
        try { buyer = await updateWallet(user.key, (w) => spend(w, listing.price, `Bought "${listing.title}"`)); }
        catch (e) { await st("sales").delete(`${id}~${user.key}`); throw e; }
        try { await updateWallet(listing.seller, (w) => earn(w, payout, "sale", `Sold "${listing.title}" to @${user.username}`)); }
        catch (e) {
          await updateWallet(user.key, (w) => earn(w, listing.price, "refund", `Refund for "${listing.title}"`)).catch(() => {});
          await st("sales").delete(`${id}~${user.key}`);
          throw e;
        }
        await st("bought").set(`${user.key}~${id}`, "1");
        await notify(listing.seller, { type: "sale", from: user.username, displayName: user.displayName, title: listing.title, amount: payout }, listing.rating);
        return send({ ok: true, balance: buyer.balance });
      }
      if (method === "POST" && act === "takedown") {
        if (listing.seller !== user.key && !isDev) throw new Fail(403, "You can only take down your own listings.");
        if (isDev && body.remove === true) { // hard delete, optionally refunding every buyer
          await removeListing(id, listing, body.refund === true);
          return send({ ok: true, removed: true });
        }
        await st("listings").set(id, JSON.stringify({ ...listing, active: false }));
        return send({ ok: true });
      }
      if (method === "POST" && act === "report") {
        limit(ip + "r", 10);
        if (listing.seller === user.key) throw new Fail(400, "You can't report your own listing.");
        return send(await addReport({ type: "listing", postId: id, title: listing.title, author: listing.seller }, user, body));
      }
    }
    throw new Fail(404, "Not found.");
  }

  const cl = method === "GET" && path.match(/^\/posts\/([^/]+)\/comments$/);
  if (cl) {
    const id = cl[1];
    if (!ID_RE.test(id) || (restricted && id.includes("-t-"))) throw new Fail(404, "Post not found.");
    const post = await st("posts").get(id, { type: "json" });
    if (!post) throw new Fail(404, "Post not found.");
    const { blobs } = await st("comments").list({ prefix: `${id}~` });
    const items = (await Promise.all(blobs.map((b) => b.key).sort().slice(0, 200).map((k) => st("comments").get(k, { type: "json" })))).filter(Boolean);
    const names = await authorNames(items);
    return send({ post: { id, title: post.title, username: post.username }, comments: items.map((c) => {
      const nm = names.get(c.username.toLowerCase());
      return { cid: c.cid, username: c.username, displayName: nm?.name || c.username, early: nm?.early === true, flair: nm?.flair || null, color: nm?.color || null, premium: nm?.premium === true, text: c.text, ts: c.ts };
    }) });
  }

  const cm = method === "POST" && path.match(/^\/comments\/([^/]+)\/([^/]+)\/(delete|report)$/);
  if (cm) {
    if (!user) throw new Fail(401, "Log in first.");
    const [, pid, cid, act] = cm;
    if (!ID_RE.test(pid) || !CID_RE.test(cid) || (restricted && pid.includes("-t-"))) throw new Fail(404, "Comment not found.");
    const c = await st("comments").get(`${pid}~${cid}`, { type: "json" });
    if (!c) throw new Fail(404, "Comment not found.");
    const post = await st("posts").get(pid, { type: "json" });
    if (act === "delete") {
      if (!(c.username.toLowerCase() === user.key || isDev || (post && post.username.toLowerCase() === user.key))) throw new Fail(403, "You can't delete that comment.");
      await st("comments").delete(`${pid}~${cid}`);
      return send({ ok: true });
    }
    limit(ip + "r", 10);
    if (c.username.toLowerCase() === user.key) throw new Fail(400, "You can't report your own comment.");
    return send(await addReport({ type: "comment", postId: pid, cid, title: post?.title || "", author: c.username, text: c.text.slice(0, 200) }, user, body));
  }

  const pm = method === "POST" && path.match(/^\/posts\/([^/]+)\/(edit|delete|like|report|comment|boost|tip)$/);
  if (pm) {
    if (!user) throw new Fail(401, "Log in first.");
    const [, id, act] = pm;
    if (!ID_RE.test(id) || (user.restricted && id.includes("-t-"))) throw new Fail(404, "Post not found.");
    const post = await st("posts").get(id, { type: "json" });
    if (!post) throw new Fail(404, "Post not found.");
    const mine = post.username.toLowerCase() === user.key;

    if (act === "like") {
      limit(ip + "k", 120);
      const likes = st("likes"), pk = `p~${id}~${user.key}`;
      if (body.like === true) {
        await likes.set(pk, "1"); await likes.set(likeKey(user.key, post, id), "1");
        if (!mine) await notifyOnce(`like~${id}~${user.key}`, post.username.toLowerCase(), { type: "like", from: user.username, displayName: user.displayName, postId: id, title: post.title }, post.rating);
      }
      else { await likes.delete(pk); await likes.delete(likeKey(user.key, post, id)); }
      return send({ liked: body.like === true, likes: await count("likes", `p~${id}~`) });
    }

    if (act === "tip") {
      limit(ip + "t", 30);
      if (mine) throw new Fail(400, "You can't tip your own post.");
      const amt = Number(body.amount);
      if (!TIPS.includes(amt)) throw new Fail(400, "Choose 5, 10 or 25 credits.");
      const me2 = await updateWallet(user.key, (w) => spend(w, amt, `Tip to @${post.username}`));
      try { await updateWallet(post.username.toLowerCase(), (w) => earn(w, amt, "tip", `Tip from @${user.username}`)); }
      catch (e) { await updateWallet(user.key, (w) => earn(w, amt, "refund", "Tip refund")).catch(() => {}); throw e; }
      await notify(post.username.toLowerCase(), { type: "tip", from: user.username, displayName: user.displayName, postId: id, title: post.title, amount: amt }, post.rating);
      return send({ ok: true, balance: me2.balance });
    }

    if (act === "boost") {
      if (!mine) throw new Fail(403, "You can only boost your own posts.");
      if ((post.boostUntil || 0) > Date.now()) throw new Fail(409, "This post is already boosted.");
      const w = await updateWallet(user.key, (w) => spend(w, BOOST_PRICE, "Post boost"));
      const until = Date.now() + 864e5;
      try { await st("posts").set(id, JSON.stringify({ ...post, boostUntil: until })); }
      catch (e) { await updateWallet(user.key, (w) => earn(w, BOOST_PRICE, "refund", "Boost refund")).catch(() => {}); throw e; }
      return send({ ok: true, until, balance: w.balance });
    }

    if (act === "comment") {
      limit(ip + "c", 30);
      const text = String(body.text ?? "").trim();
      if (!text || text.length > 500) throw new Fail(400, "Comments must be 1–500 characters.");
      await checkWords(user.username, "comment", text);
      const cid = `${String(Date.now()).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
      await st("comments").set(`${id}~${cid}`, JSON.stringify({ cid, postId: id, username: user.username, text, ts: Date.now() }));
      if (!mine) await notify(post.username.toLowerCase(), { type: "comment", from: user.username, displayName: user.displayName, postId: id, title: post.title }, post.rating);
      return send({ cid });
    }

    if (act === "report") {
      limit(ip + "r", 10);
      if (mine) throw new Fail(400, "You can't report your own post.");
      return send(await addReport({ type: "post", postId: id, title: post.title, author: post.username, rating: post.rating }, user, body));
    }

    if (act === "delete") {
      if (!mine && !isDev) throw new Fail(403, "You can only delete your own posts.");
      await moveLikes(post, id, null, null);
      await moveComments(id, null);
      await st("images").delete(id);
      await st("videos").delete(id);
      await st("posts").delete(id);
      return send({ ok: true });
    }

    if (!mine) throw new Fail(403, "You can only edit your own posts.");
    limit(ip + "e", 30);
    const { t, tp, bo } = cleanPost(body);
    await checkWords(user.username, "post", t, tp, bo);
    const rating = user.restricted ? "all" : body.rating;
    if (body.image != null && post.hasVideo && body.removeVideo !== true) throw new Fail(400, "A post can have an image or a video, not both.");
    let image; // undefined = keep the current image
    if (body.image != null) { checkImage(body.image); image = body.image; }
    else if (body.removeImage === true) image = null;
    const [ts, , rand] = id.split("-");
    const newId = postId(ts, rating, rand);
    const data = image === undefined ? (post.hasImage ? await st("images").get(id) : null) : image;
    if (data) await st("images").set(newId, data);
    const keepVideo = !!post.hasVideo && body.removeVideo !== true;
    if (keepVideo && newId !== id) { const vb = await st("videos").get(id, { type: "arrayBuffer" }); if (vb) await st("videos").set(newId, vb); }
    const next = { ...post, id: newId, title: t, topic: tp, body: bo, rating, hasImage: !!data, hasVideo: keepVideo, editedAt: Date.now() };
    await st("posts").set(newId, JSON.stringify(next));
    if (newId !== id) { await st("posts").delete(id); await st("images").delete(id); await st("videos").delete(id); }
    else { if (!data) await st("images").delete(id); if (!keepVideo) await st("videos").delete(id); }
    if (newId !== id || tp !== post.topic) await moveLikes(post, id, next, newId);
    if (newId !== id) await moveComments(id, newId);
    return send({ id: newId });
  }

  const vm = method === "GET" && path.match(/^\/video\/([^/]+)$/);
  if (vm) {
    const id = vm[1];
    if (!ID_RE.test(id) || (restricted && id.includes("-t-"))) throw new Fail(404, "Not found.");
    const post = await st("posts").get(id, { type: "json" });
    const buf = post?.hasVideo ? await st("videos").get(id, { type: "arrayBuffer" }) : null;
    if (!buf) throw new Fail(404, "Not found.");
    return new Response(buf, { headers: { "content-type": post.videoType || "video/mp4", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  }

  if (method === "GET" && path.startsWith("/image/")) {
    const id = path.slice(7);
    if (!ID_RE.test(id) || (restricted && id.includes("-t-"))) throw new Fail(404, "Not found.");
    const image = await st("images").get(id);
    if (image === null) throw new Fail(404, "Not found.");
    return send({ image });
  }

  if (method === "GET" && path === "/avatars") {
    const names = [...new Set((url.searchParams.get("u") || "").split(",").map((s) => s.trim().toLowerCase()).filter((n) => KEY_RE.test(n)))].slice(0, 40);
    const avatars = {};
    await Promise.all(names.map(async (n) => { avatars[n] = await st("avatars").get(n); }));
    return send({ avatars });
  }

  if (method === "POST" && path === "/avatar") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "a", 20);
    if (body.image === null) await st("avatars").delete(user.key);
    else { checkImage(body.image, 60000); await st("avatars").set(user.key, body.image); }
    return send({ ok: true });
  }

  const prm = method === "GET" && path.match(/^\/profile\/([A-Za-z0-9_]{3,20})$/);
  if (prm) {
    const key = prm[1].toLowerCase();
    const rec = await st("users").get(key, { type: "json" });
    if (!rec || rec.deleted) throw new Fail(404, "We couldn't find that person.");
    const [followers, following, rel] = await Promise.all([
      count("followers", `${key}~`), count("follows", `${key}~`),
      user ? st("follows").get(`${user.key}~${key}`) : null,
    ]);
    return send({ username: rec.username, displayName: rec.displayName, followers, following, isFollowing: rel !== null && rel !== undefined, isDev: key === DEV,
      bio: rec.bio || "", early: rec.createdAt < EARLY,
      flair: SHOP[rec.flair]?.emoji || null, color: rec.color ? rec.color.split(":")[1] : null, streak: streakInfo(await walletOf(key)).effective, premium: (rec.premiumUntil || 0) > Date.now(),
      friend: user ? await friendStatus(user.key, key) : "none" });
  }

  if (method === "POST" && path === "/follow") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "f", 120);
    const target = String(body.username ?? "").toLowerCase();
    if (!KEY_RE.test(target)) throw new Fail(404, "We couldn't find that person.");
    if (target === user.key) throw new Fail(400, "You can't follow yourself.");
    if (!(await st("users").get(target))) throw new Fail(404, "We couldn't find that person.");
    if (body.follow === true) {
      await st("follows").set(`${user.key}~${target}`, "1"); await st("followers").set(`${target}~${user.key}`, "1");
      await notifyOnce(`follow~${user.key}~${target}`, target, { type: "follow", from: user.username, displayName: user.displayName }, "all");
    }
    else { await st("follows").delete(`${user.key}~${target}`); await st("followers").delete(`${target}~${user.key}`); }
    return send({ following: body.follow === true, followers: await count("followers", `${target}~`) });
  }

  if (method === "GET" && path === "/weather") {
    const zip = String(url.searchParams.get("zip") || "");
    if (!/^\d{5}$/.test(zip)) throw new Fail(400, "Enter a 5-digit US zip code.");
    let w;
    try {
      const z = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: AbortSignal.timeout(8000) });
      if (z.status === 404) throw new Fail(404, "We couldn't find that zip code.");
      const p = (await z.json()).places[0];
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("weather");
      w = { p, d: await r.json() };
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw new Fail(502, "The weather service is unavailable. Try again soon.");
    }
    const { p, d } = w;
    let alerts = [], alertsOk = true;
    try {
      const ar = await fetch(`https://api.weather.gov/alerts/active?point=${Number(p.latitude).toFixed(4)},${Number(p.longitude).toFixed(4)}`,
        { headers: { "user-agent": "WCBlog (weather co blog)", accept: "application/geo+json" }, signal: AbortSignal.timeout(6000) });
      if (!ar.ok) throw new Error("alerts");
      const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
      alerts = ((await ar.json()).features || []).map((f) => f.properties || {}).map((x) => ({ event: String(x.event || "Weather alert"),
        severity: String(x.severity || "Unknown"), headline: String(x.headline || "").slice(0, 200), ends: x.ends || x.expires || null }))
        .sort((x, y) => (rank[x.severity] ?? 4) - (rank[y.severity] ?? 4)).slice(0, 5);
    } catch { alertsOk = false; }
    return send({
      alerts, alertsOk,
      place: `${p["place name"]}, ${p["state abbreviation"]}`,
      temp: Math.round(d.current.temperature_2m), feels: Math.round(d.current.apparent_temperature),
      wind: Math.round(d.current.wind_speed_10m), code: d.current.weather_code,
      high: Math.round(d.daily.temperature_2m_max[0]), low: Math.round(d.daily.temperature_2m_min[0]),
      rain: d.daily.precipitation_probability_max[0] ?? 0,
    });
  }

  if (method === "POST" && path === "/maintenance") {
    if (!isDev) throw new Fail(403, "Only the developer can do that.");
    const on = body.on === true;
    await st("config").set("maintenance", on ? "on" : "off");
    return send({ maintenance: on });
  }

  if (path.startsWith("/admin/")) {
    // Restoring a backup also works with the developer code alone, for the day the accounts themselves are gone and nobody can log in.
    const restoreAuth = method === "POST" && path === "/admin/restore" && !isDev && typeof body.devCode === "string" && !!process.env.DEV_CODE && same(body.devCode, process.env.DEV_CODE);
    if (!isDev && !restoreAuth) {
      if (path === "/admin/restore" && typeof body.devCode === "string") { // only wrong guesses count against the limits
        await hitLimit("recover-ip", ip, 5, 15 * 60e3);
        await hitLimit("recover-all", "all", 20, 60 * 60e3);
      }
      throw new Fail(403, "Only the developer can do that.");
    }
    if (method === "GET" && path === "/admin/overview") {
      const [ub, pb, lb, cb, rb, wb, mb, sb] = await Promise.all([st("users").list(), st("posts").list(), st("likes").list({ prefix: "p~" }), st("comments").list(), st("reports").list({ prefix: "r~" }), st("wallets").list(), st("listings").list(), st("sales").list()]);
      const circulation = (await Promise.all(wb.blobs.slice(0, 300).map((b) => st("wallets").get(b.key, { type: "json" })))).reduce((n, w) => n + (w?.balance || 0), 0);
      const recs = (await Promise.all(ub.blobs.slice(0, 300).map((b) => st("users").get(b.key, { type: "json" })))).filter(Boolean);
      const users = recs.map((r) => ({ username: r.username, displayName: r.displayName, createdAt: r.createdAt,
        under13: ageOf(r.birthdate) < 13, suspended: !!r.suspended, early: r.createdAt < EARLY, premium: (r.premiumUntil || 0) > Date.now(), halloween: !!r.halloweenClaimed })).sort((a, b) => b.createdAt - a.createdAt);
      return send({ counts: { users: ub.blobs.length, posts: pb.blobs.length, posts13: pb.blobs.filter((b) => b.key.includes("-t-")).length,
        likes: lb.blobs.length, comments: cb.blobs.length, reports: rb.blobs.length, credits: circulation, listings: mb.blobs.length, sales: sb.blobs.length, premium: users.filter((u) => u.premium).length, halloween: users.filter((u) => u.halloween).length, under13: users.filter((u) => u.under13).length, suspended: users.filter((u) => u.suspended).length }, users });
    }
    if (method === "POST" && path === "/admin/suspend") {
      const key = String(body.username ?? "").toLowerCase();
      if (key === DEV) throw new Fail(400, "You can't suspend the developer account.");
      const rec = KEY_RE.test(key) ? await st("users").get(key, { type: "json" }) : null;
      if (!rec) throw new Fail(404, "No such user.");
      rec.suspended = body.suspended === true;
      await st("users").set(key, JSON.stringify(rec));
      return send({ ok: true });
    }
    if (method === "POST" && path === "/admin/prune") { // clears out old security counters and expired login sessions
      const now = Date.now(); let rl = 0, sess = 0;
      for (const b of (await st("ratelimit").list()).blobs) { const r = await st("ratelimit").get(b.key, { type: "json" }); if (!r || now - r.start > 864e5) { await st("ratelimit").delete(b.key); rl += 1; } }
      for (const b of (await st("sessions").list()).blobs) { const x = await st("sessions").get(b.key, { type: "json" }); if (!x || now - x.t > 30 * 864e5) { await st("sessions").delete(b.key); sess += 1; } }
      return send({ ratelimit: rl, sessions: sess });
    }
    if (method === "POST" && path === "/admin/halloween") {
      const on = body.on === true;
      await st("config").set("halloween", on ? "on" : "off");
      return send({ halloween: on });
    }
    if (method === "GET" && path === "/admin/wordfilter") { const f = await getFilter(); return send({ words: f.words, mode: f.mode }); }
    if (method === "POST" && path === "/admin/wordfilter") {
      const mode = body.mode === "flag" ? "flag" : "block";
      const words = [...new Set((Array.isArray(body.words) ? body.words : []).map((w) => plain(w).trim()).filter(Boolean))];
      if (words.length > 500) throw new Fail(400, "That's more than 500 words.");
      if (words.some((w) => !/^[a-z0-9 ]{2,30}$/.test(w))) throw new Fail(400, "Each word or phrase must be 2 to 30 letters or numbers.");
      const data = { words, mode };
      await st("config").set("wordfilter", JSON.stringify(data));
      wfCache = { at: Date.now(), data };
      return send(data);
    }
    if (method === "POST" && path === "/admin/erase") {
      const key = String(body.username ?? "").toLowerCase();
      if (key === DEV) throw new Fail(400, "You can't erase the developer account.");
      if (!KEY_RE.test(key) || !(await eraseUser(key))) throw new Fail(404, "No such user.");
      return send({ ok: true });
    }
    if (method === "GET" && path === "/admin/growth") {
      const days = Math.min(90, Math.max(7, parseInt(url.searchParams.get("days") || "30", 10) || 30)), today = dayKey();
      const labels = Array.from({ length: days }, (_, i) => shiftDay(today, days - 1 - i)), idx = new Map(labels.map((k, i) => [k, i]));
      const series = Object.fromEntries(["signups", "active", "posts", "comments", "messages"].map((k) => [k, new Array(days).fill(0)]));
      const bump = (arr, ts) => { const i = idx.get(dayKey(ts)); if (i !== undefined) arr[i] += 1; };
      const ub = (await st("users").list()).blobs.slice(0, 2000);
      for (const rec of await Promise.all(ub.map((b) => st("users").get(b.key, { type: "json" })))) if (rec) bump(series.signups, rec.createdAt);
      for (const b of (await st("posts").list()).blobs) bump(series.posts, 9e12 - Number(b.key.slice(0, 13)));
      for (const b of (await st("comments").list()).blobs) bump(series.comments, Number(b.key.split("~")[1].slice(0, 13)));
      for (const b of (await st("dms").list()).blobs) bump(series.messages, Number(b.key.split("~")[2].slice(0, 13)));
      for (const b of (await st("active").list()).blobs) { const i = idx.get(b.key.split("~")[0]); if (i !== undefined) series.active[i] += 1; }
      return send({ labels, series, members: ub.length });
    }
    if (method === "GET" && path === "/admin/backup") {
      const name = url.searchParams.get("store");
      if (!name) return send({ stores: BACKUP_STORES });
      if (!BACKUP_STORES.includes(name)) throw new Fail(400, "Unknown store.");
      const after = url.searchParams.get("after") || "";
      const keys = (await st(name).list()).blobs.map((b) => b.key).sort().filter((k) => k > after);
      const entries = []; let size = 0, next = null;
      for (const k of keys) {
        if (entries.length >= 300) { next = entries[entries.length - 1].k; break; }
        let v, e;
        if (name === "videos") { const buf = await st(name).get(k, { type: "arrayBuffer" }); if (!buf) continue; v = Buffer.from(buf).toString("base64"); e = { k, v, t: "b" }; }
        else { v = await st(name).get(k); if (v === null) continue; e = { k, v }; }
        if (entries.length && size + v.length > 4500000) { next = entries[entries.length - 1].k; break; }
        entries.push(e); size += v.length;
      }
      return send({ store: name, entries, next, total: keys.length });
    }
    if (method === "POST" && path === "/admin/restore") {
      const name = String(body.store ?? "");
      if (!BACKUP_STORES.includes(name)) throw new Fail(400, "Unknown store.");
      if (!Array.isArray(body.entries) || body.entries.length > 500) throw new Fail(400, "Send 500 entries or fewer at a time.");
      let written = 0, skipped = 0, bad = 0;
      for (const e of body.entries) {
        const k = String(e?.k ?? ""), v = e?.v;
        if (!/^[\w~.\-]{1,300}$/.test(k) || typeof v !== "string" || (name === "config" && k === "maintenance")) { bad += 1; continue; }
        let val = v;
        if (JSON_STORES.has(name) && !(v === "1" && (name === "notifs" || name === "reports"))) { // "1" values are de-duplication markers
          let o; try { o = JSON.parse(v); } catch { bad += 1; continue; }
          if (!o || typeof o !== "object" || (name === "users" && (typeof o.username !== "string" || typeof o.pass !== "string")) || (name === "wallets" && !(Number.isInteger(o.balance) && o.balance >= 0))) { bad += 1; continue; }
        } else if (IMAGE_STORES.has(name)) { if (v.length > 1000000 || !IMG_RE.test(v)) { bad += 1; continue; } }
        else if (name === "videos") { const buf = Buffer.from(v, "base64"); if (e.t !== "b" || buf.length > VIDEO_MAX || buf.length < 12) { bad += 1; continue; } val = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
        const r = await st(name).set(k, val, body.overwrite === true ? undefined : { onlyIfNew: true });
        if (r?.modified === false) skipped += 1; else written += 1;
      }
      return send({ written, skipped, bad });
    }
    if (method === "POST" && path === "/admin/messaging") {
      const on = body.on === true;
      await st("config").set("messaging", on ? "on" : "off");
      return send({ messaging: on });
    }
    if (method === "POST" && path === "/admin/dm-delete") {
      if (!CONV_RE.test(String(body.conv ?? "")) || !MSG_ID_RE.test(String(body.id ?? ""))) throw new Fail(400, "Bad request.");
      await st("dms").delete(`${body.conv}~${body.id}`);
      return send({ ok: true });
    }
    if (method === "POST" && path === "/admin/videos") {
      const on = body.on === true;
      await st("config").set("videos", on ? "on" : "off");
      return send({ videos: on });
    }
    if (method === "POST" && path === "/admin/premium") {
      const key = String(body.username ?? "").toLowerCase(), days = body.days;
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new Fail(400, "Days must be a whole number from 0 (remove) to 365.");
      if (!KEY_RE.test(key) || !(await st("users").get(key))) throw new Fail(404, "No such user.");
      const w = await updateWallet(key, (w) => { w.premiumUntil = days === 0 ? 0 : Math.max(w.premiumUntil || 0, Date.now()) + days * DAY_MS; if (days === 0) w.autoRenew = false; });
      await mirrorPremium(key, w.premiumUntil);
      return send({ until: w.premiumUntil });
    }
    if (method === "POST" && path === "/admin/update") {
      if (body.clear === true) { await st("config").delete("update"); return send({ update: null }); }
      const title = String(body.title ?? "").trim(), notes = Array.isArray(body.notes) ? body.notes.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!title || title.length > 60) throw new Fail(400, "Give the update a title (up to 60 characters).");
      if (!notes.length || notes.length > 12 || notes.some((n) => n.length > 140)) throw new Fail(400, "Add 1 to 12 bullet points, each up to 140 characters.");
      const update = { id: String(Date.now()), title, notes, ts: Date.now() };
      await st("config").set("update", JSON.stringify(update));
      return send({ update });
    }
    if (method === "POST" && path === "/admin/market") {
      const on = body.on === true;
      await st("config").set("market", on ? "on" : "off");
      return send({ market: on });
    }
    if (method === "POST" && path === "/admin/credits") {
      const key = String(body.username ?? "").toLowerCase(), amt = body.amount;
      if (!Number.isInteger(amt) || amt === 0 || Math.abs(amt) > 5000) throw new Fail(400, "Amount must be a whole number from -5000 to 5000 (not 0).");
      if (!KEY_RE.test(key) || !(await st("users").get(key))) throw new Fail(404, "No such user.");
      const w = await updateWallet(key, (w) => {
        if (w.balance + amt < 0) throw new Fail(400, "That would take the balance below zero.");
        w.balance += amt; addLog(w, "dev", amt, String(body.note || "Adjustment by the dev").slice(0, 60));
      });
      return send({ balance: w.balance });
    }
    if (method === "GET" && path === "/admin/reports") {
      const keys = (await st("reports").list({ prefix: "r~" })).blobs.map((b) => b.key).sort().slice(0, 50);
      const rows = await Promise.all(keys.map(async (k) => { const v = await st("reports").get(k, { type: "json" }); return v ? { key: k, ...v } : null; }));
      return send({ reports: rows.filter(Boolean) });
    }
    if (method === "POST" && path === "/admin/reports/dismiss") {
      const k = String(body.key ?? "");
      if (!/^r~\d{13}-[a-f0-9]{8}$/.test(k)) throw new Fail(400, "Bad request.");
      await st("reports").delete(k);
      return send({ ok: true });
    }
    if (method === "POST" && path === "/admin/reset-password") {
      const key = String(body.username ?? "").toLowerCase();
      if (key === DEV) throw new Fail(400, "Use Settings (or developer recovery) for your own account.");
      const rec = KEY_RE.test(key) ? await st("users").get(key, { type: "json" }) : null;
      if (!rec) throw new Fail(404, "No such user.");
      const temp = tempPassword();
      rec.pass = await hash(temp);
      rec.validAfter = Date.now(); // signs them out everywhere
      rec.mustChange = true;
      await st("users").set(key, JSON.stringify(rec));
      return send({ tempPassword: temp });
    }
    if (method === "POST" && path === "/admin/site") {
      const s = { msg: String(body.message ?? "").trim().slice(0, 200), until: String(body.until ?? "").trim().slice(0, 60),
        announcement: String(body.announcement ?? "").trim().slice(0, 200) };
      await st("config").set("site", JSON.stringify(s));
      return send({ message: s.msg, until: s.until, announcement: s.announcement });
    }
  }

  throw new Fail(404, "Not found.");
}

export default async (req, context) => {
  try {
    return await route(req, context);
  } catch (e) {
    if (e instanceof Fail) return send({ error: e.message, ...e.extra }, e.status);
    console.error(e);
    return send({ error: "Something went wrong. Try again." }, 500);
  }
};

export const config = { path: "/api/*" };
