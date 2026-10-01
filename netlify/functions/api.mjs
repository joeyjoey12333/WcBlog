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
    restricted: age < 13 || rec.restricted === true, theme: rec.theme || null };
};
const pub = (u) => ({ username: u.username, displayName: u.displayName, forced: u.forced, restricted: u.restricted, theme: u.theme, isDev: u.key === DEV });

const getUser = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await st("sessions").get(token, { type: "json" });
  if (!s || Date.now() - s.t > 30 * 864e5) return null;
  const u = await st("users").get(s.u, { type: "json" });
  if (!u || u.suspended || (u.validAfter && s.t < u.validAfter)) return null;
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

async function route(req, context) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const method = req.method;
  let body = {};
  if (method === "POST") {
    const raw = await req.text();
    if (raw.length > 1500000) throw new Fail(413, "That upload is too large.");
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Fail(400, "Bad request."); }
    if (!body || typeof body !== "object") body = {};
  }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const user = token ? await getUser(token) : null;
  const isDev = !!user && user.key === DEV;
  const [m, siteRaw] = await Promise.all([st("config").get("maintenance"), st("config").get("site", { type: "json" })]);
  const maint = m === "on", site = siteRaw || {};
  if (maint && !isDev && !["/status", "/login", "/me", "/logout"].includes(path))
    throw new Fail(503, "WC Blog is in scheduled maintenance.", { maintenance: true, message: site.msg || "", until: site.until || "" });
  const ip = context?.ip || "unknown";

  if (method === "GET" && path === "/status")
    return send({ maintenance: maint, message: site.msg || "", until: site.until || "", announcement: site.announcement || "" });

  if (method === "POST" && path === "/signup") {
    limit(ip + "s", 10);
    const u = String(body.username ?? "").trim(), dn = String(body.displayName ?? "").trim(), b = String(body.birthdate ?? "");
    const pw = body.password;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new Fail(400, "Username must be 3–20 letters, numbers or underscores.");
    if (dn.length < 1 || dn.length > 30) throw new Fail(400, "Display name must be 1–30 characters.");
    if (typeof pw !== "string" || pw.length < 8 || pw.length > 100) throw new Fail(400, "Password must be 8–100 characters.");
    const bd = /^\d{4}-\d{2}-\d{2}$/.test(b) ? new Date(b + "T00:00:00Z") : null;
    if (!bd || isNaN(bd) || bd.toISOString().slice(0, 10) !== b || bd > new Date() || bd.getUTCFullYear() < 1900)
      throw new Fail(400, "Enter a valid birthdate.");
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
    limit(ip + "l", 10);
    const key = String(body.username ?? "").trim().toLowerCase();
    const rec = KEY_RE.test(key) ? await st("users").get(key, { type: "json" }) : null;
    if (!rec || typeof body.password !== "string" || !(await verify(body.password, rec.pass)))
      throw new Fail(401, "Wrong username or password.");
    if (rec.suspended) throw new Fail(403, "This account has been suspended.");
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

  const restricted = !user || user.restricted; // logged-out viewers and restricted accounts never get 13+ content

  if (method === "POST" && path === "/settings") {
    if (!user) throw new Fail(401, "Log in first.");
    const rec = await st("users").get(user.key, { type: "json" });
    if (body.theme !== undefined) {
      if (!["light", "blue", "dark"].includes(body.theme)) throw new Fail(400, "Unknown theme.");
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
      rec.displayName = dn;
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
    rec.validAfter = Date.now(); // signs out every other device
    await st("users").set(user.key, JSON.stringify(rec));
    return send({ token: await newSession(user.key) });
  }

  if (method === "POST" && path === "/account/logout-all") {
    if (!user) throw new Fail(401, "Log in first.");
    const rec = await st("users").get(user.key, { type: "json" });
    rec.validAfter = Date.now();
    await st("users").set(user.key, JSON.stringify(rec));
    return send({ ok: true });
  }

  if (method === "GET" && path === "/posts") {
    const tab = url.searchParams.get("tab") === "all" ? "all" : "recommended";
    const tag = (url.searchParams.get("tag") || "").trim().toLowerCase();
    const by = (url.searchParams.get("user") || "").trim().toLowerCase();
    const [{ blobs }, likeList, mine, follows] = await Promise.all([
      st("posts").list(),
      st("likes").list({ prefix: "p~" }),
      user ? st("likes").list({ prefix: `u~${user.key}~` }) : { blobs: [] },
      user ? st("follows").list({ prefix: `${user.key}~` }) : { blobs: [] },
    ]);
    // Key format "<reverse-time>-<a|t>-<random>": sorting gives newest first, and "t" marks 13+.
    const keys = blobs.map((b) => b.key).filter((k) => !(restricted && k.includes("-t-"))).sort().slice(0, WINDOW);
    let items = (await Promise.all(keys.map((k) => st("posts").get(k, { type: "json" })))).filter(Boolean);
    if (tag) items = items.filter((p) => p.topic === tag);
    if (by) items = items.filter((p) => p.username.toLowerCase() === by);
    const counts = new Map(), iLike = new Set();
    for (const b of likeList.blobs) {
      const [, pid, liker] = b.key.split("~");
      counts.set(pid, (counts.get(pid) || 0) + 1);
      if (user && liker === user.key) iLike.add(pid);
    }
    const uniq = [...new Set(items.map((p) => p.username.toLowerCase()))];
    const names = new Map(await Promise.all(uniq.map(async (k) => [k, (await st("users").get(k, { type: "json" }))?.displayName])));
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
      const score = 5 * Math.min(tl, 5) + 3 * Math.min(al, 5) + (f ? 6 : 0) + Math.log2(1 + n) + 3 / (1 + (now - p.createdAt) / 36e5 / 24);
      const name = names.get(a) || p.displayName;
      const reason = f ? "From someone you follow" : tl ? `Because you liked #${p.topic} posts` : al ? `Because you liked posts by ${name}` : null;
      return { score, reason, post: { id: p.id, title: p.title, topic: p.topic, body: p.body, rating: p.rating, hasImage: p.hasImage,
        username: p.username, displayName: name, createdAt: p.createdAt, editedAt: p.editedAt || null, likes: n, liked: iLike.has(p.id) } };
    });
    const showRec = tab === "recommended" && !tag && !by;
    if (showRec) out.sort((x, y) => y.score - x.score || (x.post.id < y.post.id ? -1 : 1));
    return send({ posts: out.slice(0, 40).map((o) => ({ ...o.post, reason: showRec ? o.reason : null })) });
  }

  if (method === "POST" && path === "/posts") {
    if (!user) throw new Fail(401, "Log in to post.");
    limit(ip + "p", 20);
    const { t, tp, bo } = cleanPost(body);
    const image = body.image ?? null;
    if (image !== null) checkImage(image);
    const rating = user.restricted ? "all" : body.rating; // restricted accounts can't publish 13+ posts
    const id = postId(String(9e12 - Date.now()).padStart(13, "0"), rating, randomBytes(4).toString("hex"));
    if (image) await st("images").set(id, image);
    await st("posts").set(id, JSON.stringify({ id, title: t, topic: tp, body: bo, rating, hasImage: !!image,
      username: user.username, displayName: user.displayName, createdAt: Date.now() }));
    return send({ id });
  }

  const pm = method === "POST" && path.match(/^\/posts\/([^/]+)\/(edit|delete|like)$/);
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
      if (body.like === true) { await likes.set(pk, "1"); await likes.set(likeKey(user.key, post, id), "1"); }
      else { await likes.delete(pk); await likes.delete(likeKey(user.key, post, id)); }
      return send({ liked: body.like === true, likes: await count("likes", `p~${id}~`) });
    }

    if (act === "delete") {
      if (!mine && !isDev) throw new Fail(403, "You can only delete your own posts.");
      await moveLikes(post, id, null, null);
      await st("images").delete(id);
      await st("posts").delete(id);
      return send({ ok: true });
    }

    if (!mine) throw new Fail(403, "You can only edit your own posts.");
    limit(ip + "e", 30);
    const { t, tp, bo } = cleanPost(body);
    const rating = user.restricted ? "all" : body.rating;
    let image; // undefined = keep the current image
    if (body.image != null) { checkImage(body.image); image = body.image; }
    else if (body.removeImage === true) image = null;
    const [ts, , rand] = id.split("-");
    const newId = postId(ts, rating, rand);
    const data = image === undefined ? (post.hasImage ? await st("images").get(id) : null) : image;
    if (data) await st("images").set(newId, data);
    const next = { ...post, id: newId, title: t, topic: tp, body: bo, rating, hasImage: !!data, editedAt: Date.now() };
    await st("posts").set(newId, JSON.stringify(next));
    if (newId !== id) { await st("posts").delete(id); await st("images").delete(id); }
    else if (!data) await st("images").delete(id);
    if (newId !== id || tp !== post.topic) await moveLikes(post, id, next, newId);
    return send({ id: newId });
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
    if (!rec) throw new Fail(404, "We couldn't find that person.");
    const [followers, following, rel] = await Promise.all([
      count("followers", `${key}~`), count("follows", `${key}~`),
      user ? st("follows").get(`${user.key}~${key}`) : null,
    ]);
    return send({ username: rec.username, displayName: rec.displayName, followers, following, isFollowing: rel !== null && rel !== undefined, isDev: key === DEV });
  }

  if (method === "POST" && path === "/follow") {
    if (!user) throw new Fail(401, "Log in first.");
    limit(ip + "f", 120);
    const target = String(body.username ?? "").toLowerCase();
    if (!KEY_RE.test(target)) throw new Fail(404, "We couldn't find that person.");
    if (target === user.key) throw new Fail(400, "You can't follow yourself.");
    if (!(await st("users").get(target))) throw new Fail(404, "We couldn't find that person.");
    if (body.follow === true) { await st("follows").set(`${user.key}~${target}`, "1"); await st("followers").set(`${target}~${user.key}`, "1"); }
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
    return send({
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
    if (!isDev) throw new Fail(403, "Only the developer can do that.");
    if (method === "GET" && path === "/admin/overview") {
      const [ub, pb, lb] = await Promise.all([st("users").list(), st("posts").list(), st("likes").list({ prefix: "p~" })]);
      const recs = (await Promise.all(ub.blobs.slice(0, 300).map((b) => st("users").get(b.key, { type: "json" })))).filter(Boolean);
      const users = recs.map((r) => ({ username: r.username, displayName: r.displayName, createdAt: r.createdAt,
        under13: ageOf(r.birthdate) < 13, suspended: !!r.suspended })).sort((a, b) => b.createdAt - a.createdAt);
      return send({ counts: { users: ub.blobs.length, posts: pb.blobs.length, posts13: pb.blobs.filter((b) => b.key.includes("-t-")).length,
        likes: lb.blobs.length, under13: users.filter((u) => u.under13).length, suspended: users.filter((u) => u.suspended).length }, users });
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
