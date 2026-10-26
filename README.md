# CalcHack

**SAT math, solved the way the test actually rewards.**

Photograph a question, get the fastest way to solve it in the Desmos graphing calculator — exact keystrokes, a live graph, and an honest verdict when solving it by hand would be quicker.

**Live:** [calchack.net](https://calchack.net)

---

## Why this exists

The digital SAT gives every student a built-in Desmos calculator. Almost nobody is taught to use it well. A question that takes two minutes of algebra often takes fifteen seconds of typing — if you know what to type.

CalcHack is the thing I wanted while studying: not another explanation of *why* the math works, but the fastest route to a correct answer under time pressure.

## What it does

- **Scan** — photograph or upload any SAT math question
- **Walkthrough** — the exact Desmos keystrokes, step by step, with a live interactive graph
- **Honest verdict** — tells you when Desmos is *slower* and you should just do it by hand
- **Answer blur** — hides the answer until you've attempted the problem, so it stays practice rather than a cheat sheet
- **History** — every scan saved, pinnable for review, synced across devices when signed in

Free accounts get 5 scans a day. Pro removes the limit.

## How it's built

A single-page PWA talking to a serverless API. No framework, no build step — the frontend is one HTML file that an older phone on school WiFi can load fast.

```
Browser (PWA)                Cloudflare Worker                 External
─────────────                ─────────────────                 ────────
index.html         ──────▶   /scan      ──────────────────▶    Gemini API
  camera capture                 ├─ enforces daily limits
  Desmos embed                   ├─ holds the prompt
  offline cache                  └─ never trusts the client
                                                               
                   ──────▶   /status, /checkout, /portal ──▶   Stripe
                   ──────▶   /history, /report           
                                 │
                             Workers KV                  ◀──   Supabase Auth
                               usage counters                  (email + Google)
                               entitlements
                               scan history
```

### Design decisions worth explaining

**Entitlements are server-authoritative.** The browser never decides whether someone is Pro. It asks the server, and the server reads an entitlement record that only a verified Stripe webhook can write. Editing localStorage, or the JavaScript itself, gets you nothing.

**The AI prompt lives on the server, not in the client.** It's the actual product. Anything shipped to the browser is public, so it isn't shipped to the browser.

**Stripe webhooks are signature-verified** with HMAC-SHA256 before anything is trusted — otherwise anyone who found the endpoint could grant themselves a subscription with a forged POST.

**Subscription period-end is read defensively.** Stripe moved `current_period_end` from the subscription object onto subscription *items* in its 2025 API versions. The code reads both and falls back to deriving the date from the billing interval, because this bug silently left paying customers on the free tier until I found it.

**Scan limits are counted server-side**, keyed to an account or a device ID held in KV. A page refresh doesn't reset them.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, PWA | No build step; installs to a phone home screen; works offline |
| API | Cloudflare Workers | Runs at the edge, free tier, no server to maintain |
| Storage | Workers KV | Counters and entitlements, nothing relational needed |
| Auth | Supabase | Email + Google OAuth without writing password handling myself |
| Payments | Stripe Checkout + Billing Portal | Card details never touch my systems |
| AI | Gemini | Vision model reads the question from the photo |
| Graphing | Desmos API | The same calculator students get on the real test |
| Hosting | Netlify | Static files, instant deploys |

## Repository layout

```
web/              the PWA — this is the whole frontend
  index.html        app: scan, walkthrough, history, settings, paywall
  example.html      a public worked example, no signup required
  desmos-cheatsheet.html
  privacy.html      GDPR/CCPA-shaped privacy policy
  terms.html        terms including auto-renewal disclosure
  manifest.json     PWA manifest
  sw.js             service worker (offline shell)
  _headers          cache rules

api/
  worker.js         the Cloudflare Worker — API, auth checks, Stripe
                    webhooks, entitlements, usage limits
```

## Running it

The frontend is static — open `web/index.html`, or serve the folder:

```bash
cd web && python3 -m http.server 8000
```

The worker expects these environment bindings (all configured as secrets in Cloudflare, none committed here):

```
GEMINI_API_KEY           SUPABASE_URL             APP_URL
STRIPE_SECRET_KEY        SUPABASE_ANON_KEY        STRIPE_PRICE_MONTHLY
STRIPE_WEBHOOK_SECRET    USAGE (KV namespace)     STRIPE_PRICE_QUARTERLY
                                                  STRIPE_PRICE_ANNUAL
```

## Notes on this repository

The AI prompt in `api/worker.js` is replaced with a placeholder. It's the part of this that took the longest to get right and it's what the product actually sells, so it isn't public.

No open-source license is attached. The code is here to be read, not reused.

---

CalcHack is an independent project. It is not affiliated with, endorsed by, or sponsored by College Board, Desmos, or Google. SAT® is a registered trademark of College Board.
