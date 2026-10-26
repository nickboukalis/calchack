// CalcHack API v10 — AI proxy + prompt vault + accounts + real Stripe payments.
//
// Everything that decides what someone may do lives here: your Gemini key,
// your prompt, the free-scan counter, and who has paid. A phone can claim
// anything it likes; this is what actually answers.
//
// ---------------------------------------------------------------------------
// SETTINGS (Worker > Settings > Variables and Secrets)
//
//   GEMINI_API_KEY         secret   from aistudio.google.com
//   SUPABASE_URL           variable https://xxxx.supabase.co
//   SUPABASE_ANON_KEY      secret   Supabase > Settings > API > anon public
//   STRIPE_SECRET_KEY      secret   sk_live_... or rk_live_... (restricted keys work too)
//   STRIPE_WEBHOOK_SECRET  secret   whsec_... from the webhook you create
//   STRIPE_PRICE_MONTHLY   variable price_... for the $6.99/mo price
//   STRIPE_PRICE_QUARTERLY variable price_... for the $14.99/3mo price
//   STRIPE_PRICE_ANNUAL    variable price_... for the $39.99/yr price
//   APP_URL                variable https://calchack.net
//   SUPABASE_SERVICE_KEY   secret   OPTIONAL - lets account deletion remove the login too
//   ADMIN_TOKEN            secret   OPTIONAL - any random string; lets you read /reports
//
// KV binding: USAGE  (you already have this)
// ---------------------------------------------------------------------------

const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash",
]);

const FREE_DAILY = 5;
const IP_DAILY = 200;
const MARKER = "CalcHack";
const MAX_BYTES = 6000000;
const MAX_PER_MIN = 12;
const HISTORY_MAX = 60;          // scans kept in the cloud per account
const HISTORY_BYTES = 900000;    // and a hard ceiling on the payload
const PRO_PER_MIN = 40;
const hits = new Map();

// ---------------------------------------------------------------------------
// THE PROMPT — the actual product. Never leaves this server.
//
// The live prompt is withheld from this repository. It instructs the model to
// read an SAT question from a photo, decide whether Desmos or hand algebra is
// faster, and return a strict JSON walkthrough with per-step Desmos LaTeX, a
// viewport, the answer, and the common trap. Everything else in this stack is
// reproducible; this part isn't public.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `[Redacted — the system prompt is the product.]`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-goog-api-key, x-ch-device",
  "Access-Control-Expose-Headers": "x-ch-used, x-ch-limit, x-ch-pro",
  "Access-Control-Max-Age": "600",
};

const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { ...CORS, "content-type": "application/json" },
});
const fail = (message, status, extra) => json({ error: { code: status, message }, ...(extra || {}) }, status);
const today = () => new Date().toISOString().slice(0, 10);
const cleanId = (v) => (v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

function throttled(ip, pro) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => t > now - 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > (pro ? PRO_PER_MIN : MAX_PER_MIN);
}

// --- who is this? -----------------------------------------------------------
// Validates the Supabase access token the app sends. Cached briefly so a burst
// of scans doesn't mean a round trip to Supabase every single time.
const userCache = new Map();
async function whoIs(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;

  const hit = userCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;

  try {
    const r = await fetch(env.SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.id) return null;
    const user = { id: u.id, email: u.email || "" };
    if (userCache.size > 2000) userCache.clear();
    userCache.set(token, { user, exp: Date.now() + 60000 });
    return user;
  } catch (e) { return null; }
}

// --- aggregate counters -------------------------------------------------
// Plain daily tallies, no per-person tracking beyond the device id that
// already exists for scan limits. This is the difference between launching
// and launching blind.
async function bump(env, name, day) {
  if (!env.USAGE) return;
  const k = "m:" + (day || today()) + ":" + name;
  const n = parseInt((await env.USAGE.get(k)) || "0", 10) || 0;
  await env.USAGE.put(k, String(n + 1), { expirationTtl: 8640000 });   // 100 days
}
// Counts a device once per day per bucket, so "people" doesn't mean "requests".
async function bumpUnique(env, name, id) {
  if (!env.USAGE || !id) return;
  const seen = "seen:" + today() + ":" + name + ":" + id;
  if (await env.USAGE.get(seen)) return;
  await env.USAGE.put(seen, "1", { expirationTtl: 172800 });
  await bump(env, name);
}

// Records the last webhook Stripe sent us. The status page reads this, and it
// is the one place to look when somebody pays and Pro doesn't switch on.
// Best-effort on purpose: bookkeeping must never fail a real webhook.
async function noteHook(env, ok, type, note) {
  if (!env.USAGE) return;
  try {
    const at = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    await env.USAGE.put("hook:last", JSON.stringify({
      ok: !!ok, type: type || "unknown", note: note || "", at,
    }));
    const n = parseInt((await env.USAGE.get("hook:n")) || "0", 10) || 0;
    await env.USAGE.put("hook:n", String(n + 1));
  } catch (e) {}
}

// --- entitlements -----------------------------------------------------------
async function getPro(env, userId) {
  if (!env.USAGE || !userId) return null;
  const raw = await env.USAGE.get("pro:u:" + userId);
  if (!raw) return null;
  let rec; try { rec = JSON.parse(raw); } catch (e) { return null; }
  return rec.until > Date.now() ? rec : null;
}
async function setPro(env, userId, rec) {
  if (!env.USAGE || !userId) return;
  await env.USAGE.put("pro:u:" + userId, JSON.stringify(rec));
}

// --- free-scan counter ------------------------------------------------------
async function countScan(env, key, ip) {
  if (!env.USAGE) return { allowed: true, used: 0, limit: FREE_DAILY };
  const dKey = "u:" + key + ":" + today();
  const used = parseInt((await env.USAGE.get(dKey)) || "0", 10) || 0;
  if (used >= FREE_DAILY) return { allowed: false, used, limit: FREE_DAILY };

  const iKey = "ip:" + ip + ":" + today();
  const ipUsed = parseInt((await env.USAGE.get(iKey)) || "0", 10) || 0;
  if (ipUsed >= IP_DAILY) return { allowed: false, used, limit: FREE_DAILY, network: true };

  await env.USAGE.put(dKey, String(used + 1), { expirationTtl: 172800 });
  await env.USAGE.put(iKey, String(ipUsed + 1), { expirationTtl: 172800 });
  return { allowed: true, used: used + 1, limit: FREE_DAILY };
}

// --- Stripe -----------------------------------------------------------------
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out;
}
async function stripe(env, path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formEncode(params).join("&"),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error");
  return j;
}

const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Proves the webhook really came from Stripe and isn't a replay.
async function stripeSigOk(env, rawBody, header) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map(s => s.trim().split("=")).filter(a => a.length === 2)
  );
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return sameString(await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + rawBody), v1);
}

// When does this subscription's paid-for period run out?
//
// Stripe moved current_period_end OFF the subscription object and onto each
// subscription item in the 2025 API versions. New accounts get the new shape,
// so reading only the old field silently yields 0 — the customer pays, the
// webhook returns 200, and Pro never switches on. Check both, and if Stripe
// moves it again, derive it from the plan interval rather than locking a
// paying customer out.
function subPeriodEnd(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const end = sub.current_period_end || (item && item.current_period_end) || 0;
  if (end) return end * 1000;

  const price = item && (item.price || item.plan);
  const rec = price && (price.recurring || price);
  const unit = rec && rec.interval;
  const count = (rec && rec.interval_count) || 1;
  const start = sub.current_period_start || (item && item.current_period_start)
    || sub.start_date || Math.floor(Date.now() / 1000);
  const days = unit === "year" ? 366 : unit === "week" ? 7 : unit === "day" ? 1 : 32;
  return (start + days * count * 86400) * 1000;
}

// Turns a Stripe subscription into our own "pro until" record.
async function applySubscription(env, sub, userIdHint) {
  const userId = (sub.metadata && sub.metadata.user_id) || userIdHint
    || (env.USAGE ? await env.USAGE.get("cust:" + sub.customer) : null);
  if (!userId) return false;
  const live = ["active", "trialing", "past_due"].indexOf(sub.status) !== -1;
  const periodEnd = subPeriodEnd(sub);
  // A cancelled-but-paid-through subscription keeps working until the date.
  const until = live || sub.cancel_at_period_end ? periodEnd : 0;
  await setPro(env, userId, {
    until, status: sub.status, customer: sub.customer, sub: sub.id,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end, updated: Date.now(),
  });
  if (env.USAGE && sub.customer) await env.USAGE.put("cust:" + sub.customer, userId);
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // ---------- status page ----------
    if (request.method === "GET" && (path === "/" || path === "")) {
      const yes = (v) => v ? "✓" : "MISSING";
      let hook = "none received yet";
      const reports = env.USAGE ? ((await env.USAGE.get("reports:n")) || "0") : "0";
      const hookN = env.USAGE ? ((await env.USAGE.get("hook:n")) || "0") : "0";
      if (env.USAGE) {
        const h = await env.USAGE.get("hook:last");
        if (h) { try { const j = JSON.parse(h);
          hook = (j.ok ? "✓ " : "FAILED - ") + (j.type || "") + " at " + j.at + (j.note ? " (" + j.note + ")" : "");
        } catch (e) { hook = h; } }
      }
      return new Response(
        "CalcHack API v10 is running.\n\n" +
        "Gemini key:      " + yes(env.GEMINI_API_KEY) + "\n" +
        "Prompt:          stored on this server ✓\n" +
        "Scan limits:     " + (env.USAGE ? "enforced here ✓ (" + FREE_DAILY + "/day free)" : "MISSING - bind a KV namespace as USAGE") + "\n" +
        "Accounts:        " + yes(env.SUPABASE_URL && env.SUPABASE_ANON_KEY) + "\n" +
        "Stripe key:      " + yes(env.STRIPE_SECRET_KEY) +
          (env.STRIPE_SECRET_KEY ? (/^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY)) ? " (LIVE)" : " (TEST MODE — not taking real payments)") : "") + "\n" +
        "Stripe webhook:  " + yes(env.STRIPE_WEBHOOK_SECRET) + "\n" +
        "Prices:          monthly " + yes(env.STRIPE_PRICE_MONTHLY) + "  3-month " + yes(env.STRIPE_PRICE_QUARTERLY) + "  annual " + yes(env.STRIPE_PRICE_ANNUAL) + "\n" +
        "Webhooks seen:   " + hookN + "\n" +
        "Last webhook:    " + hook + "\n" +
        "Reports filed:   " + reports + (env.ADMIN_TOKEN ? "  (read them at /reports?t=YOUR_ADMIN_TOKEN)" : "  (set ADMIN_TOKEN to read them)") + "\n" +
        "App URL:         " + (env.APP_URL || "MISSING") + "\n\n" +
        "Put this in the app's API_SERVER:\n" + url.origin + "\n",
        { status: 200, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // ---------- Stripe tells us someone paid ----------
    if (path === "/stripe/webhook" && request.method === "POST") {
      const raw = await request.text();
      if (!(await stripeSigOk(env, raw, request.headers.get("stripe-signature")))) {
        await noteHook(env, false, "unknown", "bad signature - check STRIPE_WEBHOOK_SECRET");
        return fail("Bad signature", 400);
      }

      let evt; try { evt = JSON.parse(raw); } catch (e) {
        await noteHook(env, false, "unknown", "unreadable body");
        return fail("Bad body", 400);
      }
      const o = evt.data && evt.data.object;
      let granted = null;   // true/false once we've tried to switch Pro on
      try {
        if (evt.type === "checkout.session.completed" && o) {
          await bump(env, "paid");
          const userId = o.client_reference_id || (o.metadata && o.metadata.user_id);
          if (userId && o.customer && env.USAGE) await env.USAGE.put("cust:" + o.customer, userId);
          if (o.subscription && env.STRIPE_SECRET_KEY) {
            // fetch the subscription so we store a real period end, not a guess
            const r = await fetch("https://api.stripe.com/v1/subscriptions/" + o.subscription, {
              headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
            });
            granted = r.ok ? await applySubscription(env, await r.json(), userId) : false;
          }
        } else if (evt.type.indexOf("customer.subscription.") === 0 && o) {
          granted = await applySubscription(env, o);
        } else if (evt.type === "invoice.paid" && o && o.subscription && env.STRIPE_SECRET_KEY) {
          const r = await fetch("https://api.stripe.com/v1/subscriptions/" + o.subscription, {
            headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
          });
          granted = r.ok ? await applySubscription(env, await r.json()) : false;
        }
      } catch (e) {
        await noteHook(env, false, evt.type, e.message);
        return fail("Handler error: " + e.message, 500);
      }
      await noteHook(env, true, evt.type,
        granted === true ? "Pro updated"
        : granted === false ? "couldn't match it to an account"
        : "nothing to do");
      return json({ received: true });
    }

    // ---------- who am I / what am I allowed ----------
    if (path === "/status") {
      const user = await whoIs(env, request);
      const device = cleanId(url.searchParams.get("d")) || ("ip-" + cleanId(ip.replace(/[.:]/g, "-")));
      const key = user ? "u:" + user.id : device;
      const pro = user ? await getPro(env, user.id) : null;
      const used = env.USAGE
        ? parseInt((await env.USAGE.get("u:" + key + ":" + today())) || "0", 10) || 0 : 0;
      return json({
        signedIn: !!user,
        email: user ? user.email : null,
        pro: !!pro,
        until: pro ? pro.until : 0,
        cancelAtPeriodEnd: pro ? !!pro.cancelAtPeriodEnd : false,
        used, limit: FREE_DAILY,
        canCheckout: !!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_ANNUAL || env.STRIPE_PRICE_QUARTERLY || env.STRIPE_PRICE_MONTHLY)),
        plans: {
          m: !!env.STRIPE_PRICE_MONTHLY,
          q: !!env.STRIPE_PRICE_QUARTERLY,
          y: !!env.STRIPE_PRICE_ANNUAL,
        },
      });
    }

    // ---------- start a purchase ----------
    if (path === "/checkout" && request.method === "POST") {
      const user = await whoIs(env, request);
      if (!user) return fail("Sign in first.", 401);
      if (!env.STRIPE_SECRET_KEY) return fail("Payments aren't switched on yet.", 503);

      await bump(env, "checkout_started");
      let body = {}; try { body = await request.json(); } catch (e) {}
      const price = body.plan === "m" ? env.STRIPE_PRICE_MONTHLY
                  : body.plan === "q" ? env.STRIPE_PRICE_QUARTERLY
                  : env.STRIPE_PRICE_ANNUAL;
      if (!price) return fail("That plan isn't configured.", 503);

      const app = (env.APP_URL || url.origin).replace(/\/+$/, "");
      const existing = await getPro(env, user.id);
      try {
        const session = await stripe(env, "checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": price,
          "line_items[0][quantity]": 1,
          success_url: app + "/?checkout=success",
          cancel_url: app + "/?checkout=cancel",
          client_reference_id: user.id,
          "metadata[user_id]": user.id,
          "subscription_data[metadata][user_id]": user.id,
          allow_promotion_codes: "true",
          ...(existing && existing.customer
            ? { customer: existing.customer }
            : (user.email ? { customer_email: user.email } : {})),
        });
        return json({ url: session.url });
      } catch (e) {
        return fail("Couldn't start checkout: " + e.message, 502);
      }
    }

    // ---------- manage or cancel an existing subscription ----------
    if (path === "/portal" && request.method === "POST") {
      const user = await whoIs(env, request);
      if (!user) return fail("Sign in first.", 401);
      const rec = await getPro(env, user.id);
      if (!rec || !rec.customer) return fail("No subscription found.", 404);
      const app = (env.APP_URL || url.origin).replace(/\/+$/, "");
      try {
        const s = await stripe(env, "billing_portal/sessions", { customer: rec.customer, return_url: app + "/" });
        return json({ url: s.url });
      } catch (e) {
        return fail("Couldn't open billing: " + e.message, 502);
      }
    }


    // ---------- a student says the answer was wrong ----------
    // Worth more than any feature: it turns users into the test suite. Kept
    // deliberately cheap to send so people actually send them.
    if (path === "/report" && request.method === "POST") {
      if (!env.USAGE) return fail("Reporting isn't available.", 503);
      if (throttled(ip, false)) return fail("Slow down a moment.", 429);
      let b = {}; try { b = await request.json(); } catch (e) {}
      const user = await whoIs(env, request);
      const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const rec = {
        at: new Date().toISOString(),
        kind: String(b.kind || "wrong").slice(0, 24),
        note: String(b.note || "").slice(0, 600),
        question: String(b.question || "").slice(0, 900),
        answer: String(b.answer || "").slice(0, 200),
        topic: String(b.topic || "").slice(0, 60),
        method: String(b.method || "").slice(0, 16),
        email: user ? user.email : "",
      };
      // 180 days is long enough to build an eval set from, short enough to expire.
      await env.USAGE.put("report:" + id, JSON.stringify(rec), { expirationTtl: 15552000 });
      await bump(env, "reports");
      const n = parseInt((await env.USAGE.get("reports:n")) || "0", 10) || 0;
      await env.USAGE.put("reports:n", String(n + 1));
      return json({ ok: true });
    }

    // ---------- read the reports (you only) ----------
    if (path === "/reports" && request.method === "GET") {
      if (!env.ADMIN_TOKEN) return fail("Set an ADMIN_TOKEN variable to use this.", 503);
      if (url.searchParams.get("t") !== env.ADMIN_TOKEN) return fail("Nope.", 403);
      if (!env.USAGE) return fail("No storage bound.", 503);
      const list = await env.USAGE.list({ prefix: "report:", limit: 200 });
      const out = [];
      for (const k of list.keys.slice(-100).reverse()) {
        const v = await env.USAGE.get(k.name);
        if (v) { try { out.push(JSON.parse(v)); } catch (e) {} }
      }
      return new Response(JSON.stringify(out, null, 2), {
        status: 200, headers: { ...CORS, "content-type": "application/json" },
      });
    }

    // ---------- scan history that follows you between devices ----------
    if (path === "/history") {
      const user = await whoIs(env, request);
      if (!user) return fail("Sign in first.", 401);
      if (!env.USAGE) return fail("No storage bound.", 503);
      const hKey = "hist:u:" + user.id;

      if (request.method === "GET") {
        const raw = await env.USAGE.get(hKey);
        let items = [];
        if (raw) { try { items = JSON.parse(raw) || []; } catch (e) { items = []; } }
        return json({ items });
      }
      if (request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > HISTORY_BYTES) return fail("History too large to sync.", 413);
        let items; try { items = JSON.parse(raw).items; } catch (e) { return fail("Bad body", 400); }
        if (!Array.isArray(items)) return fail("Bad body", 400);
        items = items.slice(0, HISTORY_MAX);
        await env.USAGE.put(hKey, JSON.stringify(items));
        return json({ ok: true, count: items.length });
      }
      return fail("Method not allowed", 405);
    }

    // ---------- delete everything we hold about someone ----------
    // The privacy policy promises this, so it has to actually work, including
    // cancelling a live subscription so nobody gets billed for a dead account.
    if (path === "/account/delete" && request.method === "POST") {
      const user = await whoIs(env, request);
      if (!user) return fail("Sign in first.", 401);
      const notes = [];

      const rec = env.USAGE ? await env.USAGE.get("pro:u:" + user.id) : null;
      if (rec && env.STRIPE_SECRET_KEY) {
        let parsed = null; try { parsed = JSON.parse(rec); } catch (e) {}
        if (parsed && parsed.sub) {
          try {
            await fetch("https://api.stripe.com/v1/subscriptions/" + parsed.sub, {
              method: "DELETE",
              headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
            });
            notes.push("subscription cancelled");
          } catch (e) { notes.push("could not cancel subscription"); }
        }
      }

      if (env.USAGE) {
        await env.USAGE.delete("pro:u:" + user.id);
        await env.USAGE.delete("hist:u:" + user.id);
        await env.USAGE.delete("u:u:" + user.id + ":" + today());
      }

      // Removing the login itself needs the service role key. Without it the
      // data is gone but the empty account remains, and we say so honestly.
      let authGone = false;
      if (env.SUPABASE_SERVICE_KEY && env.SUPABASE_URL) {
        try {
          const r = await fetch(env.SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/admin/users/" + user.id, {
            method: "DELETE",
            headers: {
              apikey: env.SUPABASE_SERVICE_KEY,
              Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
            },
          });
          authGone = r.ok;
        } catch (e) {}
      }
      return json({ ok: true, authDeleted: authGone, notes });
    }


    // ---------- the numbers, for you only ----------
    if (path === "/stats" && request.method === "GET") {
      if (!env.ADMIN_TOKEN) return fail("Set an ADMIN_TOKEN variable to use this.", 503);
      if (url.searchParams.get("t") !== env.ADMIN_TOKEN) return fail("Nope.", 403);
      if (!env.USAGE) return fail("No storage bound.", 503);

      const days = Math.min(60, Math.max(1, parseInt(url.searchParams.get("days") || "14", 10) || 14));
      const NAMES = ["people", "scans", "scans_pro", "limit_hit", "limit_hit_people",
                     "checkout_started", "paid", "signups", "paywall_view", "installed",
                     "first_scan", "waitlist", "reports"];
      const rows = [];
      const totals = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const row = { day: d };
        for (const n of NAMES) {
          const v = parseInt((await env.USAGE.get("m:" + d + ":" + n)) || "0", 10) || 0;
          row[n] = v;
          totals[n] = (totals[n] || 0) + v;
        }
        rows.push(row);
      }

      const pad = (v, w) => String(v).padEnd(w);
      const num = (v, w) => String(v).padStart(w);
      let out = "CalcHack — last " + days + " days\n\n";
      out += pad("DAY", 12) + num("people", 8) + num("scans", 8) + num("pro", 6)
           + num("maxed", 7) + num("checkout", 10) + num("paid", 6) + num("wait", 6) + num("reports", 9) + "\n";
      out += "-".repeat(72) + "\n";
      for (const r of rows) {
        out += pad(r.day, 12) + num(r.people, 8) + num(r.scans, 8) + num(r.scans_pro, 6)
             + num(r.limit_hit_people, 7) + num(r.checkout_started, 10) + num(r.paid, 6)
             + num(r.waitlist, 6) + num(r.reports, 9) + "\n";
      }
      out += "-".repeat(72) + "\n";
      out += pad("TOTAL", 12) + num(totals.people, 8) + num(totals.scans, 8) + num(totals.scans_pro, 6)
           + num(totals.limit_hit_people, 7) + num(totals.checkout_started, 10) + num(totals.paid, 6)
           + num(totals.waitlist, 6) + num(totals.reports, 9) + "\n\n";

      const per = totals.people ? (totals.scans / totals.people) : 0;
      const conv = totals.checkout_started ? (totals.paid / totals.checkout_started * 100) : 0;
      const payRate = totals.people ? (totals.paid / totals.people * 100) : 0;
      out += "Scans per person:     " + per.toFixed(1) + "\n";
      out += "Hit the daily limit:  " + totals.limit_hit_people + " people"
           + (totals.people ? "  (" + (totals.limit_hit_people / totals.people * 100).toFixed(0) + "% of everyone)" : "") + "\n";
      out += "Checkout → paid:      " + conv.toFixed(0) + "%\n";
      out += "Visitor → paid:       " + payRate.toFixed(2) + "%\n";
      out += "Signups:              " + totals.signups + "\n";
      out += "Saw the paywall:      " + totals.paywall_view + "\n";
      out += "Installed to home:    " + totals.installed + "\n\n";
      out += "Scans per person above ~1.5 means people came back for a second question,\n";
      out += "which is the number that actually tells you whether this is useful.\n";

      return new Response(out, { status: 200, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
    }

    // ---------- a few events only the app can see ----------
    // Strictly an allowlist of names, counted in aggregate. Nothing about a
    // person is stored, and an unknown name is simply ignored.
    if (path === "/event" && request.method === "POST") {
      const OK = new Set(["signups", "paywall_view", "installed", "first_scan"]);
      let b = {}; try { b = await request.json(); } catch (e) {}
      const name = String(b.name || "");
      if (!OK.has(name)) return json({ ok: false });
      await bump(env, name);
      return json({ ok: true });
    }

    // ---------- "tell me when it's back" ----------
    // A blown daily quota otherwise means everyone who arrived that day leaves
    // forever. This turns the worst day into a mailing list.
    if (path === "/waitlist" && request.method === "POST") {
      if (!env.USAGE) return fail("Not available.", 503);
      if (throttled(ip, false)) return fail("Slow down a moment.", 429);
      let b = {}; try { b = await request.json(); } catch (e) {}
      const email = String(b.email || "").trim().slice(0, 160);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That email doesn't look right.", 400);
      const key = "wait:" + email.toLowerCase().replace(/[^a-z0-9@._-]/g, "");
      if (!(await env.USAGE.get(key))) {
        await env.USAGE.put(key, new Date().toISOString(), { expirationTtl: 15552000 });
        await bump(env, "waitlist");
      }
      return json({ ok: true });
    }

    if (path === "/waitlist" && request.method === "GET") {
      if (!env.ADMIN_TOKEN) return fail("Set an ADMIN_TOKEN variable to use this.", 503);
      if (url.searchParams.get("t") !== env.ADMIN_TOKEN) return fail("Nope.", 403);
      if (!env.USAGE) return fail("No storage bound.", 503);
      const list = await env.USAGE.list({ prefix: "wait:", limit: 1000 });
      const emails = list.keys.map(k => k.name.slice(5));
      return new Response(emails.join("\n") + "\n\n" + emails.length + " total\n",
        { status: 200, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
    }

    // ---------- the scan ----------
    if (request.method !== "POST") return fail("Method not allowed", 405);
    if (!env.GEMINI_API_KEY) return fail("Server is missing its GEMINI_API_KEY secret.", 500);

    const match = path.match(/\/v1beta\/models\/([^:]+):generateContent$/);
    if (!match) return fail("Unknown endpoint.", 404);
    const model = decodeURIComponent(match[1]);
    if (!ALLOWED_MODELS.has(model)) return fail("Model not enabled here.", 400);

    const user = await whoIs(env, request);
    const device = cleanId(url.searchParams.get("d")) || ("ip-" + cleanId(ip.replace(/[.:]/g, "-")));
    const key = user ? "u:" + user.id : device;
    const pro = user ? await getPro(env, user.id) : null;
    const isPro = !!pro;

    if (throttled(ip, isPro)) return fail("Too many requests, slow down a moment.", 429);

    const body = await request.text();
    if (body.length > MAX_BYTES) return fail("That image is too large.", 413);

    let payload;
    try { payload = JSON.parse(body); }
    catch { return fail("Request body was not valid JSON.", 400); }

    const sent = JSON.stringify(payload.system_instruction || payload.systemInstruction || "");
    if (!sent.includes(MARKER)) return fail("This server only answers CalcHack requests.", 403);

    await bump(env, "scans");
    await bumpUnique(env, "people", key);
    if (isPro) await bump(env, "scans_pro");

    let usage = { used: 0, limit: FREE_DAILY };
    if (!isPro) {
      const u = await countScan(env, key, ip);
      usage = { used: u.used, limit: u.limit };
      if (!u.allowed) {
        await bump(env, "limit_hit");
        await bumpUnique(env, "limit_hit_people", key);
        return fail(
          u.network ? "This network has hit today's limit. Try again tomorrow."
                    : "Out of free scans for today.",
          402, { usage, signedIn: !!user }
        );
      }
    }

    delete payload.systemInstruction;
    payload.system_instruction = { parts: [{ text: SYSTEM_PROMPT }] };

    let upstream;
    try {
      upstream = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) + ":generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(payload),
        }
      );
    } catch {
      return fail("Could not reach the AI service. Try again.", 502);
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        ...CORS, "content-type": "application/json",
        "x-ch-used": String(usage.used),
        "x-ch-limit": String(usage.limit),
        "x-ch-pro": isPro ? "1" : "0",
      },
    });
  },
};
