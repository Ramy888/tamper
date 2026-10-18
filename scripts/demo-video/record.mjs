// Records the Tamper demo in headless Chrome against a running dashboard (the hosted one, so the
// replay check uses PayPal's own signed webhook). Writes frames, list.txt, cues.json and gallery
// shots to <outDir>. Then, in <outDir>:
//
//   node --env-file=.env scripts/demo-video/record.mjs <baseUrl> <outDir> [live]
//   ffmpeg -f concat -safe 0 -i list.txt -vf "scale=1920:1200,format=yuv420p" -r 30 -c:v libx264 -crf 18 tamper-demo.mp4
//
// The owner passcode (TAMPER_PASSCODE) goes in a request header, only to <baseUrl>, so the demo
// budget never runs out mid-take; it is never put in a URL or on screen. "live" ticks the
// dashboard's live-Claude box (5 model calls); without it the no-spend model runs.
//
// The dashboard's event stream is buffered in the page and released one event at a time, so each
// step stays on screen long enough to read. Order and content are exactly what the server sent;
// time spent waiting for PayPal or the model is cut from the video.
import { launch, sleep } from "./cdp.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [BASE, DIR, MODE] = process.argv.slice(2);
const LIVE = MODE === "live";
const CARD = fileURLToPath(new URL("./card.html", import.meta.url));
if (!BASE || !DIR) throw new Error("usage: record.mjs <baseUrl> <outDir> [live]");
if (!process.env.TAMPER_PASSCODE) throw new Error("TAMPER_PASSCODE missing (run with --env-file)");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR + "/frames", { recursive: true });

// 1200x750 CSS pixels at 1.6x: a 1920x1200 video in which the dashboard fills the frame.
const b = await launch({ width: 1200, height: 750, scale: 1.6, port: 9471 });
await b.send("Network.enable");
// The header is set only while the dashboard is open. The dashboard loads nothing from any other
// host, and the cards are local files with system fonts, so it reaches the dashboard host alone.
const ownerHeader = (on) => b.send("Network.setExtraHTTPHeaders", { headers: on ? { "X-Tamper-Key": process.env.TAMPER_PASSCODE } : {} });

const cues = [];
const caption = async (text) => {
  cues.push({ at: b.mark(), text });
  console.log(b.mark().toFixed(1), text);
  await b.evaluate(`(() => {
    let c = document.getElementById('rec-caption');
    if (!c) { c = document.createElement('div'); c.id = 'rec-caption';
      Object.assign(c.style, { position: 'fixed', left: '50%', bottom: '26px', transform: 'translateX(-50%)', zIndex: 2147483600, maxWidth: '1120px', width: 'max-content',
        background: 'rgba(18,25,35,.96)', color: '#e6edf3', border: '1px solid #3a3217', font: '600 19px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: '12px 24px', borderRadius: '14px', boxShadow: '0 12px 34px rgba(0,0,0,.45)', textAlign: 'center', pointerEvents: 'none', transition: 'opacity .3s' });
      document.documentElement.appendChild(c); }
    c.textContent = ${JSON.stringify(text)}; c.style.opacity = ${text ? 1 : 0};
  })()`);
};
const hover = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`).then((p) => p && b.moveTo(p));
const clickSel = async (sel) => {
  let p;
  for (let i = 0; i < 40; i++) {
    p = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'smooth' }); const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
    if (p) break;
    await sleep(250);
  }
  if (!p) { await b.shot(DIR + "/fail.png"); throw new Error("missing " + sel); }
  await sleep(500); // let the smooth scroll settle before reading the position again
  p = await b.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  // Show the pointer and ripple, then activate the element itself: real presses are sometimes
  // dropped while frames are being captured.
  await b.moveTo(p);
  await b.evaluate(`(() => { const r = document.getElementById('rec-ripple'); if (!r) return; r.style.transition = 'none'; r.style.left = '${p.x}px'; r.style.top = '${p.y}px'; r.style.opacity = 1; r.style.transform = 'scale(.4)'; r.offsetWidth; r.style.transition = 'opacity .5s, transform .5s'; r.style.opacity = 0; r.style.transform = 'scale(1.6)'; })()`);
  await sleep(150);
  await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
};
const shotClean = async (name) => {
  await b.evaluate("['rec-caption','rec-cursor'].forEach((id) => { const e = document.getElementById(id); if (e) e.style.visibility = 'hidden'; })");
  await b.shot(`${DIR}/${name}.png`);
  await b.evaluate("['rec-caption','rec-cursor'].forEach((id) => { const e = document.getElementById(id); if (e) e.style.visibility = ''; })");
};

// Buffers the dashboard's EventSource: events queue in the page and reach the dashboard only on
// window.__release(). The real stream is closed as soon as the run completes (or fails), so the
// browser never reconnects and starts a second audit.
const BUFFER = `(() => {
  const Real = window.EventSource;
  window.__q = [];
  window.EventSource = function (url) {
    const es = new Real(url);
    const fake = { onmessage: null, onerror: null, ls: [], addEventListener(t, f) { if (t === 'message') this.ls.push(f); }, close() { es.close(); } };
    es.onmessage = (m) => {
      window.__q.push({ data: m.data });
      const e = JSON.parse(m.data);
      if (e.agent === 'engine' && (e.phase === 'complete' || e.phase === 'error')) es.close();
    };
    es.onerror = () => { es.close(); window.__q.push({ end: true }); };
    window.__release = () => {
      const m = window.__q.shift();
      if (!m) return null;
      if (m.end) { fake.onerror?.(); return { end: true }; }
      fake.onmessage?.(m); fake.ls.forEach((f) => f(m));
      return JSON.parse(m.data);
    };
    return fake;
  };
})()`;

// The next server event. While nothing is queued (PayPal or the model is working) the recording
// is paused, so waits are cut.
async function nextEvent() {
  let paused = false;
  for (let i = 0; i < 2400; i++) {
    if (await b.evaluate("window.__q.length > 0")) break;
    if (i === 4 && !paused) { b.pause(); paused = true; }
    await sleep(250);
  }
  if (paused) { await sleep(150); await b.resume(); }
  return b.evaluate("window.__release()");
}

// ---------- off camera ----------
const noCursor = () => b.evaluate("document.getElementById('rec-cursor')?.remove()");
await b.goto("file://" + CARD, 1500); await noCursor();
await b.startRec();
await sleep(4500);
b.pause();
await ownerHeader(true);
await b.goto(BASE + "/", 5000);
await b.evaluate(BUFFER);
await b.evaluate("document.querySelector('main').style.paddingBottom = '110px'");
await b.resume();

// ---------- intro ----------
await caption("Tamper audits your own PayPal checkout in the sandbox, before it ships");
await sleep(4200);
await caption("Five agents hand work to each other. The Judge uses no AI, and you approve every fix");
await hover(".chip[data-a=recon]"); await sleep(1400);
await hover(".chip[data-a=judge]"); await sleep(1600);
await hover(".chip[data-a=verifier]"); await sleep(1500);
if (LIVE) {
  await caption("Recon and the Patcher run on Claude");
  await clickSel("#live"); await sleep(2200);
}
await caption("The target: a demo shop with four common checkout mistakes. Waiting time is cut from this video");
await clickSel("#run"); await sleep(1800);

// ---------- the audit, paced one event at a time ----------
const claude = LIVE ? " (Claude)" : "";
const JUDGE = {
  amount_mismatch: "The Judge uses no AI. It reads PayPal's own capture: the shop shipped more than PayPal captured",
  browser_trusted_paid: "Marked paid on the browser's word. PayPal says the order was never captured",
  unverified_webhook: "A 'payment completed' event PayPal never sent was credited. PayPal's signature check: FAILURE",
};
// The replay captions depend on what really ran: PayPal's signed delivery, or the labelled stand-in.
const replayCaption = (signed) => signed ? "Delivered twice, the genuine event is credited twice. Checking signatures alone doesn't stop this" : "Delivered twice, the same event is credited twice (a labelled synthetic stand-in in this run)";
const VERIFIED = [
  "The Verifier rebuilds the shop with only that fix and re-runs the same check: the fix holds",
  "Each fix is proven the same way: against PayPal's records, not the shop's",
  "A wrong fix would fail here: the Verifier flips only the switch the Patcher named",
];
let verifierSigned = false;
let approvals = 0, verified = 0, replayNotes = 0, firstAuditor = true;
for (;;) {
  const e = await nextEvent();
  if (!e || e.end) break;
  const { agent, phase } = e;
  if (agent === "recon" && phase === "done") {
    await caption(`Recon${claude} reads the shop's source and maps where it decides an order is paid`);
    await sleep(6500);
  } else if (agent === "auditor" && phase === "run") {
    if (firstAuditor) { await caption("Auditors drive real sandbox orders, the way a careless client would"); firstAuditor = false; }
    await sleep(2400);
  } else if (phase === "note" && agent === "auditor") {
    // Captions say "signed" only when the note does: a fallback run is labelled for what it is.
    replayNotes++;
    if (replayNotes === 1) await caption("PayPal sends its own signed webhook for this capture");
    else await caption(/confirms it is genuine/.test(e.note) ? "The Judge asks PayPal: is this delivery genuine? Yes. Tamper delivers it again" : "No verified PayPal delivery arrived, so a labelled synthetic stand-in is replayed");
    await sleep(4200);
  } else if (agent === "judge" && phase === "verdict") {
    if (e.check === "webhook_replay") await caption(replayCaption(/PayPal-signed, verified/.test((e.proofIds || []).join(" "))));
    else if (JUDGE[e.check]) await caption(JUDGE[e.check]);
    await sleep(e.check === "amount_mismatch" ? 5600 : 4800);
    if (e.check === "webhook_replay") {
      await caption("Four findings, each with the PayPal order and capture IDs that prove it");
      await hover("#findings .finding:last-child .ids"); await sleep(1600);
      await hover("#findings .finding:first-child .ids"); await sleep(2600);
      await shotClean("gallery-2-findings");
    }
  } else if (agent === "patcher" && phase === "awaiting-approval") {
    approvals++;
    if (approvals === 1) { await caption(`The Patcher${claude} names one fix. Nothing changes until you approve it`); await sleep(4200); }
    else await sleep(2200);
    if (approvals === 1) await shotClean("gallery-3-approve");
    await clickSel(`#f-${e.check} .approve .y`);
    await sleep(1200);
  } else if (agent === "verifier" && phase === "note") {
    if (/^waiting/.test(e.note)) { await caption("The Verifier re-runs the replay check on the fixed shop, with a new PayPal-signed event"); await sleep(3600); }
    else { verifierSigned = /confirms it is genuine/.test(e.note); await sleep(2600); }
  } else if (agent === "verifier" && (phase === "result" || phase === "pending")) {
    const holds = e.check === "webhook_replay" ? (verifierSigned ? "After the dedupe fix, PayPal's signed event is credited once" : "After the dedupe fix, the replayed event is credited once") : VERIFIED[verified];
    await caption(phase === "result" && e.fixHolds ? holds : `Verifier: ${e.reason ?? "fix did not hold"}`);
    verified++;
    await sleep(4200);
  } else if (agent === "engine" && phase === "complete") {
    await sleep(600);
    await b.evaluate("document.getElementById('score').scrollIntoView({ block: 'center', behavior: 'smooth' })");
    await sleep(900);
    const s = e.scorecard;
    await caption(`${s.found} found, ${s.fixesVerified} fixes verified, ${s.stillVulnerableAfterPatch} still vulnerable. Every number traces back to a PayPal sandbox record`);
    await hover("#score"); await sleep(6500);
    await shotClean("gallery-4-scorecard");
    break;
  } else if (agent === "engine" && phase === "error") {
    await b.shot(DIR + "/fail.png");
    throw new Error("audit error: " + e.error);
  }
}

// ---------- end card ----------
b.pause();
await ownerHeader(false);
await b.goto("file://" + CARD + "?end=1", 1500); await noCursor();
await b.resume();
await sleep(5500);

const { frames, end } = await b.stopRec();
b.close();

const FPS = 30, start = frames[0].t, slots = Math.ceil((end - start) * FPS);
const list = []; let j = 0; const written = new Map();
for (let s = 0; s < slots; s++) {
  const t = start + s / FPS;
  while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
  if (!written.has(j)) { const name = `frames/${String(j).padStart(5, "0")}.jpg`; writeFileSync(DIR + "/" + name, Buffer.from(frames[j].data, "base64")); written.set(j, name); }
  list.push(`file '${written.get(j)}'`, `duration ${(1 / FPS).toFixed(6)}`);
}
list.push(list[list.length - 2]);
writeFileSync(DIR + "/list.txt", list.join("\n") + "\n");
writeFileSync(DIR + "/cues.json", JSON.stringify(cues.map((c) => ({ at: Math.max(0, c.at - start), text: c.text })), null, 1));
console.log(`frames ${frames.length}, length ${(end - start).toFixed(1)} s`);
