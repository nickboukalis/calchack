# CalcHack

CalcHack is a study tool for SAT math. You take a photo of a question and it shows you how to solve it in the Desmos graphing calculator that comes built into the digital test, including the exact things to type and a live graph you can move around. When working the problem out by hand would actually be faster, it tells you that instead of pushing you toward the calculator anyway.

Live at [calchack.net](https://calchack.net)

## Why I built it

Everybody taking the digital SAT gets a Desmos graphing calculator inside the testing app, and almost nobody is ever taught how to use it properly. A question that takes two minutes of algebra will often take about fifteen seconds of typing if you already know what to type, which means the gap between a student who knows the calculator well and a student who doesn't is much bigger than it looks.

I was studying for the test myself and kept hitting questions where I could tell there was a faster route but had no idea what it was. Most of the explanations I could find were focused on why the math works, which is useful when you are learning a topic for the first time but not very useful when you have about ninety seconds per question and already understand the concept. So I built the thing I actually wanted, which was something that would just show me the quick way.

## What it does

When you scan a question, CalcHack gives you back the fastest method along with a short explanation of why that method is the fastest one for this particular question, then walks you through it step by step. Each step tells you exactly what to type into Desmos and describes what you should see on screen afterward, so you can check that you are still on track before moving on.

It also does a few other things that came out of actually using it:

- The answer can stay blurred until you tap it, so that scanning a question still works as practice instead of turning into a way to skip the work entirely.
- Every scan is saved to your history, and you can pin the ones you found hard so they are easy to come back to. If you are signed in, that history follows you between your phone and your laptop.
- If an answer looks wrong you can report it in a couple of taps, which is how I find out about the questions it gets wrong.
- There is a free tier of five scans a day, and a paid tier that removes the limit.

## How it is built

The whole frontend is one HTML file with the CSS and JavaScript written inline, with no framework and no build step. That was a deliberate choice rather than laziness, because the people using this are on school wifi with whatever phone they happen to own, and a single file that loads immediately beats a nicer codebase that takes four seconds to appear.

Behind it there is a small server running on Cloudflare Workers, which is where anything that actually matters gets decided.

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

### Some decisions worth explaining

**Whether somebody has paid is decided on the server rather than in the app.** The app asks the server about it and the server answers from a record that only a Stripe webhook with a valid signature is allowed to write, so there is nothing on the browser side that could be edited to turn the paid features on. That matters because anybody can open developer tools and change local storage or the JavaScript itself, and a paywall that trusts the client is really just a suggestion.

**The AI prompt is kept on the server instead of being sent to the app.** Anything that reaches a browser can be read by whoever is sitting in front of it, so the prompt stays behind an endpoint that first checks who is asking and how many scans they have already used that day.

**Stripe webhooks are checked with an HMAC-SHA256 signature before anything in them is believed.** Without that step, anyone who worked out the webhook address could post a made up payment event to it and give themselves a subscription for free.

**The date a subscription runs out is read from more than one place on purpose.** Stripe moved `current_period_end` off the subscription object and onto the individual subscription items in their 2025 API versions, so code that only checked the old location would quietly read zero, and the result was that a customer could pay successfully, get a webhook that returned a perfectly healthy 200, and still be sitting on the free tier afterward with no error logged anywhere. The current version looks in both places, and if the field is missing from both it works the date out from the billing interval instead, since being roughly right about a date is a much smaller problem than locking out somebody who has actually paid.

**Scan limits are counted on the server as well**, keyed to the account for anybody signed in and to a device ID for everyone else, so refreshing the page does not quietly hand out another five scans.

## Stack

| Layer | What I used | Why |
|---|---|---|
| Frontend | Vanilla HTML, CSS and JavaScript, as a PWA | No build step, installs to a phone home screen, works offline |
| API | Cloudflare Workers | Runs close to the user, generous free tier, no server for me to maintain |
| Storage | Workers KV | Counters and entitlements, with nothing that needed a relational database |
| Auth | Supabase | Email and Google sign in without writing password handling myself |
| Payments | Stripe Checkout and Billing Portal | Card details never touch anything I control |
| AI | Gemini | Vision model that reads the question off the photo |
| Graphing | Desmos API | The same calculator students get on the real test |
| Hosting | Netlify | Static files with instant deploys |

## What is in this repository

```
web/              the entire frontend
  index.html        the app itself, including scanning, walkthroughs,
                    history, settings and the paywall
  example.html      a worked example anyone can read without signing up
  desmos-cheatsheet.html
  privacy.html      privacy policy
  terms.html        terms of service, including the auto renewal disclosure
  manifest.json     PWA manifest
  sw.js             service worker for the offline shell
  _headers          cache rules for Netlify

api/
  worker.js         the Cloudflare Worker, covering the API, auth checks,
                    Stripe webhooks, entitlements and usage limits
```

## Running it

The frontend is static, so you can open `web/index.html` directly, or serve the folder if you would rather:

```bash
cd web && python3 -m http.server 8000
```

Scanning will not work that way, because it needs the worker and its keys. The worker expects these environment bindings, all of which are configured as secrets inside Cloudflare and none of which are in this repository:

```
GEMINI_API_KEY           SUPABASE_URL             APP_URL
STRIPE_SECRET_KEY        SUPABASE_ANON_KEY        STRIPE_PRICE_MONTHLY
STRIPE_WEBHOOK_SECRET    USAGE (KV namespace)     STRIPE_PRICE_QUARTERLY
                                                  STRIPE_PRICE_ANNUAL
```

## A note on the code here

The AI prompt inside `api/worker.js` has been replaced with a placeholder. It took longer to get right than anything else in the project and it is the part that makes the app actually useful, so it is not published here. Everything else is the real code that runs the live site.

There is no open source license attached to this repository, which means the code is here to read rather than to copy into something else.

## Credits

CalcHack is an independent project built by a high school student. It is not affiliated with, endorsed by or sponsored by College Board, Desmos or Google. SAT is a registered trademark of College Board.
