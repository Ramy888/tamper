# Tamper

**Find the money-losing mistakes in your own PayPal checkout before they ship.**

Tamper audits a PayPal integration running in the **sandbox**. A team of cooperating agents
exercises the checkout, and every finding is proven against PayPal's own order, capture and
webhook records. Then a fix is proposed, a human approves it, and the same check runs again
to prove the fix holds.

Tamper moves no money of its own. It only reads PayPal's records and drives sandbox orders on
a demo shop that you own.

**Live demo:** https://tamper-demo.onrender.com (PayPal sandbox only). Each audit creates sandbox orders,
so visitors get 5 runs an hour each and 30 an hour in total. Judges get a demo code (in the
submission's testing instructions): opening the page with it lifts this limit and ticks Live AI,
which runs on the real model within a judges' budget of 4 live runs per judge and 12 in total per
hour (then the no-spend model, and the page says so). A fix
nobody approves within 5 minutes is rejected, so an idle tab can't hold the single audit slot.

## The agents

| Agent | Job | Uses AI? |
|---|---|---|
| 🔎 Recon | Reads the shop's source and maps where it decides an order is paid | Claude |
| 🧪 Auditors | Run each check against the shop, the way a careless client would | No |
| ⚖️ Judge | Confirms a finding **only** if PayPal's own record shows it | **No AI, deterministic** |
| 🔧 Patcher | Names the one safety change that fixes the finding | Claude |
| 👤 You | Approve or reject each fix | — |
| ✅ Verifier | Rebuilds the shop with **only** that change and re-runs the same check | No |

The Patcher's answer is causal. The Verifier flips exactly the switch the Patcher named, so a
wrong answer leaves the shop failing the check, and the scorecard says so. There is a test for
this (`test/engine.test.mjs`).

## What it checks

| Check | The mistake | PayPal's proof |
|---|---|---|
| Amount mismatch | Ships on a price the browser reported, not what PayPal captured | `GET /v2/payments/captures/{id}` |
| Browser-trusted "paid" | Marks an order paid without asking PayPal | `GET /v2/checkout/orders/{id}` |
| Unverified webhook | Credits a "payment completed" event without checking it came from PayPal | `POST /v1/notifications/verify-webhook-signature` |
| Webhook replay | Credits the same capture twice when an event is delivered again | capture amount vs. credited amount |
| Agent price | An AI shopping assistant's tool call sets the price; the shop charges it instead of the catalog price | `GET /v2/payments/captures/{id}`: captured less than the catalog price of what shipped |
| Agent retry | An assistant retries checkout and the shop opens a second PayPal order for the same cart | `GET /v2/checkout/orders/{id}`: two completed orders for one cart |

The last two drive the shop the way an AI shopping assistant would, through agent tools shaped like
WebMCP tools (`search_products`, `add_to_cart`, `start_checkout`, `fulfill_cart`, each with a name,
description, input schema and `execute`). The Auditors call these tools directly; the shop does not
register them with a browser's WebMCP API. The retry fix has two parts. The cart id goes to PayPal
as `PayPal-Request-Id`, and PayPal returns the same order for a repeated key. PayPal's key alone
isn't enough, though: in the sandbox, two calls with the same key at the same moment created two
orders in 3 of 5 tries. So the shop also runs one checkout per cart at a time, and a call that
arrives mid-checkout waits for the first.

The replay check shows that verifying signatures is not enough. PayPal's genuine event is still
genuine the second time, so only de-duplicating on the capture id stops a double credit.

When Tamper is hosted and PayPal's webhook points at it, the replay check waits for PayPal's own
signed `PAYMENT.CAPTURE.COMPLETED` delivery, has the Judge confirm it is genuine, and replays that
exact event. Run locally, it replays a synthetic stand-in instead, and the proof is labelled
**"synthetic stand-in, not PayPal-signed"**. The report never claims more than it did.

## Built with

- **PayPal (sandbox only, a dedicated REST app):**
  - Orders v2: create, capture with a sandbox card, show order;
  - `PayPal-Request-Id` idempotency on order creation;
  - Payments v2: show capture;
  - Webhooks: `verify-webhook-signature`, webhook lookup, and an endpoint that receives PayPal's real
    `PAYMENT.CAPTURE.COMPLETED` deliveries.
- **AI:** Claude (Sonnet, Anthropic SDK) runs the Recon and Patcher agents. The Judge and the Verifier
  are plain code, and the AI's answer is tested, not trusted.
- **Render** (sponsor tool): hosts the live demo as a web service that redeploys on every push to
  `main`, with the PayPal webhook pointed at it.
- Node 22 with no framework, server-sent events for the live dashboard, and `node:test`.

## Run it

Needs Node 22 or newer and a **dedicated** PayPal sandbox REST app (keep its webhook feed apart from
other projects).

```sh
npm install
cp .env.example .env      # fill in the sandbox client id/secret and webhook id
npm test                  # unit tests: PayPal and the model faked, no network, no spend
npm run spike             # three findings proven against the live sandbox
node --env-file=.env scripts/audit.mjs   # full five-agent audit against the live sandbox
npm run dev               # dashboard at http://localhost:3400
```

The dashboard streams a live per-agent log, shows each finding with its PayPal proof IDs, and
waits for your Approve or Reject on every fix.

**Model spend is opt-in.** By default the Recon and Patcher agents run on a built-in no-spend
model, so the whole audit (including every PayPal proof) works without an Anthropic key. Live
AI runs only for the owner. On the dashboard, ticking **Live AI** asks for `TAMPER_PASSCODE`; a
right passcode starts a 12-hour session in that browser (an HttpOnly cookie, so the passcode never
goes in a URL), and each visitor gets 5 tries per 15 minutes. Scripts can send the passcode with
the request instead (`?key=` or the `X-Tamper-Key` header). Judges' live runs come from their demo
code and its hourly budget (above). Anyone else's run falls back to the no-spend model and the
dashboard says so, so the public page alone can't spend the key.

## Layout

```
lib/paypal.mjs    PayPal REST client (token, orders, captures, webhook verification)
lib/judge.mjs     the Judge: reads PayPal's records, no AI
lib/checks.mjs    the six checks
lib/engine.mjs    Recon → Auditors → Judge → Patcher → (you) → Verifier
lib/inbox.mjs     PayPal's webhook deliveries, for the replay check
shop/shop.mjs     the demo shop and its agent tools, one implementation with five safety switches
server.mjs        dashboard server (SSE), approval gate, /api/paypal/webhook
public/index.html the dashboard
```
