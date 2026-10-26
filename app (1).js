import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById("app");
const nav = document.getElementById("nav");
let session = null;
let isOwner = false;
let live = null;
let currentRoute = "";

// ---------- small helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function rel(ts) {
  const t = new Date(ts).getTime();
  if (!ts || isNaN(t)) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const time = (ts) => (ts ? `<time data-ts="${esc(ts)}" title="${esc(new Date(ts).toLocaleString())}">${rel(ts)}</time>` : "");
setInterval(() => document.querySelectorAll("time[data-ts]").forEach((el) => (el.textContent = rel(el.dataset.ts))), 30000);

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), isError ? 6000 : 3500);
}

async function must(promise) {
  const { data, error } = await promise;
  if (error) { toast(error.message, true); throw error; }
  return data;
}

// Calls the hub-actions server function.
async function action(name, body = {}) {
  const { data, error } = await sb.functions.invoke("hub-actions", { body: { action: name, ...body } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep */ }
    toast(msg, true);
    throw new Error(msg);
  }
  if (data?.message) toast(data.message);
  return data;
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Working…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const ta = document.createElement("textarea");
    ta.value = s; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

function normalizePhone(raw) {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.length >= 8 && d.length <= 16 ? d : null;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
function normDomain(s) {
  let d = String(s || "").trim().toLowerCase();
  try { if (d.includes("://")) d = new URL(d).hostname; } catch { /* keep */ }
  d = d.split("/")[0].replace(/^@+/, "");
  if (d.includes("@")) d = d.split("@")[1];
  if (d.startsWith("www.")) d = d.slice(4);
  const parts = d.split(".");
  if (parts.length >= 3 && parts.at(-1).length === 2 && ["co", "com", "org", "net"].includes(parts.at(-2))) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path, params: new URLSearchParams(qs || "") };
}
window.addEventListener("hashchange", render);

async function render() {
  if (!session) return renderLogin();
  if (!isOwner) return renderNoAccess();
  nav.hidden = false;
  const { path, params } = route();
  currentRoute = path;
  const section = path.startsWith("/promo") || path === "/" ? "promos" : path.split("/")[1];
  nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.nav === section));
  try {
    if (path === "/") await renderPromos(params.get("view") || "active");
    else if (path.startsWith("/promo/")) await renderPromo(Number(path.split("/")[2]));
    else if (path === "/filtered") await renderFiltered();
    else if (path === "/venues") await renderVenues();
    else if (path === "/settings") await renderSettings();
    else location.hash = "#/";
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
}

// ---------- auth ----------
function renderLogin() {
  nav.hidden = true;
  if (SUPABASE_URL.includes("YOUR-PROJECT")) {
    app.innerHTML = `<div class="card login"><h1>Almost there</h1><p>Open <code>docs/config.js</code> and paste in your Supabase project URL and anon key.</p></div>`;
    return;
  }
  app.innerHTML = `
  <form class="card login" id="login">
    <h1>Promo Hub</h1>
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password<input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
    <button class="btn primary" name="signin">Sign in</button>
    <button class="btn" type="button" id="signup">First time? Create the owner account</button>
    <p class="muted small">The first account created becomes the hub's owner. After that, turn off new sign-ups in Supabase.</p>
  </form>`;
  const form = document.getElementById("login");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[name=signin]");
    busy(btn, true, "Signing in…");
    const { error } = await sb.auth.signInWithPassword({ email: form.email.value, password: form.password.value });
    busy(btn, false);
    if (error) toast(error.message, true);
  });
  document.getElementById("signup").addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const { data, error } = await sb.auth.signUp({
      email: form.email.value, password: form.password.value,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return toast(error.message, true);
    if (!data.session) toast("Check your email to confirm the account, then sign in.");
  });
}

function renderNoAccess() {
  nav.hidden = true;
  app.innerHTML = `<div class="card login"><h1>No access</h1><p>This hub already has an owner, and it isn't ${esc(session.user.email)}.</p><button class="btn" id="out">Sign out</button></div>`;
  document.getElementById("out").onclick = () => sb.auth.signOut();
}

async function onSession(s) {
  session = s;
  isOwner = false;
  if (s) {
    const { data } = await sb.rpc("claim_owner");
    isOwner = !!data;
    if (isOwner) startLive();
  } else stopLive();
  render();
}

// ---------- live updates ----------
function startLive() {
  if (live) return;
  live = sb.channel("promos-live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "promos" }, (payload) => {
      const p = payload.new;
      toast(`New promo: ${p.title}${p.codes?.length ? " — " + p.codes.join(", ") : ""}`);
      if (document.hidden) document.title = "• New promo — Promo Hub";
      if (currentRoute === "/" && !document.querySelector("#search")?.value) render();
    })
    .subscribe();
}
function stopLive() { if (live) { sb.removeChannel(live); live = null; } }
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Promo Hub"; });

// ---------- promos ----------
function promoCard(p) {
  const codes = p.codes?.length
    ? p.codes.map((c) => `<button class="code" data-copy="${esc(c)}" aria-label="Copy code ${esc(c)}">${esc(c)}<span>Copy</span></button>`).join("")
    : `<span class="nocode">No code in this one — open the link for details</span>`;
  const search = [p.title, p.sender_name, p.sender_domain, ...(p.codes || [])].join(" ").toLowerCase();
  return `
  <article class="card ${p.starred ? "starred" : ""}" data-id="${p.id}" data-search="${esc(search)}">
    <div class="meta"><span class="src">${esc(p.sender_name || p.sender_domain)}</span>${time(p.first_seen)}</div>
    <h2><a href="#/promo/${p.id}">${esc(p.title)}</a></h2>
    ${p.when_text ? `<div class="when">${esc(p.when_text)}</div>` : ""}
    <div class="codes">${codes}</div>
    <p class="snippet">${esc(p.snippet)}</p>
    <div class="actions">
      ${p.primary_link ? `<a class="btn primary" href="${safeUrl(p.primary_link)}" target="_blank" rel="noopener noreferrer">Get tickets ↗</a>` : ""}
      <a class="btn" href="#/promo/${p.id}">Details</a>
      <span class="spacer"></span>
      <button class="btn icon star ${p.starred ? "on" : ""}" data-star="${p.id}" title="Star">★</button>
      <button class="btn icon" data-archive="${p.id}" data-to="${p.archived ? 0 : 1}" title="${p.archived ? "Restore" : "Done — move to Archived"}" aria-label="${p.archived ? "Restore" : "Mark done"}">${p.archived ? "↩" : "✓"}</button>
    </div>
    ${p.sightings > 1 ? `<div class="foot">Arrived in ${p.sightings} inboxes — shown once</div>` : ""}
  </article>`;
}

async function renderPromos(view) {
  let q = sb.from("promos").select("id,title,sender_name,sender_domain,codes,snippet,primary_link,when_text,first_seen,sightings,starred,archived")
    .order("first_seen", { ascending: false }).limit(200);
  q = view === "starred" ? q.eq("starred", true) : q.eq("archived", view === "archived");
  const [promos, accounts] = await Promise.all([must(q), must(sb.from("accounts").select("id,enabled,last_checked,last_error"))]);
  const watched = accounts.filter((a) => a.enabled);
  const broken = watched.filter((a) => a.last_error);
  const lastChecked = watched.map((a) => a.last_checked).filter(Boolean).sort().at(-1);
  const tab = (v, label) => `<a href="#/?view=${v}" class="${view === v ? "on" : ""}">${label}</a>`;

  app.innerHTML = `
  <section class="status">
    <div><strong>${watched.length}</strong> ${watched.length === 1 ? "inbox" : "inboxes"} watched
      ${broken.length ? `<a class="bad" href="#/settings">· ${broken.length} with problems</a>` : ""}
      ${lastChecked ? `<span class="muted">· checked ${time(lastChecked)}</span>` : ""}</div>
    <button class="btn small" id="checkNow">Check now</button>
  </section>
  ${accounts.length ? "" : `<div class="empty"><h2>No inboxes connected yet</h2><p>Add the email accounts you signed up to venue newsletters with, and promos will start showing up here.</p><a class="btn primary" href="#/settings">Connect an inbox</a></div>`}
  <div class="toolbar">
    <div class="tabs">${tab("active", "Active")}${tab("starred", "Starred")}${tab("archived", "Archived")}</div>
    <input id="search" type="search" placeholder="Search artist, venue, code…" autocomplete="off">
  </div>
  <div id="feed">${promos.map(promoCard).join("") || (accounts.length ? `<div class="empty"><p>${view === "active" ? "Nothing yet. New promos show up here automatically." : "Nothing here."}</p></div>` : "")}</div>`;

  document.getElementById("search").addEventListener("input", (e) => {
    const v = e.target.value.toLowerCase().trim();
    document.querySelectorAll(".card[data-search]").forEach((c) => (c.style.display = !v || c.dataset.search.includes(v) ? "" : "none"));
  });
  document.getElementById("checkNow").addEventListener("click", async (e) => {
    busy(e.target, true, "Checking…");
    try {
      const r = await action("check_now");
      if (r.skipped) toast("A check is already running — results will appear in a moment.");
      else toast(r.errors?.length ? `Checked, with problems: ${r.errors[0]}` : `Checked ${plural(r.checked, "new email")} · ${plural(r.promos, "new promo")}`, !!r.errors?.length);
      render();
    } finally { busy(e.target, false); }
  });
}

async function renderPromo(id) {
  const [p, seen, notes] = await Promise.all([
    must(sb.from("promos").select("*").eq("id", id).maybeSingle()),
    must(sb.from("sightings").select("received_at, accounts(label,email)").eq("promo_id", id).order("id")),
    must(sb.from("notify_log").select("*").eq("promo_id", id).order("id")),
  ]);
  if (!p) { location.hash = "#/"; return; }
  app.innerHTML = `
  <a class="back" href="#/">← All promos</a>
  <article class="card detail" data-id="${p.id}">
    <div class="meta"><span class="src">${esc(p.sender_name || p.sender_domain)} &lt;${esc(p.sender_email)}&gt;</span>${time(p.first_seen)}</div>
    <h1>${esc(p.title)}</h1>
    ${p.when_text ? `<div class="when">${esc(p.when_text)}</div>` : ""}
    <div class="codes big">${p.codes?.length ? p.codes.map((c) => `<button class="code" data-copy="${esc(c)}">${esc(c)}<span>Copy</span></button>`).join("") : `<span class="nocode">No code found in this email</span>`}</div>
    ${p.links?.length ? `<h3>Links</h3><ul class="links">${p.links.map((l) => `<li><a href="${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.text || l.url.slice(0, 60) + "…")} ↗</a></li>`).join("")}</ul>` : ""}
    <div class="actions">
      ${p.primary_link ? `<a class="btn primary" href="${safeUrl(p.primary_link)}" target="_blank" rel="noopener noreferrer">Get tickets ↗</a>` : ""}
      <button class="btn star ${p.starred ? "on" : ""}" data-star="${p.id}">★ Star</button>
      <button class="btn" id="resend">Re-send alert</button>
    </div>
    <h3>Full email</h3>
    <pre class="body">${esc(p.body_text)}</pre>
    <h3>Received in</h3>
    <ul class="plain">${seen.map((s) => `<li>${esc(s.accounts?.label || "removed inbox")} <span class="muted">${esc(s.accounts?.email || "")} · ${time(s.received_at)}</span></li>`).join("")}</ul>
    ${notes.length ? `<h3>Alerts sent</h3><ul class="plain">${notes.map((n) => `<li>${n.channel === "sms" ? "Text" : "Push"} to ${esc(n.target)} — ${n.ok ? `<span class="good">sent</span>` : `<span class="bad">failed: ${esc(n.error)}</span>`}</li>`).join("")}</ul>` : ""}
    <p class="muted small">Why it counted as a promo: ${esc((p.reasons || []).join(", ") || "added by you")} (score ${p.score ?? "–"})</p>
    <button class="btn danger small" id="del">Delete</button>
  </article>`;
  document.getElementById("resend").onclick = async (e) => { busy(e.target, true, "Sending…"); try { await action("resend", { promo_id: id }); } finally { busy(e.target, false); } render(); };
  document.getElementById("del").onclick = async () => {
    if (!confirm("Delete this promo?")) return;
    await must(sb.from("promos").delete().eq("id", id));
    location.hash = "#/";
  };
}

// ---------- filtered ----------
async function renderFiltered() {
  const rows = await must(sb.from("filtered").select("id,sender_name,sender_email,subject,score,reasons,received_at,accounts(label)").order("id", { ascending: false }).limit(150));
  app.innerHTML = `
  <h1>Filtered out</h1>
  <p class="muted">Emails that came in but didn't look like promos. If one should have counted, tap <b>It's a promo</b> — it moves to your feed and that sender is trusted from now on.</p>
  ${rows.map((r) => `
    <div class="row">
      <div class="grow">
        <div class="meta"><span class="src">${esc(r.sender_name || r.sender_email)}</span>${time(r.received_at)}</div>
        <div class="subject">${esc(r.subject || "(no subject)")}</div>
        <div class="muted small">${esc(r.sender_email)}${r.accounts?.label ? " · " + esc(r.accounts.label) : ""} · score ${r.score}${r.reasons?.length ? " · " + esc(r.reasons.join(", ")) : ""}</div>
      </div>
      <button class="btn small" data-promote="${r.id}">It's a promo</button>
    </div>`).join("") || `<div class="empty"><p>Nothing filtered yet.</p></div>`}`;
}

// ---------- venues ----------
async function renderVenues() {
  const [venues, accounts, signups] = await Promise.all([
    must(sb.from("venues").select("*").order("name")),
    must(sb.from("accounts").select("id,label,email").order("id")),
    must(sb.from("venue_signups").select("*")),
  ]);
  const signed = new Set(signups.map((s) => `${s.venue_id}:${s.account_id}`));
  app.innerHTML = `
  <h1>Venue newsletters</h1>
  <p class="muted">Your checklist of venues to sign up for. Tap each inbox once you've signed it up, so you can see which inboxes are still missing a venue.</p>
  <form class="panel stack" id="addVenue">
    <label>Venue name<input name="name" required placeholder="The Fillmore"></label>
    <label>Newsletter sign-up page<input name="url" placeholder="thefillmore.com/newsletter"></label>
    <label>Notes<input name="notes" placeholder="Optional"></label>
    <label class="check"><input type="checkbox" name="trust" checked> Trust email from this venue's website</label>
    <button class="btn primary">Add venue</button>
  </form>
  ${venues.map((v) => {
    const done = accounts.filter((a) => signed.has(`${v.id}:${a.id}`)).length;
    return `
    <div class="panel venue">
      <div class="row flat">
        <div class="grow"><b>${esc(v.name)}</b>
          ${accounts.length ? `<span class="tag ${done === accounts.length ? "good" : ""}">${done}/${accounts.length} inboxes</span>` : ""}
          ${v.notes ? `<div class="muted small">${esc(v.notes)}</div>` : ""}</div>
        ${v.url ? `<a class="btn small primary" href="${safeUrl(v.url)}" target="_blank" rel="noopener noreferrer">Sign-up page ↗</a>` : ""}
      </div>
      ${accounts.length ? `<div class="chips">${accounts.map((a) => {
        const on = signed.has(`${v.id}:${a.id}`);
        return `<button class="chip toggle ${on ? "on" : ""}" data-signup="${v.id}:${a.id}:${on ? 1 : 0}" title="${esc(a.email)}">${on ? "✓ " : ""}${esc(a.label)}</button>`;
      }).join("")}</div>` : `<p class="muted small">Connect inboxes in Settings to track sign-ups per inbox.</p>`}
      <button class="linkish" data-delvenue="${v.id}" data-name="${esc(v.name)}">Remove venue</button>
    </div>`;
  }).join("") || `<div class="empty"><p>No venues yet. Add the venues near you that sell through Ticketmaster, SeatGeek, AXS and so on.</p></div>`}`;

  document.getElementById("addVenue").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    let url = f.url.value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    await must(sb.from("venues").insert({ name: f.name.value.trim(), url: url || null, notes: f.notes.value.trim() || null }));
    if (f.trust.checked && url) await sb.from("senders").upsert({ domain: normDomain(url), note: `venue: ${f.name.value.trim()}` }, { onConflict: "domain", ignoreDuplicates: true });
    toast("Venue added");
    render();
  });
}

// ---------- settings ----------
async function renderSettings() {
  const [accounts, phones, senders, settingsRows, status] = await Promise.all([
    must(sb.from("accounts").select("*").order("id")),
    must(sb.from("phones").select("*").order("id")),
    must(sb.from("senders").select("*").order("domain")),
    must(sb.from("settings").select("*")),
    action("status").catch(() => ({ twilio: false })),
  ]);
  const s = Object.fromEntries(settingsRows.map((r) => [r.key, r.value ?? ""]));
  const suggestedUrl = location.origin + location.pathname.replace(/index\.html$/, "");

  app.innerHTML = `
  <h1>Settings</h1>

  <section class="panel">
    <h2>Inboxes</h2>
    <p class="muted">Every inbox you signed up to newsletters with. Each one is checked every minute on its own, so if one gets blocked the others keep catching promos. Read-only — nothing gets marked read or deleted.</p>
    ${accounts.map((a) => `
      <div class="row">
        <div class="grow">
          <div><b>${esc(a.label)}</b> <span class="muted">${esc(a.email)}</span> ${a.enabled ? "" : `<span class="tag">paused</span>`}</div>
          <div class="small">
            ${a.last_error ? `<span class="bad">Problem: ${esc(a.last_error)}</span>` : a.last_checked ? `<span class="good">OK</span> · checked ${time(a.last_checked)}` : `<span class="muted">Waiting for the first check…</span>`}
            ${a.last_email_at ? ` · last email ${time(a.last_email_at)}` : ""}
            ${a.last_promo_at ? ` · last promo ${time(a.last_promo_at)}` : ""}
          </div>
        </div>
        <div class="btns">
          <button class="btn small" data-testacc="${a.id}">Test</button>
          <button class="btn small" data-pw="${a.id}">New password</button>
          <button class="btn small" data-toggleacc="${a.id}" data-enabled="${a.enabled ? 1 : 0}">${a.enabled ? "Pause" : "Resume"}</button>
          <button class="btn small danger" data-delacc="${a.id}" data-email="${esc(a.email)}">Remove</button>
        </div>
      </div>`).join("")}
    <details ${accounts.length ? "" : "open"}>
      <summary class="btn">+ Add inbox</summary>
      <form class="stack" id="addAccount">
        <label>Email address<input name="email" type="email" required placeholder="promos.one@gmail.com"></label>
        <label>App password<input name="password" type="password" required placeholder="16-letter Gmail app password" autocomplete="off"></label>
        <label>Nickname (optional)<input name="label" placeholder="Inbox 1"></label>
        <div class="two">
          <label>IMAP server<input name="imap_host" value="imap.gmail.com"></label>
          <label>Port<input name="imap_port" value="993" inputmode="numeric"></label>
        </div>
        <label class="check"><input type="checkbox" name="check_spam" checked> Also check the Spam folder</label>
        <label class="check"><input type="checkbox" name="save_anyway"> Save even if the sign-in test fails</label>
        <button class="btn primary">Connect inbox</button>
        <p class="muted small">Gmail: turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. Your normal Gmail password won't work. The app password is stored where only the server can read it.</p>
      </form>
    </details>
  </section>

  <section class="panel">
    <h2>Text alerts</h2>
    ${status.twilio ? "" : `<p class="flash error">Texting isn't switched on yet — add your Twilio details as Supabase secrets (see the setup guide). Push alerts below work without it.</p>`}
    ${phones.map((ph) => `
      <div class="row">
        <div class="grow"><b>${esc(ph.name || "Phone")}</b> <span class="muted">${esc(ph.number)}</span> ${ph.enabled ? "" : `<span class="tag">off</span>`}</div>
        <div class="btns">
          <button class="btn small" data-testsms="${ph.id}">Send test</button>
          <button class="btn small" data-togglephone="${ph.id}" data-enabled="${ph.enabled ? 1 : 0}">${ph.enabled ? "Turn off" : "Turn on"}</button>
          <button class="btn small danger" data-delphone="${ph.id}">Remove</button>
        </div>
      </div>`).join("")}
    <form class="inline" id="addPhone">
      <input name="name" placeholder="Name">
      <input name="number" type="tel" required placeholder="(555) 123-4567">
      <button class="btn">Add number</button>
    </form>
  </section>

  <form class="panel stack" id="saveSettings">
    <h2>Push alerts &amp; behavior</h2>
    <label>Push topic (free, through the ntfy app)
      <input name="ntfy_topic" value="${esc(s.ntfy_topic)}" placeholder="promohub-${Math.random().toString(36).slice(2, 10)}">
    </label>
    <p class="muted small">Install the ntfy app, subscribe to the same topic name, and every new promo pops up on your phone. Pick a long, hard-to-guess name — anyone who knows it can see the alerts.</p>
    <label>Hub address (so tapping an alert opens the promo here)
      <input name="public_url" value="${esc(s.public_url || suggestedUrl)}">
    </label>
    <label>Detection
      <select name="detection_mode">
        <option value="smart" ${s.detection_mode !== "strict" ? "selected" : ""}>Smart — trusted senders, plus anything that clearly looks like a promo</option>
        <option value="strict" ${s.detection_mode === "strict" ? "selected" : ""}>Strict — only trusted senders</option>
      </select>
    </label>
    <label>Treat the same code as a duplicate for (days)<input name="dedup_days" value="${esc(s.dedup_days || "14")}" inputmode="numeric"></label>
    <div class="actions"><button class="btn primary">Save</button><button class="btn" type="button" id="testPush">Send test push</button></div>
  </form>

  <section class="panel" id="senders">
    <h2>Trusted senders</h2>
    <p class="muted">Email from these domains gets the benefit of the doubt. Venues you add are trusted automatically.</p>
    <form class="inline" id="addSender">
      <input name="domain" required placeholder="thevenue.com">
      <button class="btn">Add</button>
    </form>
    <div class="chips">${senders.map((d) => `<span class="chip" title="${esc(d.note || "")}">${esc(d.domain)} <button data-delsender="${d.id}" aria-label="Remove ${esc(d.domain)}">×</button></span>`).join("")}</div>
  </section>

  <p class="muted small">Signed in as ${esc(session.user.email)} · <a href="#" id="signout">Sign out</a></p>`;

  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  on("addAccount", "submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button.primary");
    busy(btn, true, "Connecting…");
    try {
      await action("add_account", {
        email: f.email.value, password: f.password.value, label: f.label.value, imap_host: f.imap_host.value,
        imap_port: Number(f.imap_port.value), check_spam: f.check_spam.checked, save_anyway: f.save_anyway.checked,
      });
      render();
    } catch { busy(btn, false); }
  });
  on("addPhone", "submit", async (e) => {
    e.preventDefault();
    const num = normalizePhone(e.target.number.value);
    if (!num) return toast("That number doesn't look right. Use 10 digits, or + and the country code.", true);
    await must(sb.from("phones").insert({ name: e.target.name.value.trim() || null, number: num }));
    toast(`Added ${num}`);
    render();
  });
  on("saveSettings", "submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const days = Math.max(1, Math.min(90, parseInt(f.dedup_days.value) || 14));
    await must(sb.from("settings").upsert([
      { key: "ntfy_topic", value: f.ntfy_topic.value.replace(/[^A-Za-z0-9_-]/g, "") },
      { key: "public_url", value: f.public_url.value.trim().replace(/\/+$/, "") },
      { key: "detection_mode", value: f.detection_mode.value },
      { key: "dedup_days", value: String(days) },
    ]));
    toast("Settings saved");
    render();
  });
  on("testPush", "click", async (e) => { busy(e.target, true, "Sending…"); try { await action("test_push"); } finally { busy(e.target, false); } });
  on("addSender", "submit", async (e) => {
    e.preventDefault();
    const domain = normDomain(e.target.domain.value);
    if (!domain.includes(".")) return toast("Enter a domain like thevenue.com", true);
    await must(sb.from("senders").upsert({ domain, note: "added by you" }, { onConflict: "domain", ignoreDuplicates: true }));
    toast(`Trusting ${domain}`);
    render();
  });
  on("signout", "click", (e) => { e.preventDefault(); sb.auth.signOut(); });
}

// ---------- shared click handling ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;

  if (d.copy) {
    e.preventDefault();
    const ok = await copyText(d.copy);
    const span = t.querySelector("span");
    t.classList.add("copied");
    if (span) { span.textContent = ok ? "Copied!" : "Hold to copy"; setTimeout(() => { span.textContent = "Copy"; t.classList.remove("copied"); }, 1500); }
    return;
  }
  if (d.star) {
    const card = t.closest("[data-id]");
    const starred = !t.classList.contains("on");
    await must(sb.from("promos").update({ starred }).eq("id", Number(d.star)));
    t.classList.toggle("on", starred);
    card?.classList.toggle("starred", starred);
    return;
  }
  if (d.archive) {
    const card = t.closest("[data-id]");
    await must(sb.from("promos").update({ archived: d.to === "1" }).eq("id", Number(d.archive)));
    card.style.opacity = "0";
    setTimeout(() => card.remove(), 200);
    return;
  }
  if (d.promote) {
    busy(t, true, "Adding…");
    try { const r = await action("promote", { filtered_id: Number(d.promote) }); location.hash = `#/promo/${r.promo_id}`; }
    catch { busy(t, false); }
    return;
  }
  if (d.signup) {
    const [venue_id, account_id, isOn] = d.signup.split(":").map(Number);
    if (isOn) await must(sb.from("venue_signups").delete().eq("venue_id", venue_id).eq("account_id", account_id));
    else await must(sb.from("venue_signups").insert({ venue_id, account_id }));
    return render();
  }
  if (d.delvenue) {
    if (!confirm(`Remove ${d.name}?`)) return;
    await must(sb.from("venues").delete().eq("id", Number(d.delvenue)));
    return render();
  }
  if (d.testacc) { busy(t, true, "Testing…"); try { await action("test_account", { account_id: Number(d.testacc) }); } finally { busy(t, false); } return; }
  if (d.pw) {
    const pw = prompt("New app password for this inbox:");
    if (!pw) return;
    busy(t, true, "Saving…");
    try { await action("update_password", { account_id: Number(d.pw), password: pw }); render(); } catch { busy(t, false); }
    return;
  }
  if (d.toggleacc) { await must(sb.from("accounts").update({ enabled: d.enabled !== "1" }).eq("id", Number(d.toggleacc))); return render(); }
  if (d.delacc) {
    if (!confirm(`Remove ${d.email}? Its promos stay in your feed.`)) return;
    await must(sb.from("accounts").delete().eq("id", Number(d.delacc)));
    toast("Inbox removed");
    return render();
  }
  if (d.testsms) { busy(t, true, "Sending…"); try { await action("test_sms", { phone_id: Number(d.testsms) }); } finally { busy(t, false); } return; }
  if (d.togglephone) { await must(sb.from("phones").update({ enabled: d.enabled !== "1" }).eq("id", Number(d.togglephone))); return render(); }
  if (d.delphone) { await must(sb.from("phones").delete().eq("id", Number(d.delphone))); return render(); }
  if (d.delsender) { await must(sb.from("senders").delete().eq("id", Number(d.delsender))); return render(); }
});

// ---------- start ----------
sb.auth.onAuthStateChange((event, s) => {
  // The first session is handled below; skip token refreshes for the same user.
  if (event === "INITIAL_SESSION") return;
  if ((s?.user?.id ?? null) !== (session?.user?.id ?? null)) setTimeout(() => onSession(s), 0);
});
const { data: { session: initial } } = await sb.auth.getSession();
await onSession(initial);
