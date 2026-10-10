// ===== Upstream pools =====
// Primary pool: every member blocks ads + trackers, so racing them keeps
// adblock consistent while still picking the fastest.
const PRIMARY_UPSTREAMS = [
  { name: 'AdGuard',   url: 'https://dns.adguard-dns.com/dns-query' }, // ads + trackers + malware, no-log policy
  { name: 'Mullvad',   url: 'https://adblock.doh.mullvad.net/dns-query' }, // ads + trackers, no-log (SE)
  { name: 'ControlD',  url: 'https://freedns.controld.com/p2' }, // ads + trackers + malware
];
// Last resort only (privacy-strong, malware blocking, but does NOT block
// ads) — used when the whole primary pool fails.
const FALLBACK_UPSTREAMS = [
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
];

// ===== Tuning =====
const RACE_TIMEOUT_MS = 2500;      // per-upstream timeout inside a race
const FAIL_COOLDOWN_MS = 30000;    // skip a failing upstream for this long
const CACHE_MAX_ENTRIES = 2000;
const TTL_MIN = 30;                // seconds
const TTL_MAX = 3600;
const TTL_NODATA = 60;             // NOERROR with no answers
const TTL_NXDOMAIN = 120;          // negative cache
const STALE_GRACE_SEC = 86400;     // serve expired answers up to 24h on total failure
const MAX_QUERY_SIZE = 2048;
const MAX_RESPONSE_SIZE = 65535;

// ===== Per-upstream runtime stats (in-memory, per isolate) =====
const upstreamStats = new Map(); // url -> { emaMs, fails, cooldownUntil }
function statsFor(u) {
  let s = upstreamStats.get(u.url);
  if (!s) { s = { emaMs: 0, fails: 0, cooldownUntil: 0 }; upstreamStats.set(u.url, s); }
  return s;
}
function noteSuccess(u, ms) {
  const s = statsFor(u);
  s.emaMs = s.emaMs ? Math.round(s.emaMs * 0.7 + ms * 0.3) : ms;
  s.fails = 0;
  s.cooldownUntil = 0;
}
function noteFailure(u) {
  const s = statsFor(u);
  s.fails++;
  if (s.fails >= 2) s.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
}
function available(upstreams) {
  const now = Date.now();
  const ok = upstreams.filter((u) => statsFor(u).cooldownUntil <= now);
  return ok.length ? ok : upstreams; // never race an empty pool
}

// ===== DNS wire helpers =====

// Parse and validate the question section. Returns null when malformed.
function parseQuestion(buf) {
  if (buf.length < 12) return null;
  const qdcount = (buf[4] << 8) | buf[5];
  if (qdcount !== 1) return null; // single-question queries only
  let off = 12;
  const labels = [];
  for (;;) {
    if (off >= buf.length) return null;
    const len = buf[off];
    if (len === 0) { off++; break; }
    if (len > 63 || (len & 0xc0)) return null; // no compression in questions
    if (off + 1 + len > buf.length) return null;
    let label = '';
    for (let i = 0; i < len; i++) label += String.fromCharCode(buf[off + 1 + i]);
    labels.push(label.toLowerCase());
    off += 1 + len;
  }
  if (off + 4 > buf.length) return null;
  const qtype = (buf[off] << 8) | buf[off + 1];
  const qclass = (buf[off + 2] << 8) | buf[off + 3];
  return { qname: labels.join('.'), qtype, qclass, questionEnd: off + 4 };
}

function cacheKeyFor(q) {
  return `${q.qname}|${q.qtype}|${q.qclass}`;
}

// Read a possibly-compressed domain name at `off`. Returns { name, next }.
function readName(buf, off) {
  const labels = [];
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (off >= buf.length || jumps > 10) return { name: labels.join('.'), next: next < 0 ? off : next };
    const len = buf[off];
    if (len === 0) { if (next < 0) next = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (next < 0) next = off + 2;
      off = ptr;
      jumps++;
      continue;
    }
    if (len > 63 || off + 1 + len > buf.length) break;
    let label = '';
    for (let i = 0; i < len; i++) label += String.fromCharCode(buf[off + 1 + i]);
    labels.push(label);
    off += 1 + len;
  }
  return { name: labels.join('.'), next: next < 0 ? off : next };
}

// Walk resource records starting at `off`; count = number of RRs.
// cb(rr) may return a replacement Uint8Array for the RR, or null to keep it.
function walkRRs(buf, off, count, cb) {
  const parts = [];
  let pos = off;
  for (let i = 0; i < count; i++) {
    const start = pos;
    const { next } = readName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) return null;
    const type = (buf[pos] << 8) | buf[pos + 1];
    const ttl = (buf[pos + 4] * 0x1000000) + ((buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]);
    const rdlen = (buf[pos + 8] << 8) | buf[pos + 9];
    const rdataStart = pos + 10;
    if (rdataStart + rdlen > buf.length) return null;
    const rr = { type, ttl, rdataStart, rdlen, end: rdataStart + rdlen, raw: buf.slice(start, rdataStart + rdlen) };
    const replacement = cb ? cb(rr) : null;
    parts.push(replacement || rr.raw);
    pos = rdataStart + rdlen;
  }
  return { parts, end: pos };
}

// Minimum TTL across the ANSWER section, or null.
function extractMinTTL(buf) {
  const q = parseQuestion(buf);
  if (!q) return null;
  const ancount = (buf[6] << 8) | buf[7];
  if (!ancount) return null;
  let min = Infinity;
  const walked = walkRRs(buf, q.questionEnd, ancount, (rr) => { if (rr.ttl < min) min = rr.ttl; return null; });
  if (!walked || min === Infinity) return null;
  return min;
}

// Remove the ECS option (code 8) from the OPT record of a query.
// Returns a new buffer, or the original when there is nothing to strip.
function stripECS(buf) {
  try {
    const q = parseQuestion(buf);
    if (!q) return buf;
    const an = (buf[6] << 8) | buf[7];
    const ns = (buf[8] << 8) | buf[9];
    const ar = (buf[10] << 8) | buf[11];
    let pos = q.questionEnd;
    // skip answer + authority sections untouched
    const skipped = walkRRs(buf, pos, an + ns, null);
    if (!skipped) return buf;
    pos = skipped.end;
    const head = [buf.slice(0, pos)];
    let changed = false;
    const walked = walkRRs(buf, pos, ar, (rr) => {
      if (rr.type !== 41) return null; // not OPT
      // parse options inside rdata
      const opts = [];
      let p = rr.rdataStart;
      let hasECS = false;
      while (p + 4 <= rr.rdataStart + rr.rdlen) {
        const code = (buf[p] << 8) | buf[p + 1];
        const len = (buf[p + 2] << 8) | buf[p + 3];
        if (p + 4 + len > rr.rdataStart + rr.rdlen) return null;
        if (code === 8) hasECS = true;
        else opts.push(buf.slice(p, p + 4 + len));
        p += 4 + len;
      }
      if (!hasECS) return null;
      changed = true;
      const optDataLen = opts.reduce((s, o) => s + o.length, 0);
      const fixedPart = rr.raw.slice(0, rr.raw.length - rr.rdlen); // name+type+class+ttl+rdlen placeholder
      const out = new Uint8Array(fixedPart.length + optDataLen);
      out.set(fixedPart, 0);
      // fix RDLENGTH (last 2 bytes of fixed part)
      out[out.length - optDataLen - 2] = (optDataLen >> 8) & 0xff;
      out[out.length - optDataLen - 1] = optDataLen & 0xff;
      let w = fixedPart.length;
      for (const o of opts) { out.set(o, w); w += o.length; }
      return out;
    });
    if (!walked || !changed) return buf;
    const all = head.concat(walked.parts);
    const total = all.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let w = 0;
    for (const a of all) { out.set(a, w); w += a.length; }
    return out;
  } catch (e) {
    return buf;
  }
}

// RFC 8467 padding: grow the OPT PADDING option so the whole query length
// is a multiple of 128 bytes.
function addPadding(buf) {
  try {
    const q = parseQuestion(buf);
    if (!q) return buf;
    const an = (buf[6] << 8) | buf[7];
    const ns = (buf[8] << 8) | buf[9];
    const ar = (buf[10] << 8) | buf[11];
    const skipped = walkRRs(buf, q.questionEnd, an + ns, null);
    if (!skipped) return buf;

    // find OPT in additional section
    let optRR = null;
    walkRRs(buf, skipped.end, ar, (rr) => { if (rr.type === 41 && !optRR) optRR = rr; return null; });

    if (!optRR) {
      // append a fresh OPT with pure padding
      const baseLen = buf.length + 11; // root(1)+type(2)+class(2)+ttl(4)+rdlen(2)
      const padLen = (128 - (baseLen % 128)) % 128;
      const out = new Uint8Array(buf.length + 11 + padLen);
      out.set(buf, 0);
      let p = buf.length;
      out[p++] = 0; // root name
      out[p++] = 0; out[p++] = 41; // TYPE OPT
      out[p++] = 0x04; out[p++] = 0xd0; // CLASS 1232
      out[p++] = 0; out[p++] = 0; out[p++] = 0; out[p++] = 0; // TTL (DO=0)
      out[p++] = (padLen >> 8) & 0xff; out[p++] = padLen & 0xff;
      // padding bytes are zeros already; option header for PADDING (code 12):
      if (padLen >= 4) {
        out[p] = 0; out[p + 1] = 12;
        out[p + 2] = ((padLen - 4) >> 8) & 0xff; out[p + 3] = (padLen - 4) & 0xff;
      }
      // bump ARCOUNT
      const newAr = ar + 1;
      out[10] = (newAr >> 8) & 0xff; out[11] = newAr & 0xff;
      return out;
    }

    // OPT exists: extend its rdata with a PADDING option
    const currentTotal = buf.length;
    // adding an option costs 4 bytes header + data
    const padDataLen = ((128 - ((currentTotal + 4) % 128)) % 128);
    const addLen = 4 + padDataLen;
    const out = new Uint8Array(currentTotal + addLen);
    out.set(buf.slice(0, optRR.rdataStart + optRR.rdlen), 0);
    out.set(buf.slice(optRR.rdataStart + optRR.rdlen), optRR.rdataStart + optRR.rdlen + addLen);
    // write padding option at old end of OPT rdata
    let p = optRR.rdataStart + optRR.rdlen;
    out[p++] = 0; out[p++] = 12;
    out[p++] = (padDataLen >> 8) & 0xff; out[p++] = padDataLen & 0xff;
    // fix OPT RDLENGTH
    const newRdlen = optRR.rdlen + addLen;
    const rdlenPos = optRR.rdataStart - 2;
    out[rdlenPos] = (newRdlen >> 8) & 0xff; out[rdlenPos + 1] = newRdlen & 0xff;
    return out;
  } catch (e) {
    return buf;
  }
}

function rewriteID(buf, id) {
  const out = buf.slice();
  out[0] = (id >> 8) & 0xff;
  out[1] = id & 0xff;
  return out;
}

function buildServfail(query) {
  const q = parseQuestion(query);
  const qEnd = q ? q.questionEnd : 12;
  const out = new Uint8Array(qEnd);
  out.set(query.slice(0, qEnd), 0);
  out[2] = 0x81; out[3] = 0x82; // QR=1 RD=1, rcode=SERVFAIL(2)
  out[6] = 0; out[7] = 0; // ANCOUNT
  out[8] = 0; out[9] = 0; // NSCOUNT
  out[10] = 0; out[11] = 0; // ARCOUNT
  return out;
}

// ===== Cache =====
const dnsCache = new Map(); // key -> { buf, expiresAt, staleUntil }
function cacheGet(key) {
  const e = dnsCache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now < e.expiresAt) {
    dnsCache.delete(key); dnsCache.set(key, e); // LRU touch
    return { buf: e.buf, stale: false };
  }
  if (now < e.staleUntil) return { buf: e.buf, stale: true };
  dnsCache.delete(key);
  return null;
}
function cacheSet(key, buf, ttlSec) {
  if (dnsCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = dnsCache.keys().next().value;
    if (oldest !== undefined) dnsCache.delete(oldest);
  }
  const now = Date.now();
  dnsCache.set(key, {
    buf,
    expiresAt: now + ttlSec * 1000,
    staleUntil: now + Math.max(ttlSec, STALE_GRACE_SEC) * 1000,
  });
}

// ===== Upstream race =====
async function queryUpstream(u, queryBuf, timeoutMs) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, timeoutMs);
  try {
    const res = await fetch(u.url, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', 'accept': 'application/dns-message' },
      body: queryBuf,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 12 || buf.length > MAX_RESPONSE_SIZE) throw new Error('bad size');
    if (!(buf[2] & 0x80)) throw new Error('not a response');
    const ms = Date.now() - t0;
    const rcode = buf[3] & 0x0f;
    if (rcode === 2) { noteFailure(u); return null; } // SERVFAIL never wins a race
    noteSuccess(u, ms);
    return { buf, upstream: u, ms };
  } catch (e) {
    noteFailure(u);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// First valid answer wins; losers are aborted.
async function racePool(queryBuf, pool) {
  const racers = available(pool);
  return new Promise((resolve) => {
    let pending = racers.length;
    let settled = false;
    if (!pending) { resolve(null); return; }
    for (const u of racers) {
      queryUpstream(u, queryBuf, RACE_TIMEOUT_MS).then((r) => {
        if (settled) return;
        if (r) { settled = true; resolve(r); return; }
        if (--pending === 0) { settled = true; resolve(null); }
      });
    }
  });
}

async function resolveQuery(processedQuery) {
  const primary = await racePool(processedQuery, PRIMARY_UPSTREAMS);
  if (primary) return primary;
  return racePool(processedQuery, FALLBACK_UPSTREAMS);
}

function ttlForResponse(buf) {
  const rcode = buf[3] & 0x0f;
  if (rcode === 3) return TTL_NXDOMAIN;
  if (rcode !== 0) return 0; // don't cache other errors
  const ancount = (buf[6] << 8) | buf[7];
  if (!ancount) return TTL_NODATA;
  const min = extractMinTTL(buf);
  if (min === null) return TTL_NODATA;
  return Math.max(TTL_MIN, Math.min(TTL_MAX, min));
}

// ===== Request handling (wire format) =====
async function handleWireQuery(queryBuf) {
  if (queryBuf.length < 12 || queryBuf.length > MAX_QUERY_SIZE) {
    return { status: 400, body: new Uint8Array(0), cache: 'NONE', upstream: '' };
  }
  const question = parseQuestion(queryBuf);
  if (!question) {
    return { status: 400, body: new Uint8Array(0), cache: 'NONE', upstream: '' };
  }
  const id = (queryBuf[0] << 8) | queryBuf[1];
  const key = cacheKeyFor(question);

  const hit = cacheGet(key);
  if (hit && !hit.stale) {
    return { status: 200, body: rewriteID(hit.buf, id), cache: 'HIT', upstream: '' };
  }

  const processed = addPadding(stripECS(queryBuf));
  const result = await resolveQuery(processed);

  if (!result) {
    if (hit && hit.stale) {
      return { status: 200, body: rewriteID(hit.buf, id), cache: 'STALE', upstream: '' };
    }
    return { status: 200, body: buildServfail(queryBuf), cache: 'NONE', upstream: '' };
  }

  const ttl = ttlForResponse(result.buf);
  if (ttl > 0) cacheSet(key, result.buf, ttl);
  // upstream already answered with our query ID echoed — no rewrite needed.
  return { status: 200, body: result.buf, cache: 'MISS', upstream: result.upstream.name };
}

// ===== JSON API (?name=&type=) =====
const TYPE_MAP = { A: 1, AAAA: 28, CNAME: 5, NS: 2, MX: 15, TXT: 16, SOA: 6, PTR: 12, SRV: 33, CAA: 257, HTTPS: 65, SVCB: 64 };
function buildWireQuery(name, type) {
  const id = Math.floor(Math.random() * 65536);
  const labels = name.replace(/\.$/, '').split('.').filter(Boolean);
  let qlen = 1;
  for (const l of labels) qlen += 1 + l.length;
  const buf = new Uint8Array(12 + qlen + 4);
  buf[0] = (id >> 8) & 0xff; buf[1] = id & 0xff;
  buf[2] = 0x01; // RD
  buf[5] = 1; // QDCOUNT
  let p = 12;
  const enc = new TextEncoder();
  for (const l of labels) {
    const b = enc.encode(l);
    buf[p++] = b.length;
    buf.set(b, p); p += b.length;
  }
  buf[p++] = 0;
  buf[p++] = (type >> 8) & 0xff; buf[p++] = type & 0xff;
  buf[p++] = 0; buf[p++] = 1; // IN
  return buf;
}

function formatRdata(buf, rr) {
  const s = rr.rdataStart, len = rr.rdlen;
  switch (rr.type) {
    case 1: return `${buf[s]}.${buf[s + 1]}.${buf[s + 2]}.${buf[s + 3]}`;
    case 28: {
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(((buf[s + i] << 8) | buf[s + i + 1]).toString(16));
      return parts.join(':');
    }
    case 5: case 2: case 12: return readName(buf, s).name;
    case 15: return `${(buf[s] << 8) | buf[s + 1]} ${readName(buf, s + 2).name}`;
    case 16: {
      let out = '', p = s;
      while (p < s + len) { const l = buf[p++]; for (let i = 0; i < l; i++) out += String.fromCharCode(buf[p + i]); p += l; }
      return out;
    }
    default: {
      let hex = '';
      for (let i = 0; i < len; i++) hex += buf[s + i].toString(16).padStart(2, '0');
      return hex;
    }
  }
}

function wireToJson(buf) {
  const q = parseQuestion(buf);
  const json = {
    Status: buf[3] & 0x0f,
    TC: !!(buf[2] & 0x02), RD: !!(buf[2] & 0x01), RA: !!(buf[3] & 0x80),
    Question: q ? [{ name: q.qname + '.', type: q.qtype }] : [],
    Answer: [],
  };
  if (!q) return json;
  const ancount = (buf[6] << 8) | buf[7];
  walkRRs(buf, q.questionEnd, ancount, (rr) => {
    json.Answer.push({ name: q.qname + '.', type: rr.type, TTL: rr.ttl, data: formatRdata(buf, rr) });
    return null;
  });
  return json;
}

// ===== Pages =====
function landingPage(request) {
  const base = new URL(request.url);
  const endpoint = `${base.protocol}//${base.host}/dns-query`;
  const pool = PRIMARY_UPSTREAMS.concat(FALLBACK_UPSTREAMS)
    .map((u) => `<li>${u.name} — <code>${u.url}</code></li>`).join('');
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private DoH</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.9}
code{background:#161b22;padding:2px 6px;border-radius:6px;direction:ltr;display:inline-block}
.url{direction:ltr;text-align:left;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;word-break:break-all}
a{color:#4493f8}</style></head><body>
<h1>🔒 Private DoH</h1>
<p>سرور DNS over HTTPS خصوصی شما — بدون لاگ، بدون ارسال IP شما به سرورها (ECS حذف می‌شود)، با بلاک تبلیغ و بدافزار و کمترین پینگ ممکن (مسابقه‌ی هم‌زمان بین سرورها).</p>
<h3>آدرس سرویس</h3>
<div class="url">${endpoint}</div>
<h3>سرورهای زیرین</h3>
<ul style="direction:ltr;text-align:left">${pool}</ul>
<p>Quad9 فقط وقتی استفاده می‌شود که هر سه سرور اصلی از کار بیفتند.</p>
<h3>استفاده</h3>
<p>• مرورگر: تنظیمات DNS امن (Secure DNS) → Custom → همین آدرس.<br>
• پنل BPB: در فیلدهای <b>Remote DNS</b> و <b>Underlying DoH</b> همین آدرس را بگذار تا DNS کانفیگ‌ها هم از همین‌جا رد شود.<br>
• v2rayNG و کلاینت‌ها: به‌عنوان آدرس DoH.</p>
<p>وضعیت زنده‌ی سرورها: <a href="/health">/health</a></p>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function healthPage() {
  const data = {
    cacheEntries: dnsCache.size,
    upstreams: PRIMARY_UPSTREAMS.concat(FALLBACK_UPSTREAMS).map((u) => {
      const s = statsFor(u);
      return { name: u.name, url: u.url, avgMs: s.emaMs || null, fails: s.fails, coolingDown: s.cooldownUntil > Date.now() };
    }),
  };
  return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json' } });
}

// ===== Entry point (Pages Functions) =====
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/') return landingPage(request);
  if (path === '/health') return healthPage();

  const isDnsPath = path === '/dns-query';
  const looksLikeDns =
    url.searchParams.has('dns') ||
    (request.method === 'GET' && url.searchParams.has('name')) ||
    request.method === 'POST';

  if (!isDnsPath && !looksLikeDns) return landingPage(request);

  // JSON API
  const wantsJson =
    (request.headers.get('accept') || '').includes('application/dns-json') ||
    (url.searchParams.has('name') && !url.searchParams.has('dns'));

  try {
    if (wantsJson && request.method === 'GET') {
      const name = url.searchParams.get('name');
      if (!name) return new Response('{"Status":2}', { status: 400, headers: { 'content-type': 'application/dns-json' } });
      const typeName = (url.searchParams.get('type') || 'A').toUpperCase();
      const type = TYPE_MAP[typeName] || parseInt(typeName, 10) || 1;
      const q = buildWireQuery(name, type);
      const r = await handleWireQuery(q);
      if (r.status !== 200) return new Response('{"Status":2}', { status: r.status, headers: { 'content-type': 'application/dns-json' } });
      return new Response(JSON.stringify(wireToJson(r.body)), {
        headers: { 'content-type': 'application/dns-json', 'x-cache': r.cache, 'x-upstream': r.upstream },
      });
    }

    // Wire format
    let queryBuf;
    if (request.method === 'POST') {
      queryBuf = new Uint8Array(await request.arrayBuffer());
    } else {
      const dnsParam = url.searchParams.get('dns');
      if (!dnsParam) return new Response('Bad Request', { status: 400 });
      const b64 = dnsParam.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      queryBuf = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    const r = await handleWireQuery(queryBuf);
    if (r.status !== 200) return new Response('Bad Request', { status: r.status });
    return new Response(r.body, {
      headers: {
        'content-type': 'application/dns-message',
        'x-cache': r.cache,
        'x-upstream': r.upstream,
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    return new Response('Internal Error', { status: 500 });
  }
}
