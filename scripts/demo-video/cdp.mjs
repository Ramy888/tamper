// Minimal headless-Chrome driver over CDP (Node built-in WebSocket). No Claude overlay, no extensions.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900, scale = 1, port = 9344 } = {}) {
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "madarrec-"))}`,
    `--window-size=${width},${height}`, "--hide-scrollbars", "--no-first-run", "--force-color-profile=srgb", "about:blank",
  ], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach((f) => f(m));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });

  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result.value;

  // a visible pointer for the viewer (headless has none); re-added after every page load
  const CURSOR = `(() => { if (document.getElementById('rec-cursor')) return;
    const c = document.createElement('div'); c.id = 'rec-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L17 21l-3 1.4-4-6.6L4 20z" fill="#fff" stroke="#102A43" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position:'fixed', left:'${width / 2}px', top:'${height / 2}px', zIndex: 2147483647, pointerEvents:'none',
      transition:'left .6s cubic-bezier(.4,0,.2,1), top .6s cubic-bezier(.4,0,.2,1), transform .12s', filter:'drop-shadow(0 2px 3px rgba(0,0,0,.35))'});
    document.documentElement.appendChild(c);
    const r = document.createElement('div'); r.id = 'rec-ripple';
    Object.assign(r.style, {position:'fixed', width:'36px', height:'36px', margin:'-18px 0 0 -18px', borderRadius:'50%', border:'3px solid #0F8F7E',
      zIndex: 2147483646, pointerEvents:'none', opacity: 0, transition:'opacity .4s, transform .4s'});
    document.documentElement.appendChild(r);
  })()`;
  let last = { x: width / 2, y: height / 2 };
  let inflight = false;
  let busy = false; // no gap-fill screenshots while a click is in flight
  const ensureCursor = async () => { await evaluate(CURSOR); await evaluate(`(()=>{const c=document.getElementById('rec-cursor');c.style.transition='none';c.style.left='${last.x}px';c.style.top='${last.y}px';c.offsetWidth;c.style.transition='left .6s cubic-bezier(.4,0,.2,1), top .6s cubic-bezier(.4,0,.2,1), transform .12s';})()`); };

  const find = async (text, { exact = false, nth = -1 } = {}) => evaluate(`(() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('flt-semantics, [role], button, a, input, label')].filter((e) => {
      const b = e.getBoundingClientRect(); if (b.width < 2 || b.height < 2) return false;
      const s = ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim();
      return ${exact} ? (e.getAttribute('aria-label') || e.textContent || '').trim() === want : s.includes(want);
    });
    // prefer the smallest matching box (the control itself, not its container)
    els.sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); return A.width * A.height - B.width * B.height; });
    const el = els[0]; if (!el) return null;
    document.querySelectorAll('[data-rec-target]').forEach((e) => e.removeAttribute('data-rec-target'));
    el.setAttribute('data-rec-target', '1');
    const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  })()`);

  const moveTo = async (p) => {
    await ensureCursor();
    await evaluate(`(()=>{const c=document.getElementById('rec-cursor');c.style.left='${p.x - 4}px';c.style.top='${p.y - 2}px';})()`);
    last = { x: p.x - 4, y: p.y - 2 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await sleep(700);
  };
  // app buttons: show the pointer and ripple, then activate the element itself (CDP presses are
  // sometimes dropped by Flutter after a page change; a DOM click on the semantics node never is)
  const activate = async (p) => {
    await moveTo(p);
    await evaluate(`(()=>{const r=document.getElementById('rec-ripple');r.style.transition='none';r.style.left='${p.x}px';r.style.top='${p.y}px';r.style.opacity=1;r.style.transform='scale(.4)';r.offsetWidth;r.style.transition='opacity .5s, transform .5s';r.style.opacity=0;r.style.transform='scale(1.6)';const c=document.getElementById('rec-cursor');c.style.transform='scale(.85)';setTimeout(()=>c.style.transform='',150);})()`);
    await sleep(120);
    await evaluate(`document.querySelector('[data-rec-target]').click()`);
  };
  const clickAt = async (p) => {
    await moveTo(p);
    busy = true;
    while (inflight) await sleep(5); // never press while a screenshot is being taken
    await evaluate(`(()=>{const r=document.getElementById('rec-ripple');r.style.transition='none';r.style.left='${p.x}px';r.style.top='${p.y}px';r.style.opacity=1;r.style.transform='scale(.4)';r.offsetWidth;r.style.transition='opacity .5s, transform .5s';r.style.opacity=0;r.style.transform='scale(1.6)';const c=document.getElementById('rec-cursor');c.style.transform='scale(.85)';setTimeout(()=>c.style.transform='',150);})()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(120);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(150); busy = false;
  };
  // real mouse click first; if the expected result does not show, activate the element directly
  const click = async (text, opts = {}) => {
    let p;
    for (let i = 0; i < 20 && !(p = await find(text, opts)); i++) await sleep(250);
    if (!p) { await shot(new URL("./fail.png", import.meta.url).pathname); throw new Error("not found: " + text); }
    await clickAt(p);
    const done = async () => (opts.expect ? !!(await find(opts.expect)) : opts.gone ? !(await find(text, opts)) : true);
    for (let i = 0; i < 12; i++) { if (await done()) return p; await sleep(200); }
    console.error("fallback DOM click:", text);
    if (await find(text, opts)) await evaluate(`document.querySelector('[data-rec-target]').click()`);
    for (let i = 0; i < 15; i++) { if (await done()) return p; await sleep(200); }
    await shot(new URL("./fail.png", import.meta.url).pathname);
    throw new Error("click had no effect: " + text);
  };

  const wheel = async (dy, at = { x: width * 0.6, y: height * 0.55 }) => {
    const steps = Math.max(1, Math.round(Math.abs(dy) / 60));
    for (let i = 0; i < steps; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: Math.sign(dy) * 60 });
      await sleep(28);
    }
  };
  const type = async (text) => { await send("Input.insertText", { text }); };
  const goto = async (url, wait = 5000) => { await send("Page.navigate", { url }); await sleep(wait); await ensureCursor(); };
  const shot = async (path) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path, Buffer.from(r.result.data, "base64")); };
  const labels = async () => evaluate(`[...document.querySelectorAll('flt-semantics[aria-label], [role=button], button, a')].map(e => { const b = e.getBoundingClientRect(); return b.width > 2 ? Math.round(b.x)+','+Math.round(b.y)+' '+(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,70) : null }).filter(Boolean)`);

  // screencast: frames arrive with timestamps; written to disk for ffmpeg
  // paused time is cut out of the video, so page loads and off-camera setup never show
  const frames = [];
  let recording = false, offset = 0, pausedAt = 0, latest = null;
  listeners.push(async (m) => {
    if (m.method !== "Page.screencastFrame") return;
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
    latest = m.params.data;
    if (recording) frames.push({ t: m.params.metadata.timestamp - offset, data: m.params.data });
  });
  const now = () => Date.now() / 1000;
  // the screencast skips some repaints (e.g. snack bars), so fill any quiet gap with a real screenshot
  let lastFrameAt = 0, polling = false;
  listeners.push((m) => { if (m.method === "Page.screencastFrame") lastFrameAt = now(); });
  const poll = async () => {
    while (polling) {
      // screenshots only: the screencast stream drops overlay layers such as snack bars
      if (recording && !busy) {
        const t = now();
        inflight = true;
        const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
        inflight = false;
        if (recording) frames.push({ t: t - offset, data: r.result.data });
        await sleep(25); // let the page paint between captures
      } else await sleep(15);
    }
  };
  const startRec = async () => {
    recording = true; polling = true; poll();
  };
  const pause = () => { recording = false; pausedAt = now(); };
  const resume = async () => {
    offset += now() - pausedAt; recording = true;
    // a fresh frame right away, so the cut lands on the new screen
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    frames.push({ t: now() - offset, data: r.result.data });
  };
  const elapsed = () => (frames.length ? frames[frames.length - 1].t - frames[0].t : 0);
  const mark = () => (recording ? now() - offset : pausedAt - offset);
  const stopRec = async () => {
    const end = now() - offset; recording = false; polling = false; await sleep(100);
    frames.sort((a, b) => a.t - b.t);
    return { frames, end };
  };

  return { send, evaluate, find, click, clickAt, moveTo, wheel, type, goto, shot, labels, startRec, stopRec, pause, resume, mark, elapsed, ensureCursor,
    close: () => { ws.close(); chrome.kill(); } };
}
