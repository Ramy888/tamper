# Tamper

**Find the money-losing mistakes in your own PayPal checkout before they ship.**

Tamper audits a PayPal integration running in the **sandbox**. A team of cooperating agents
exercises the checkout, and every finding is proven against PayPal's own order, capture and
webhook records. Then a fix is proposed, a human approves it, and the same check runs again
to prove the fix holds.

Tamper moves no money of its own. It only reads PayPal's records and drives sandbox orders on
a demo shop that you own.

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

The replay check shows that verifying signatures is not enough. PayPal's genuine event is still
genuine the second time, so only de-duplicating on the capture id stops a double credit.

When Tamper is hosted and PayPal's webhook points at it, the replay check waits for PayPal's own
signed `PAYMENT.CAPTURE.COMPLETED` delivery, has the Judge confirm it is genuine, and replays that
exact event. Run locally, it replays a synthetic stand-in instead, and the proof is labelled
**"synthetic stand-in, not PayPal-signed"**. The report never claims more than it did.

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
model, so the whole audit (including every PayPal proof) works without an Anthropic key. The
"use live Claude" toggle runs only with the owner's `TAMPER_PASSCODE`, so a public deployment
can't spend the key.

## Layout

```
lib/paypal.mjs    PayPal REST client (token, orders, captures, webhook verification)
lib/judge.mjs     the Judge: reads PayPal's records, no AI
lib/checks.mjs    the four checks
lib/engine.mjs    Recon → Auditors → Judge → Patcher → (you) → Verifier
lib/inbox.mjs     PayPal's webhook deliveries, for the replay check
shop/shop.mjs     the demo shop, one implementation with three safety switches
server.mjs        dashboard server (SSE), approval gate, /api/paypal/webhook
public/index.html the dashboard
```
