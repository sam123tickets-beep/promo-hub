// Promo Hub — hub-actions (dashboard buttons)
// Single-file version: paste this whole file into the Supabase dashboard function editor.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1";
import PostalMime from "npm:postal-mime@2";

// ===== detector.ts =====
// Decides whether an email is a ticket promo, and pulls out codes, links and dates.
// Pure TypeScript with no dependencies, so it runs fast inside a Supabase Edge Function.

export const DEFAULT_TRUSTED = [
  "ticketmaster.com", "livenation.com", "seatgeek.com", "axs.com", "etix.com",
  "eventbrite.com", "dice.fm", "ticketweb.com", "tixr.com", "seetickets.us",
  "seetickets.com", "frontgatetickets.com", "showclix.com", "prekindle.com",
  "universe.com", "bandsintown.com", "songkick.com", "vividseats.com",
  "stubhub.com", "gametime.co", "ticketsauce.com", "eventim.com", "ticketmaster.ca",
];

const STRONG = [
  /pre-?sales?/i, /promo(?:tional)? code/i, /offer code/i, /access code/i, /discount code/i,
  /coupon code/i, /unlock code/i, /presale password/i, /\bpassword\b/i,
  /\b(?:use|enter|apply|redeem)\s+(?:the\s+)?(?:promo\s+|discount\s+|offer\s+|presale\s+)?code\b/i,
  /early access/i, /exclusive access/i, /fan club/i,
];
const MEDIUM = [
  /\btickets?\b/i, /on sale/i, /\bcode\b/i, /\d{1,2}\s?% off/i, /\bexclusive\b/i,
  /limited time/i, /\bconcert\b/i, /\btour\b/i, /\bshows?\b/i, /\blive\b/i, /\bvenue\b/i,
  /\bbogo\b/i, /no fees?/i, /\$\d+ tickets?/i,
];
const NEGATIVE = [
  /reset your password/i, /password reset/i, /change your password/i, /forgot your password/i,
  /verify your (?:email|account|identity)/i, /confirm your (?:email|subscription|account)/i,
  /verification code/i, /security code/i, /one-?time (?:code|passcode|password)/i,
  /sign-?in code/i, /log-?in code/i, /\b2fa\b/i, /two-factor/i,
  /order (?:confirmation|#|number)/i, /your order/i, /\breceipt\b/i, /payment (?:received|confirmation)/i,
  /your tickets are ready/i, /tickets? (?:have been |were )?transferr?ed/i, /you(?:'ve| have) been unsubscribed/i,
  /refund/i, /invoice/i,
];

const STOP = new Set(`
a an and are as at be below box but by check checkout click code codes coming date dates details
email enter est edt pst pdt cst cdt mst mdt gmt utc et pt ct for free from get here https http info
into is it just link listed live login may more must needed new no not now of off offer offers on
online only or password passwords passcode presale pre-sale provided register registration required
sale see sent show shows sign signup sms soon tba tbd text that the this tickets ticket to today
unlock use valid via vip was when will with www you your yours above shown applies apply expires
included access fan fans member members step steps limit faq usa all
`.split(/\s+/).filter(Boolean));

const CODE_RE =
  /\b(?:code|password|passcode)s?\b(?<sep>\s*(?:\bis\b|:|=|–|—|-)?\s*:?\s*)(?<q>["“”'‘’«]?)\s*(?<code>[A-Za-z0-9][A-Za-z0-9_\-]{1,23}[A-Za-z0-9])\b/gi;
// Keyword is case-insensitive; the code itself must be ALL CAPS/digits (checked in extractCodes).
const USE_RE =
  /\b(?:use|enter|apply|redeem)\s+(?:(?:the|promo|presale|offer|access|discount|code|password)\s*:?\s+){0,3}(?<q>["“'‘]?)(?<code>[A-Za-z0-9][A-Za-z0-9_\-]{1,23}[A-Za-z0-9])\b/gi;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const WHEN_RE = new RegExp(
  String.raw`(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?` + MONTH +
    String.raw`\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?` +
    String.raw`(?:\s*(?:at|@|from|,|-|–)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)` +
    String.raw`(?:\s*(?:[ECMP][SD]?T|local(?: time)?))?)?`,
  "i",
);
const SKIP_LINK = new RegExp(
  String.raw`unsubscribe|opt-?out|preferences|privacy|terms|view.{0,12}(?:browser|online|web)|` +
    String.raw`facebook\.com|instagram\.com|twitter\.com|//x\.com|tiktok\.com|youtube\.com|` +
    String.raw`spotify\.com|apps\.apple\.com|play\.google|manage|help center|contact us`,
  "i",
);
const GOOD_LINK_TEXT =
  /ticket|buy|get |presale|pre-sale|on ?sale|shop|purchase|unlock|register|sign up|access|find|book|reserve|details|learn more|more info|redeem|claim|see (?:dates|shows)/i;

// ---------- helpers ----------

export function normDomain(d: string | null | undefined): string {
  let s = (d ?? "").trim().toLowerCase();
  if (s.includes("://")) {
    try { s = new URL(s).hostname; } catch { /* keep */ }
  }
  s = s.split("/")[0].replace(/^@+/, "").replace(/^\.+|\.+$/g, "");
  if (s.includes("@")) s = s.split("@")[1];
  return s.startsWith("www.") ? s.slice(4) : s;
}

export function domainMatches(domain: string, trusted: string[]): boolean {
  const d = normDomain(domain);
  return !!d && trusted.some((t) => t && (d === t || d.endsWith("." + t)));
}

export function baseDomain(domain: string): string {
  const parts = normDomain(domain).split(".");
  if (parts.length >= 3 && parts.at(-1)!.length === 2 && ["co", "com", "org", "net"].includes(parts.at(-2)!)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer)>/gi, "$&\n")
    .replace(/<\/td>/gi, "$& ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/ /g, " ").replace(/[​-‍⁠﻿͏­]/g, "");
  const out: string[] = [];
  let blank = false;
  for (const raw of s.split(/\r?\n/)) {
    const l = raw.split(/\s+/).filter(Boolean).join(" ");
    if (l) { out.push(l); blank = false; } else if (!blank && out.length) { out.push(""); blank = true; }
  }
  return out.join("\n").trim();
}

export function cleanSubject(s: string | null | undefined): string {
  let cur = (s ?? "").trim();
  while (true) {
    const n = cur.replace(/^(?:re|fw|fwd)\s*:\s*/i, "");
    if (n === cur) return cur;
    cur = n;
  }
}

export function subjectKey(s: string): string {
  return cleanSubject(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validCode(code: string, quoted: boolean, sep: string): boolean {
  const c = code.replace(/^[-_]+|[-_]+$/g, "");
  if (c.length < 3 || c.length > 25 || STOP.has(c.toLowerCase())) return false;
  if (/^\d+$/.test(c)) return c.length >= 4 && !/^(?:19|20)\d\d$/.test(c);
  const letters = [...c].filter((ch) => /[a-z]/i.test(ch));
  if (/\d/.test(c) || letters.every((ch) => ch === ch.toUpperCase())) return true;
  if (quoted) return true;
  // Title-case words ("Spotlight") only count right after "Code:" / "code is".
  const s = sep.trim().toLowerCase();
  return /^[A-Z]/.test(c) && (s.includes(":") || s.startsWith("is") || s.includes("="));
}

export function extractCodes(text: string): string[] {
  const found: string[] = [];
  const add = (code: string) => {
    const c = code.replace(/^[-_]+|[-_]+$/g, "");
    if (!found.some((f) => f.toUpperCase() === c.toUpperCase())) found.push(c);
  };
  for (const m of text.matchAll(CODE_RE)) {
    const g = m.groups!;
    if (validCode(g.code, !!g.q, g.sep ?? "")) add(g.code);
  }
  for (const m of text.matchAll(USE_RE)) {
    const g = m.groups!;
    if (g.code === g.code.toUpperCase() && validCode(g.code, !!g.q, "")) add(g.code);
  }
  return found.slice(0, 5);
}

export type Link = { url: string; text: string };

export function extractLinks(html: string | null, text: string): { links: Link[]; primary: string | null } {
  const raw: [string, string, number][] = [];
  if (html) {
    let i = 0;
    for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(m[2].trim());
      if (!/^https?:/i.test(href)) continue;
      let label = decodeEntities(m[3].replace(/<[^>]+>/g, " ")).split(/\s+/).filter(Boolean).join(" ");
      if (!label) {
        const alt = m[3].match(/\balt\s*=\s*(["'])(.*?)\1/i);
        if (alt) label = decodeEntities(alt[2]);
      }
      raw.push([href, label.slice(0, 80), i++]);
    }
  } else {
    let i = 0;
    for (const m of (text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) raw.push([m[0].replace(/[.,;]+$/, ""), "", i++]);
  }
  const seen = new Set<string>();
  const scored: (Link & { score: number; pos: number })[] = [];
  for (const [url, label, pos] of raw) {
    if (seen.has(url) || SKIP_LINK.test(url) || SKIP_LINK.test(label)) continue;
    seen.add(url);
    let score = 0;
    if (GOOD_LINK_TEXT.test(label)) score += 3;
    let host = "";
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    if (domainMatches(host, DEFAULT_TRUSTED) || /ticket|presale|event/i.test(url)) score += 2;
    if (/\.(?:png|jpe?g|gif)(?:\?|$)/i.test(url)) score -= 5;
    scored.push({ url, text: label, score, pos });
  }
  scored.sort((a, b) => b.score - a.score || a.pos - b.pos);
  return { links: scored.slice(0, 6).map(({ url, text }) => ({ url, text })), primary: scored[0]?.url ?? null };
}

function makeSnippet(flat: string, anchors: string[]): string {
  let pos = -1;
  const low = flat.toLowerCase();
  for (const a of anchors) {
    const p = low.indexOf(a.toLowerCase());
    if (a && p !== -1) { pos = p; break; }
  }
  if (pos === -1) return flat.slice(0, 280) + (flat.length > 280 ? "…" : "");
  let start = Math.max(0, pos - 150), end = Math.min(flat.length, pos + 200);
  while (start > 0 && flat[start] !== " ") start--;
  while (end < flat.length && flat[end] !== " ") end++;
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}

function findWhen(flat: string): string | null {
  for (const kw of flat.matchAll(/pre-?sale|on sale|begins|starts|available/gi)) {
    const window = flat.slice(Math.max(0, kw.index! - 60), kw.index! + kw[0].length + 140);
    const m = window.match(WHEN_RE);
    if (m) return m[0].replace(/^[\s,-]+|[\s,-]+$/g, "");
  }
  return null;
}

// ---------- learning from your feedback ----------

// "Same kind of email": same sender address + same subject once dates and numbers are removed.
// e.g. "Your weekly picks — Oct 26" and "Your weekly picks — Nov 2" match; two different artists don't.
export function fingerprint(senderEmail: string, subject: string): string {
  const s = cleanSubject(subject).toLowerCase()
    .replace(/\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b/g, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim();
  return `${(senderEmail ?? "").toLowerCase()}|${s}`;
}

// Words the learner looks at: sender domain, subject words, and the start of the email.
export function featureTokens(senderEmail: string, subject: string, text: string): string[] {
  const toks = new Set<string>();
  const dom = baseDomain(normDomain(senderEmail));
  if (dom) toks.add("from:" + dom);
  for (const w of cleanSubject(subject).toLowerCase().match(/[a-z]{3,}/g) ?? []) if (!STOP.has(w)) toks.add("s:" + w);
  for (const w of (text ?? "").slice(0, 800).toLowerCase().match(/[a-z]{3,}/g) ?? []) if (!STOP.has(w)) toks.add(w);
  return [...toks].slice(0, 200);
}

export type Learned = {
  blocked: string[];
  labels: Map<string, boolean>;
  promo: Map<string, number>; not: Map<string, number>;
  nPromo: number; nNot: number; totPromo: number; totNot: number; vocab: number;
};

export function buildLearned(
  rows: { is_promo: boolean; fingerprint: string; tokens: string[] | null }[],
  blocked: string[],
): Learned {
  const L: Learned = {
    blocked: blocked.map((b) => b.trim().toLowerCase()).filter(Boolean),
    labels: new Map(), promo: new Map(), not: new Map(),
    nPromo: 0, nNot: 0, totPromo: 0, totNot: 0, vocab: 0,
  };
  for (const r of rows) { // oldest first, so your latest choice wins
    L.labels.set(r.fingerprint, r.is_promo);
    const m = r.is_promo ? L.promo : L.not;
    if (r.is_promo) L.nPromo++; else L.nNot++;
    for (const t of r.tokens ?? []) {
      m.set(t, (m.get(t) ?? 0) + 1);
      if (r.is_promo) L.totPromo++; else L.totNot++;
    }
  }
  L.vocab = new Set([...L.promo.keys(), ...L.not.keys()]).size;
  return L;
}

export function isBlocked(senderEmail: string, blocked: string[]): boolean {
  const addr = (senderEmail ?? "").toLowerCase();
  return blocked.some((b) => (b.includes("@") ? addr === b : domainMatches(addr, [b])));
}

// Word-based nudge (-4..+4) once you've marked at least 3 of each kind.
function learnedNudge(L: Learned, tokens: string[]): number {
  if (L.nPromo < 3 || L.nNot < 3) return 0;
  let lo = Math.log(L.nPromo / L.nNot);
  for (const t of tokens) {
    const p = L.promo.get(t) ?? 0, n = L.not.get(t) ?? 0;
    if (!p && !n) continue;
    lo += Math.log((p + 1) / (L.totPromo + L.vocab)) - Math.log((n + 1) / (L.totNot + L.vocab));
  }
  return Math.max(-4, Math.min(4, Math.round(lo / 2)));
}

export type Detection = {
  is_promo: boolean; score: number; reasons: string[]; codes: string[]; links: Link[];
  primary_link: string | null; title: string; subject_key: string; snippet: string; when: string | null;
  text: string; sender_domain: string; sender_name: string; sender_email: string;
};

export function detect(opts: {
  senderEmail: string; senderName?: string; subject: string; text?: string | null; html?: string | null;
  hasListUnsubscribe?: boolean; trusted?: string[]; mode?: string; force?: boolean; learned?: Learned;
}): Detection {
  const trusted = opts.trusted?.length ? opts.trusted : DEFAULT_TRUSTED;
  let text = opts.text ?? "";
  if (!text && opts.html) text = htmlToText(opts.html);
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const subj = cleanSubject(opts.subject);
  const head = subj + " \n " + flat.slice(0, 1500);
  const domain = normDomain(opts.senderEmail);
  const known = domainMatches(domain, trusted);

  let score = 0;
  const reasons: string[] = [];
  if (known) { score += 3; reasons.push("trusted sender"); }
  const strong = STRONG.filter((r) => r.test(subj) || r.test(flat));
  if (strong.length) {
    score += Math.min(6, 2 * strong.length + STRONG.filter((r) => r.test(subj)).length);
    reasons.push("promo wording");
  }
  score += Math.min(3, MEDIUM.filter((r) => r.test(subj) || r.test(flat)).length);
  const codes = extractCodes(subj + " . " + flat);
  if (codes.length) { score += 3; reasons.push("code found"); }
  if (NEGATIVE.some((r) => r.test(head))) { score -= 10; reasons.push("looks like account/order email"); }
  if (opts.hasListUnsubscribe) score += 1;
  else {
    score -= 2;
    if (/^\s*(?:re|fwd?)\s*:/i.test(opts.subject ?? "")) { score -= 3; reasons.push("looks like a personal reply"); }
  }

  const L = opts.learned;
  if (L) {
    const nudge = learnedNudge(L, featureTokens(opts.senderEmail, opts.subject, text));
    if (nudge) {
      score += nudge;
      reasons.push(nudge > 0 ? "similar to emails you marked as promos" : "similar to emails you marked not a promo");
    }
  }

  const threshold = known ? 4 : 6;
  let isPromo = score >= threshold && (codes.length > 0 || strong.length > 0);
  if (L) {
    const fp = fingerprint(opts.senderEmail, opts.subject);
    if (L.labels.has(fp)) {
      isPromo = L.labels.get(fp)!;
      reasons.push(isPromo ? "you marked this kind of email as a promo" : "you marked this kind of email as not a promo");
    }
    if (isBlocked(opts.senderEmail, L.blocked)) { isPromo = false; reasons.push("sender blocked by you"); }
  }
  if (opts.mode === "strict" && !known) { isPromo = false; reasons.push("strict mode: sender not trusted"); }
  if (opts.force) isPromo = true;

  const { links, primary } = extractLinks(opts.html ?? null, text);
  return {
    is_promo: isPromo, score, reasons, codes, links, primary_link: primary,
    title: subj || "(no subject)", subject_key: subjectKey(opts.subject),
    snippet: makeSnippet(flat, [...codes, "presale", "pre-sale", "promo", "code"]),
    when: findWhen(flat), text, sender_domain: domain,
    sender_name: opts.senderName ?? "", sender_email: opts.senderEmail ?? "",
  };
}

// ===== client.ts =====
// Server-side client with full access. Only ever used inside Edge Functions.
export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// ===== notify.ts =====
// Alerts for new promos: SMS through Twilio and/or free push notifications through ntfy.

const env = (k: string) => Deno.env.get(k) ?? "";

export function twilioReady(): boolean {
  return !!(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && (env("TWILIO_FROM") || env("TWILIO_MESSAGING_SERVICE_SID")));
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!twilioReady()) throw new Error("Texting isn't set up yet (add the TWILIO_* secrets)");
  const sid = env("TWILIO_ACCOUNT_SID");
  const form = new URLSearchParams({ To: to, Body: body });
  if (env("TWILIO_MESSAGING_SERVICE_SID")) form.set("MessagingServiceSid", env("TWILIO_MESSAGING_SERVICE_SID"));
  else form.set("From", env("TWILIO_FROM"));
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${env("TWILIO_AUTH_TOKEN")}`) },
    body: form,
  });
  if (!r.ok) {
    let msg = await r.text();
    try { msg = JSON.parse(msg).message ?? msg; } catch { /* keep text */ }
    throw new Error(`Twilio error ${r.status}: ${String(msg).slice(0, 200)}`);
  }
}

export async function sendPush(topic: string, title: string, message: string, click?: string | null): Promise<void> {
  const server = (env("NTFY_SERVER") || "https://ntfy.sh").replace(/\/+$/, "");
  const r = await fetch(server, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title: title.slice(0, 120), message, priority: 5, tags: ["tickets"], ...(click ? { click } : {}) }),
  });
  if (!r.ok) throw new Error(`ntfy error ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

type Promo = { id: number; title: string; codes: string[]; when_text: string | null; primary_link: string | null };

export async function getSettings(sb: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await sb.from("settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value ?? ""]));
}

export function hubLink(settings: Record<string, string>, id: number): string | null {
  const base = (settings.public_url || "").replace(/\/+$/, "").replace(/\/#.*$/, "");
  return base ? `${base}/#/promo/${id}` : null;
}

export async function notifyPromo(sb: SupabaseClient, promoId: number): Promise<void> {
  const { data: p } = await sb.from("promos").select("id,title,codes,when_text,primary_link").eq("id", promoId).single<Promo>();
  if (!p) return;
  const settings = await getSettings(sb);
  const link = hubLink(settings, p.id) ?? p.primary_link;
  const lines = ["NEW PROMO: " + (p.title ?? "").slice(0, 90)];
  if (p.codes?.length) lines.push("Code: " + p.codes.join(", "));
  if (p.when_text) lines.push("When: " + p.when_text);
  if (link) lines.push(link);
  const sms = lines.join("\n");

  const logs: Record<string, unknown>[] = [];
  const { data: phones } = await sb.from("phones").select("number").eq("enabled", true);
  await Promise.all((phones ?? []).map(async (ph) => {
    try {
      await sendSms(ph.number, sms);
      logs.push({ promo_id: p.id, channel: "sms", target: ph.number, ok: true });
    } catch (e) {
      logs.push({ promo_id: p.id, channel: "sms", target: ph.number, ok: false, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }));
  const topic = (settings.ntfy_topic || "").trim();
  if (topic) {
    let msg = p.codes?.length ? "Code: " + p.codes.join(", ") : "No code - tap for details";
    if (p.when_text) msg += "\nWhen: " + p.when_text;
    try {
      await sendPush(topic, p.title ?? "New promo", msg, link);
      logs.push({ promo_id: p.id, channel: "push", target: topic, ok: true });
    } catch (e) {
      logs.push({ promo_id: p.id, channel: "push", target: topic, ok: false, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }
  if (logs.length) await sb.from("notify_log").insert(logs);
}

// ===== checker.ts =====
// Checks every connected inbox over IMAP (read-only), and turns new promo emails into promos.

// Edge Functions get a small CPU budget per run, so each run handles a limited batch per folder;
// anything left over is picked up on the next run a minute later.
const MAX_PER_FOLDER = 12;
const BACKFILL_DAYS = 2;

type Account = {
  id: number; email: string; imap_host: string; imap_port: number; check_spam: boolean;
  last_email_at: string | null; password: string;
};

export type Parsed = {
  message_key: string; sender_email: string; sender_name: string; subject: string;
  text: string; html: string | null; date: string; list_unsubscribe: boolean;
};

export async function parseMessage(raw: Uint8Array): Promise<Parsed> {
  const m = await PostalMime.parse(raw);
  const header = (name: string) => m.headers.find((h) => h.key === name.toLowerCase())?.value ?? "";
  let date = new Date().toISOString();
  if (m.date) {
    const d = new Date(m.date);
    if (!isNaN(d.getTime())) date = d.toISOString();
  }
  const html = m.html ?? null;
  let key = (m.messageId ?? "").trim();
  if (!key) {
    const digest = await crypto.subtle.digest("SHA-1", raw.slice(0, 4000));
    key = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return {
    message_key: key,
    sender_email: (m.from?.address ?? "").toLowerCase(),
    sender_name: m.from?.name ?? "",
    subject: m.subject ?? "",
    // Newsletters' plain-text parts are often stripped down, so prefer the HTML version.
    text: html ? htmlToText(html) : (m.text ?? ""),
    html,
    date,
    list_unsubscribe: !!header("list-unsubscribe"),
  };
}

export type Ctx = { sb: SupabaseClient; trusted: string[]; mode: string; deadline: number; stats: Stats; learned?: Learned };
type Stats = { inboxes: number; checked: number; promos: number; duplicates: number; filtered: number; errors: string[] };

export async function handleMessage(ctx: Ctx, accountId: number, p: Parsed): Promise<number | null> {
  const { sb } = ctx;
  const { data: claimed } = await sb.from("processed")
    .upsert({ account_id: accountId, message_key: p.message_key }, { onConflict: "account_id,message_key", ignoreDuplicates: true })
    .select("message_key");
  if (!claimed?.length) return null; // already handled in an earlier run
  ctx.stats.checked++;
  await sb.from("accounts").update({ last_email_at: p.date }).eq("id", accountId)
    .or(`last_email_at.is.null,last_email_at.lt.${p.date}`);

  const det = detect({
    senderEmail: p.sender_email, senderName: p.sender_name, subject: p.subject, text: p.text, html: p.html,
    hasListUnsubscribe: p.list_unsubscribe, trusted: ctx.trusted, mode: ctx.mode, learned: ctx.learned,
  });
  if (det.is_promo) {
    const { data, error } = await sb.rpc("save_promo", { p: det, p_account: accountId, p_received: p.date });
    if (error) throw new Error("save_promo: " + error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (row.is_new) {
      ctx.stats.promos++;
      await notifyPromo(sb, row.promo_id);
    } else ctx.stats.duplicates++;
    return row.promo_id;
  }
  ctx.stats.filtered++;
  await sb.from("filtered").insert({
    account_id: accountId, sender_name: p.sender_name, sender_email: p.sender_email, subject: p.subject,
    score: det.score, reasons: det.reasons, received_at: p.date,
    data: {
      sender_email: p.sender_email, sender_name: p.sender_name, subject: p.subject, list_unsubscribe: p.list_unsubscribe,
      text: p.text.slice(0, 20000), html: (p.html ?? "").slice(0, 300000),
    },
  });
  return null;
}

export async function testLogin(host: string, port: number, user: string, pass: string): Promise<[boolean, string]> {
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000 } as never);
  try {
    await client.connect();
    await client.logout();
    return [true, "Connected"];
  } catch (e) {
    const err = e as { responseText?: string; message?: string };
    return [false, err.responseText || err.message || String(e)];
  }
}

async function pollFolder(ctx: Ctx, client: ImapFlow, acc: Account, folder: string) {
  const { sb } = ctx;
  const lock = await client.getMailboxLock(folder, { readOnly: true } as never);
  try {
    const mb = client.mailbox as unknown as { uidValidity: bigint; uidNext: number };
    const uidvalidity = String(mb.uidValidity);
    const top = Number(mb.uidNext) - 1;
    const { data: state } = await sb.from("folder_state").select("*").eq("account_id", acc.id).eq("folder", folder).maybeSingle();
    const save = (last: number) =>
      sb.from("folder_state").upsert({ account_id: acc.id, folder, uidvalidity, last_uid: last }, { onConflict: "account_id,folder" });

    let last: number;
    let uids: number[];
    if (!state || state.uidvalidity !== uidvalidity) {
      // First look at this folder: only go back a couple of days.
      last = 0;
      const since = new Date(Date.now() - BACKFILL_DAYS * 864e5);
      uids = ((await client.search({ since }, { uid: true })) || []) as number[];
      if (!uids.length) { await save(Math.max(top, 0)); return; }
    } else {
      last = Number(state.last_uid) || 0;
      if (top <= last) return; // nothing new, no fetching needed
      uids = ((await client.search({ uid: `${last + 1}:*` }, { uid: true })) || []) as number[];
    }
    uids = uids.filter((u) => u > last).sort((a, b) => a - b);
    let maxDone = last;
    for (const uid of uids.slice(0, MAX_PER_FOLDER)) {
      if (Date.now() > ctx.deadline) break;
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && msg.source) {
        try {
          await handleMessage(ctx, acc.id, await parseMessage(msg.source));
        } catch (e) {
          ctx.stats.errors.push(`${acc.email} message ${uid}: ${(e as Error).message}`);
        }
      }
      maxDone = uid;
    }
    if (maxDone > last || !state || state.uidvalidity !== uidvalidity) await save(maxDone);
  } finally {
    lock.release();
  }
}

async function pollAccount(ctx: Ctx, acc: Account) {
  const client = new ImapFlow({
    host: acc.imap_host, port: acc.imap_port || 993, secure: true,
    auth: { user: acc.email, pass: acc.password }, logger: false, socketTimeout: 40000,
  } as never);
  await client.connect();
  try {
    const folders = ["INBOX"];
    if (acc.check_spam) {
      const list = await client.list();
      const spam = list.find((m) => m.specialUse === "\\Junk") ??
        list.find((m) => ["spam", "junk", "[gmail]/spam"].includes(m.path.toLowerCase()));
      if (spam) folders.push(spam.path);
    }
    for (const f of folders) await pollFolder(ctx, client, acc, f);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Your "promo / not a promo" choices and blocked senders, used on every check.
export async function loadLearned(sb: SupabaseClient): Promise<Learned> {
  const [fb, bl] = await Promise.all([
    sb.from("feedback").select("is_promo,fingerprint,tokens").order("created_at", { ascending: false }).limit(1000),
    sb.from("blocked_senders").select("pattern"),
  ]);
  return buildLearned([...(fb.data ?? [])].reverse(), (bl.data ?? []).map((r) => r.pattern));
}

export async function runCheck(sb: SupabaseClient, opts: { budgetMs?: number; force?: boolean } = {}) {
  const stats: Stats = { inboxes: 0, checked: 0, promos: 0, duplicates: 0, filtered: 0, errors: [] };
  const { data: locked } = await sb.rpc("try_lock_run", { secs: 90 });
  if (!locked) return { skipped: "another check is still running", ...stats };
  try {
    const [settings, sendersRes, accRes, learned] = await Promise.all([
      getSettings(sb),
      sb.from("senders").select("domain"),
      sb.from("accounts").select("id,email,imap_host,imap_port,check_spam,last_email_at,account_secrets(password)").eq("enabled", true),
      loadLearned(sb),
    ]);
    const ctx: Ctx = {
      sb, stats,
      trusted: (sendersRes.data ?? []).map((r) => r.domain),
      mode: settings.detection_mode || "smart",
      deadline: Date.now() + (opts.budgetMs ?? 45000),
      learned,
    };
    const accounts: Account[] = (accRes.data ?? []).map((a) => ({
      ...a, password: (Array.isArray(a.account_secrets) ? a.account_secrets[0]?.password : (a.account_secrets as { password?: string })?.password) ?? "",
    })) as Account[];
    stats.inboxes = accounts.length;
    await Promise.all(accounts.map(async (acc) => {
      const now = new Date().toISOString();
      try {
        if (!acc.password) throw new Error("No app password saved for this inbox");
        await pollAccount(ctx, acc);
        await sb.from("accounts").update({ last_checked: now, last_error: null }).eq("id", acc.id);
      } catch (e) {
        const err = e as { responseText?: string; message?: string };
        const msg = (err.responseText || err.message || String(e)).slice(0, 300);
        stats.errors.push(`${acc.email}: ${msg}`);
        await sb.from("accounts").update({ last_checked: now, last_error: msg }).eq("id", acc.id);
      }
    }));
    if (new Date().getUTCMinutes() === 0) await sb.rpc("prune");
    return stats;
  } finally {
    await sb.rpc("release_run");
  }
}

// ===== index.ts =====
// Actions the dashboard asks the server to do: connect inboxes, test alerts, check now, etc.
// Only the hub's owner (signed in through Supabase Auth) can call this.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = adminClient();

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await sb.auth.getUser(token);
  if (!auth?.user) return json({ error: "Please sign in again" }, 401);
  const { data: member } = await sb.from("app_users").select("user_id").eq("user_id", auth.user.id).maybeSingle();
  if (!member) return json({ error: "This account doesn't have access to this hub" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "status":
        return json({ twilio: twilioReady() });

      case "add_account": {
        const email = String(body.email ?? "").trim();
        const password = String(body.password ?? "").replace(/\s+/g, ""); // Gmail shows app passwords with spaces
        const host = String(body.imap_host ?? "").trim() || "imap.gmail.com";
        const port = Number(body.imap_port) || 993;
        if (!email || !password) return json({ error: "Email and app password are required" }, 400);
        const [ok, msg] = await testLogin(host, port, email, password);
        if (!ok && !body.save_anyway) return json({ error: `Couldn't sign in to ${email}: ${msg}` }, 400);
        const { data: acc, error } = await sb.from("accounts").insert({
          email, label: String(body.label ?? "").trim() || email.split("@")[0], imap_host: host, imap_port: port,
          check_spam: body.check_spam !== false,
        }).select("id").single();
        if (error) throw error;
        await sb.from("account_secrets").insert({ account_id: acc.id, password });
        return json({ ok: true, connected: ok, message: ok ? `Connected ${email}` : `Saved ${email}, but sign-in failed: ${msg}` });
      }

      case "update_password": {
        const id = Number(body.account_id);
        const password = String(body.password ?? "").replace(/\s+/g, "");
        const { data: a } = await sb.from("accounts").select("*").eq("id", id).single();
        const [ok, msg] = await testLogin(a.imap_host, a.imap_port, a.email, password);
        if (!ok) return json({ error: `Couldn't sign in: ${msg}` }, 400);
        await sb.from("account_secrets").upsert({ account_id: id, password });
        await sb.from("accounts").update({ last_error: null }).eq("id", id);
        return json({ ok: true, message: "Password updated" });
      }

      case "test_account": {
        const id = Number(body.account_id);
        const { data: a } = await sb.from("accounts").select("*, account_secrets(password)").eq("id", id).single();
        const sec = Array.isArray(a.account_secrets) ? a.account_secrets[0] : a.account_secrets;
        const [ok, msg] = await testLogin(a.imap_host, a.imap_port, a.email, sec?.password ?? "");
        return ok ? json({ ok: true, message: `${a.email}: connected` }) : json({ error: `${a.email}: ${msg}` }, 400);
      }

      case "check_now": {
        const r = await runCheck(sb, { budgetMs: 40000 });
        return json({ ok: true, ...r });
      }

      case "test_sms": {
        const { data: ph } = await sb.from("phones").select("number").eq("id", Number(body.phone_id)).single();
        if (!ph) return json({ error: "Phone not found" }, 404);
        await sendSms(ph.number, "Promo Hub test: texts are working. You'll get one like this for every new promo.");
        return json({ ok: true, message: `Test text sent to ${ph.number}` });
      }

      case "test_push": {
        const topic = (await getSettings(sb)).ntfy_topic?.trim();
        if (!topic) return json({ error: "Save a push topic first" }, 400);
        await sendPush(topic, "Promo Hub test", "Push alerts are working.");
        return json({ ok: true, message: "Test push sent" });
      }

      case "resend": {
        await notifyPromo(sb, Number(body.promo_id));
        return json({ ok: true, message: "Alerts sent again" });
      }

      case "promote": {
        const { data: f } = await sb.from("filtered").select("*").eq("id", Number(body.filtered_id)).single();
        const d = f.data ?? {};
        const det = detect({
          senderEmail: d.sender_email ?? f.sender_email, senderName: d.sender_name, subject: d.subject ?? f.subject,
          text: d.text, html: d.html || null, hasListUnsubscribe: !!d.list_unsubscribe, force: true,
        });
        const { data, error } = await sb.rpc("save_promo", { p: det, p_account: f.account_id, p_received: f.received_at });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const senderEmail = d.sender_email ?? f.sender_email ?? "";
        const domain = baseDomain(normDomain(senderEmail));
        if (domain) await sb.from("senders").upsert({ domain, note: "added from Filtered" }, { onConflict: "domain", ignoreDuplicates: true });
        await sb.from("feedback").insert({
          is_promo: true, sender_email: senderEmail.toLowerCase(),
          fingerprint: fingerprint(senderEmail, d.subject ?? f.subject ?? ""),
          tokens: featureTokens(senderEmail, d.subject ?? f.subject ?? "", d.text ?? ""),
        });
        // If you had blocked this sender before, un-block it.
        await sb.from("blocked_senders").delete().in("pattern", [senderEmail.toLowerCase(), domain]);
        await sb.from("filtered").delete().eq("id", f.id);
        if (row.is_new && body.notify) await notifyPromo(sb, row.promo_id);
        return json({ ok: true, promo_id: row.promo_id, message: `Added. Email from ${domain} is trusted from now on.` });
      }

      case "not_promo": {
        // body: promo_id, block: "none" | "address" | "domain"
        const { data: p } = await sb.from("promos").select("*").eq("id", Number(body.promo_id)).single();
        if (!p) return json({ error: "Promo not found" }, 404);
        const senderEmail = String(p.sender_email ?? "").toLowerCase();
        const subject = String(p.title ?? "");
        await sb.from("feedback").insert({
          is_promo: false, sender_email: senderEmail,
          fingerprint: fingerprint(senderEmail, subject),
          tokens: featureTokens(senderEmail, subject, p.body_text ?? ""),
        });
        const { data: seen } = await sb.from("sightings").select("account_id").eq("promo_id", p.id).limit(1);
        await sb.from("filtered").insert({
          account_id: seen?.[0]?.account_id ?? null, sender_name: p.sender_name, sender_email: senderEmail, subject,
          score: p.score, reasons: ["you marked it not a promo"], received_at: p.first_seen,
          data: { sender_email: senderEmail, sender_name: p.sender_name, subject, text: p.body_text ?? "", html: "", list_unsubscribe: true },
        });
        await sb.from("promos").delete().eq("id", p.id);
        let message = "Got it — similar emails will be skipped from now on.";
        const block = String(body.block ?? "none");
        if (block === "address" && senderEmail) {
          await sb.from("blocked_senders").upsert({ pattern: senderEmail, note: "blocked from a promo" }, { onConflict: "pattern", ignoreDuplicates: true });
          message = `Blocked ${senderEmail}. Nothing from that address will show up again.`;
        } else if (block === "domain") {
          const domain = baseDomain(normDomain(senderEmail));
          if (domain) {
            await sb.from("blocked_senders").upsert({ pattern: domain, note: "blocked from a promo" }, { onConflict: "pattern", ignoreDuplicates: true });
            await sb.from("senders").delete().eq("domain", domain);
            message = `Blocked everything from ${domain}.`;
          }
        }
        return json({ ok: true, message });
      }

      case "learning_status": {
        const L = await loadLearned(sb);
        return json({ ok: true, promos: L.nPromo, not: L.nNot, blocked: L.blocked.length });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    const err = e as { message?: string };
    return json({ error: err.message ?? String(e) }, 500);
  }
});
