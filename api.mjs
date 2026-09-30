import { getStore } from "@netlify/blobs";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const DEV = "weathercodevelopment";
// Site-wide stores (getStore, not getDeployStore) so data survives every redeploy.
const st = (name) => getStore({ name, consistency: "strong" });

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
const pub = (u) => ({ username: u.username, displayName: u.displayName, age: u.age, isDev: u.key === DEV });

const getUser = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await st("sessions").get(token, { type: "json" });
  if (!s || Date.now() - s.t > 30 * 864e5) return null;
  const u = await st("users").get(s.u, { type: "json" });
  return u ? { key: s.u, username: u.username, displayName: u.displayName, age: ageOf(u.birthdate) } : null;
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

async function route(req, context) {
  const path = new URL(req.url).pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
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
  const maint = (await st("config").get("maintenance")) === "on";
  if (maint && !isDev && !["/status", "/login", "/me", "/logout"].includes(path))
    throw new Fail(503, "WC Blog is in scheduled maintenance.", { maintenance: true });
  const ip = context?.ip || "unknown";

  if (method === "GET" && path === "/status") return send({ maintenance: maint });

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
    const rec = { username: u, displayName: dn, pass: await hash(pw), birthdate: b, createdAt: Date.now() };
    // Atomic: the write only succeeds if nobody has ever claimed this username.
    const r = await st("users").set(key, JSON.stringify(rec), { onlyIfNew: true });
    if (typeof r?.modified !== "boolean") throw new Error("Blobs conditional writes unavailable; refusing to create account.");
    if (!r.modified) throw new Fail(409, "That username is already taken.");
    const t = await newSession(key);
    return send({ token: t, user: pub({ key, ...rec, age: ageOf(b) }) });
  }

  if (method === "POST" && path === "/login") {
    limit(ip + "l", 10);
    const key = String(body.username ?? "").trim().toLowerCase();
    const rec = /^[a-z0-9_]{3,20}$/.test(key) ? await st("users").get(key, { type: "json" }) : null;
    if (!rec || typeof body.password !== "string" || !(await verify(body.password, rec.pass)))
      throw new Fail(401, "Wrong username or password.");
    if (maint && key !== DEV) throw new Fail(503, "WC Blog is in scheduled maintenance.", { maintenance: true });
    const t = await newSession(key);
    return send({ token: t, user: pub({ key, ...rec, age: ageOf(rec.birthdate) }) });
  }

  if (method === "GET" && path === "/me") {
    if (!user) throw new Fail(401, "Not signed in.");
    return send({ user: pub(user) });
  }

  if (method === "POST" && path === "/logout") {
    if (/^[a-f0-9]{64}$/.test(token)) await st("sessions").delete(token);
    return send({ ok: true });
  }

  const restricted = !user || user.age < 13; // logged-out viewers and under-13s never get 13+ content

  if (method === "GET" && path === "/posts") {
    const { blobs } = await st("posts").list();
    // Key format "<reverse-time>-<a|t>-<random>": sorting gives newest first, and "t" marks 13+.
    const keys = blobs.map((b) => b.key).filter((k) => !(restricted && k.includes("-t-"))).sort().slice(0, 40);
    const items = (await Promise.all(keys.map((k) => st("posts").get(k, { type: "json" })))).filter(Boolean);
    return send({ posts: items });
  }

  if (method === "POST" && path === "/posts") {
    if (!user) throw new Fail(401, "Log in to post.");
    limit(ip + "p", 20);
    const t = String(body.title ?? "").trim(), tp = String(body.topic ?? "").trim().toLowerCase(), bo = String(body.body ?? "").trim();
    const image = body.image ?? null;
    if (!t || t.length > 100) throw new Fail(400, "Title must be 1–100 characters.");
    if (!tp || tp.length > 30) throw new Fail(400, "Topic must be 1–30 characters.");
    if (!bo || bo.length > 5000) throw new Fail(400, "Post text must be 1–5000 characters.");
    if (!["all", "13+"].includes(body.rating)) throw new Fail(400, "Choose a rating.");
    if (image !== null && (typeof image !== "string" || image.length > 900000 || !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)))
      throw new Fail(400, "That image is invalid or too large.");
    const rating = user.age < 13 ? "all" : body.rating; // under-13 authors can't publish 13+ posts
    const id = `${String(9e12 - Date.now()).padStart(13, "0")}-${rating === "13+" ? "t" : "a"}-${randomBytes(4).toString("hex")}`;
    if (image) await st("images").set(id, image);
    await st("posts").set(id, JSON.stringify({ id, title: t, topic: tp, body: bo, rating, hasImage: !!image,
      username: user.username, displayName: user.displayName, createdAt: Date.now() }));
    return send({ id });
  }

  if (method === "GET" && path.startsWith("/image/")) {
    const id = path.slice(7);
    if (!/^\d{13}-[at]-[a-f0-9]{8}$/.test(id) || (restricted && id.includes("-t-"))) throw new Fail(404, "Not found.");
    const image = await st("images").get(id);
    if (image === null) throw new Fail(404, "Not found.");
    return send({ image });
  }

  if (method === "GET" && path === "/weather") {
    const zip = String(new URL(req.url).searchParams.get("zip") || "");
    if (!/^\d{5}$/.test(zip)) throw new Fail(400, "Enter a 5-digit US zip code.");
    let z, w;
    try {
      z = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: AbortSignal.timeout(8000) });
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
