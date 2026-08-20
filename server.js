const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const DATA_FILE = path.join(__dirname, 'usage.json');
const SESSIONS_DIR = path.join(require('os').homedir(), '.claude', 'sessions');
const AI_DIR = path.join(require('os').homedir(), 'Desktop', 'AI');
// 2026-08-20: project code folders now live inside Memory/projects/<hub>/, next to that
// project's notes hub, each keeping its own independent git repo. Memory/Personal/_Trash
// stay at AI root. See Memory/MEMORY.md "Projects" section for the full layout.
const MEMORY_PROJECTS_DIR = path.join(AI_DIR, 'Memory', 'projects');
const TRADING_DIR = path.join(MEMORY_PROJECTS_DIR, 'trading');
const WDB_DIR = path.join(MEMORY_PROJECTS_DIR, 'web-design-business', 'Web-Design-Business');
// Lead engine moved 2026-04-18 AI/Permit-Leads -> AI/Web-Design-Business/lead-engine, then 2026-08-20 -> Memory/projects/web-design-business/Web-Design-Business/lead-engine
const PERMIT_LEADS_DIR = path.join(WDB_DIR, 'lead-engine');
// Strategy: same lineage as above
const STRATEGY_DIR = path.join(WDB_DIR, 'strategy');
const CHAT_FILE = path.join(__dirname, 'office-chat.json');
const KALSHI_CLOSE_CACHE = path.join(TRADING_DIR, 'Kalshi', 'artifacts', 'close_times.json');

// Cache of ticker -> { close_time, expected_expiration_time, fetched_at }
let _kalshiCloseCache = null;
function loadKalshiCloseCache() {
  if (_kalshiCloseCache) return _kalshiCloseCache;
  try {
    if (fs.existsSync(KALSHI_CLOSE_CACHE)) {
      _kalshiCloseCache = JSON.parse(fs.readFileSync(KALSHI_CLOSE_CACHE, 'utf8'));
    } else { _kalshiCloseCache = {}; }
  } catch { _kalshiCloseCache = {}; }
  return _kalshiCloseCache;
}
function saveKalshiCloseCache() {
  try {
    fs.mkdirSync(path.dirname(KALSHI_CLOSE_CACHE), { recursive: true });
    fs.writeFileSync(KALSHI_CLOSE_CACHE, JSON.stringify(_kalshiCloseCache || {}, null, 2));
  } catch (e) { console.error('[kalshi-cache] save failed:', e.message); }
}

function fetchKalshiMarket(ticker) {
  // Public Kalshi endpoint, no auth needed for market metadata.
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
      { timeout: 4000, headers: { 'Accept': 'application/json' } },
      (r) => {
        let buf = '';
        r.on('data', (c) => buf += c);
        r.on('end', () => {
          try {
            const j = JSON.parse(buf);
            const m = j.market || j;
            resolve({
              close_time: m.close_time || null,
              expected_expiration_time: m.expected_expiration_time || m.expiration_time || null,
              title: m.title || null,
              subtitle: m.subtitle || null,
              yes_sub_title: m.yes_sub_title || null,
              no_sub_title: m.no_sub_title || null,
              rules_primary: m.rules_primary || null,
              rules_secondary: m.rules_secondary || null,
              event_ticker: m.event_ticker || null,
              category: m.category || null,
              status: m.status || null,
            });
          } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function enrichTickersWithCloseTime(tickers) {
  const cache = loadKalshiCloseCache();
  const now = Date.now();
  const stale = (t) => !cache[t] || (cache[t].fetched_at && (now - cache[t].fetched_at) > 24 * 3600 * 1000);
  const missing = tickers.filter(stale);
  if (!missing.length) return cache;
  // fetch in parallel, capped concurrency 6
  const queue = missing.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const m = await fetchKalshiMarket(t);
      if (m) cache[t] = { ...m, fetched_at: Date.now() };
      else cache[t] = { close_time: null, expected_expiration_time: null, fetched_at: Date.now() };
    }
  });
  await Promise.all(workers);
  saveKalshiCloseCache();
  return cache;
}

function getActiveSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const now = Date.now();
    const sessions = files.map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        let alive = false;
        try { process.kill(s.pid, 0); alive = true; } catch {}
        // Try to infer task from worktree contents
        let task = '';
        const cwdNorm = (s.cwd || '').replace(/\\/g, '/');
        if (cwdNorm.includes('worktrees')) {
          try {
            const items = fs.readdirSync(s.cwd).filter(f => !f.startsWith('.'));
            // Look for recognizable project indicators
            if (items.some(f => f.includes('aem') || f.includes('AEM'))) task = 'AEM 428 coursework';
            else if (items.some(f => f.includes('career') || f.includes('job'))) task = 'career research';
            else if (items.some(f => f.includes('portfolio'))) task = 'portfolio site';
            else if (items.some(f => f.includes('website') || f.includes('demo'))) task = 'website project';
            else if (items.some(f => f.includes('housing'))) task = 'housing search';
            else task = items.slice(0, 3).join(', ');
          } catch {}
        }
        return {
          pid: s.pid,
          sessionId: s.sessionId,
          cwd: (s.cwd || ''),
          task,
          kind: s.kind || 'interactive',
          entrypoint: s.entrypoint || 'cli',
          startedAt: s.startedAt,
          uptimeMs: now - s.startedAt,
          alive,
        };
      } catch { return null; }
    }).filter(Boolean).filter(s => s.alive);

    // Deduplicate: for sessions with same cwd, keep only the most recent
    const byCwd = {};
    for (const s of sessions) {
      const key = s.cwd.replace(/\\/g, '/');
      if (!byCwd[key] || s.startedAt > byCwd[key].startedAt) {
        byCwd[key] = s;
      }
    }
    return Object.values(byCwd);
  } catch { return []; }
}

function getOpenClawRuns() {
  // OpenClaw discontinued - return empty
  return [];
}

// Default/seed data - will be overwritten by scraper or manual edits
const { optimizerStatus } = require('./token-watcher.js');

const DEFAULT_DATA = {
  session: { pct: 0, reset: 'no active session' },
  weeklyAll: { pct: 0, reset: 'Resets Wed 8:00 PM' },
  sonnet: { pct: 0, reset: 'Resets Wed 8:00 PM' },
  spending: { spent: 0, limit: 30, balance: 0, pct: 0, reset: 'Resets May 1' },
};

function readUsage() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return DEFAULT_DATA;
  }
}

const WORKERS_DIR = path.join(require('os').homedir(), 'Desktop', 'AI', 'Memory', 'Workers');

// API call counter for session stats
let apiCallCount = 0;
const serverStartTime = Date.now();

const server = http.createServer((req, res) => {
  // CORS headers (full set for external tool integration)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Count API calls (middleware-style)
  if (req.url.startsWith('/api/')) apiCallCount++;

  // Request logging
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);

  // CORS preflight — handle early for all routes
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/usage' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readUsage()));
    return;
  }

  // GET /api/trading-bot - latest Stanley sweep (trading bot advisory data)
  if (req.url === '/api/trading-bot' && req.method === 'GET') {
    try {
      const sweepDir = path.join(TRADING_DIR, 'Trading-Bot', 'data', 'sweeps');
      if (!fs.existsSync(sweepDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ date: null, results: [], total_market_value: 0, position_count: 0 }));
        return;
      }
      const files = fs.readdirSync(sweepDir).filter(f => f.endsWith('.json')).sort();
      if (!files.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ date: null, results: [], total_market_value: 0, position_count: 0 }));
        return;
      }
      const latest = path.join(sweepDir, files[files.length - 1]);
      const data = fs.readFileSync(latest, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ============ STANLEY (TRADING BOT) v2 endpoints ============
  // All Stanley files live under AI/Trading-Bot/data/. Python is the source of
  // truth; the dashboard is a thin viewer + a few schtasks/exec shells.
  const STANLEY_DIR = path.join(TRADING_DIR, 'Trading-Bot');
  const STANLEY_DATA = path.join(STANLEY_DIR, 'data');
  const STANLEY_PY = 'C:\\Users\\Keela\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

  function _stanleyJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { return fallback; }
  }

  function _stanleyLatest(subdir) {
    const dir = path.join(STANLEY_DATA, subdir);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return path.join(dir, files[files.length - 1]);
  }

  function _stanleyReadBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
      });
    });
  }

  function _stanleyRunPy(scriptArgs, cb) {
    const { execFile } = require('child_process');
    execFile(STANLEY_PY, scriptArgs, {
      cwd: STANLEY_DIR, timeout: 30000, windowsHide: true,
    }, (err, stdout, stderr) => cb(err, stdout, stderr));
  }

  // GET /api/stanley/tasks - schtasks status for the 3 Stanley jobs
  if (req.url === '/api/stanley/tasks' && req.method === 'GET') {
    _stanleyRunPy(['-c', 'import sys; sys.path.insert(0, "src"); import tasks; import json; print(json.dumps(tasks.collect()))'],
      (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (err) { res.end(JSON.stringify({ error: String(err), tasks: [] })); return; }
        res.end(stdout || '{"tasks":[]}');
      });
    return;
  }

  // POST /api/stanley/tasks/:name/:op  where op in (enable|disable|run)
  {
    const m = req.url.match(/^\/api\/stanley\/tasks\/([A-Za-z]+)\/(enable|disable|run)$/);
    if (m && req.method === 'POST') {
      const name = m[1];
      const op = m[2];
      const fn = op === 'run' ? 'run_now' : op;
      _stanleyRunPy(['-c', `import sys; sys.path.insert(0,"src"); import tasks; import json; print(json.dumps(tasks.${fn}("${name}")))`],
        (err, stdout, stderr) => {
          res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(err ? JSON.stringify({ error: String(err), stderr }) : (stdout || '{}'));
        });
      return;
    }
  }

  // GET /api/stanley/sweep[?date=YYYY-MM-DD] - latest sweep or specific date
  if (req.url.startsWith('/api/stanley/sweep') && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const dateQ = u.searchParams.get('date');
    const file = dateQ
      ? path.join(STANLEY_DATA, 'sweeps', `${dateQ}.json`)
      : _stanleyLatest('sweeps');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_stanleyJson(file, { date: null, results: [] })));
    return;
  }

  // GET /api/stanley/recommendations[?date=YYYY-MM-DD]
  // Reshapes the raw decide.py output into a flat, frontend-friendly contract.
  // See repo notes: actions[] is the canonical action list (decide.py normalizes
  // any LLM key like do_this_today/shares_to_sell -> structured.actions).
  if (req.url.startsWith('/api/stanley/recommendations') && !req.url.includes('/list') && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const dateQ = u.searchParams.get('date');
    const today = new Date().toISOString().slice(0, 10);
    const dateUsed = dateQ || today;
    const recPath = path.join(STANLEY_DATA, 'recommendations', `${dateUsed}.json`);
    const mdPath = path.join(STANLEY_DATA, 'recommendations', `${dateUsed}.md`);
    const sweepPath = path.join(STANLEY_DATA, 'sweeps', `${dateUsed}.json`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!fs.existsSync(recPath)) {
      res.end(JSON.stringify({ ok: false, date: dateUsed, reason: 'no_recommendations_file_for_date', actions: [] }));
      return;
    }

    const rec = _stanleyJson(recPath, null);
    if (!rec) {
      res.end(JSON.stringify({ ok: false, date: dateUsed, reason: 'recommendations_file_unreadable', actions: [] }));
      return;
    }
    const sweep = _stanleyJson(sweepPath, {});
    let mdText = '';
    try { if (fs.existsSync(mdPath)) mdText = fs.readFileSync(mdPath, 'utf8'); } catch {}

    const structured = rec.structured || {};
    const SUPPRESSION_REASONS = {
      REPEAT_SUPPRESSED: 'Already recommended within the last 5 trading days',
      PRE_EARNINGS_COOLDOWN: 'Within 2 trading days of earnings',
      PANIC_DOWNGRADE_TO_HOLD: 'Stock dropped >10% in 5 days; protocol downgrades to HOLD pending fundamental check',
      PANIC_DOWNGRADE_TO_TRIM: 'Stock dropped >10% in 5 days; SELL downgraded to TRIM',
      MARGIN_GATE: 'Margin debt > 0 blocks BUY/ADD',
      EARNINGS_WEEK_NO_ADD: 'ADD blocked within 5 trading days of earnings',
      MONTHLY_ADD_CAP: 'Monthly cap of 4 ADDs reached',
      MAX_3_DEFERRED: 'Beyond the 3-action daily limit; deferred to tomorrow',
    };

    // Extract per-ticker section from .md.
    // Handles three known heading styles:
    //   "## TICKER ..."  /  "### TICKER ..."  (early decide.py format)
    //   "**TICKER (...)**" on a line by itself (current decide.py format, post 2026-04-28)
    // Captures from heading through the next heading or "---" divider.
    function extractTickerSection(ticker) {
      if (!mdText || !ticker) return null;
      const t = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Try "## TICKER" / "### TICKER" first
      let re = new RegExp(`(?:^|\\n)#{2,4}\\s+${t}\\b[^\\n]*\\n[\\s\\S]*?(?=\\n#{2,4}\\s+[A-Z]|\\n---\\s*\\n|\\n\\*\\*[A-Z]|$)`);
      let m = mdText.match(re);
      if (m) return m[0].trim();
      // Then "**TICKER (...)**" bold-line form
      re = new RegExp(`(?:^|\\n)\\*\\*${t}\\b[^\\n]*\\*\\*\\s*\\n[\\s\\S]*?(?=\\n---\\s*\\n|\\n\\*\\*[A-Z]|\\n#{2,4}\\s+[A-Z]|$)`);
      m = mdText.match(re);
      if (m) return m[0].trim();
      return null;
    }

    function firstParagraph(section) {
      if (!section) return null;
      const lines = section.split(/\r?\n/);
      const body = [];
      for (let i = 1; i < lines.length; i++) {
        const ln = lines[i].trim();
        if (!ln) { if (body.length) break; else continue; }
        if (/^\*\*Action:/i.test(ln)) continue;
        if (/^Action:/i.test(ln)) continue;
        if (/^Why:\s*$/i.test(ln)) continue;
        // Strip leading bullet markers
        const cleaned = ln.replace(/^[-*]\s+/, '');
        body.push(cleaned);
        if (body.join(' ').length > 280) break;
      }
      const joined = body.join(' ').replace(/\[sweep:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
      return joined || null;
    }

    function extractCitations(text) {
      if (!text) return [];
      const out = [];
      const re = /\[sweep:([^\]]+)\]/g;
      let m;
      const seen = new Set();
      while ((m = re.exec(text)) !== null) {
        const key = m[1].trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text: `[sweep:${key}]`, key });
      }
      return out;
    }

    function pickFirst(obj, keys) {
      for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
      }
      return null;
    }

    function normalizeAction(a, idx) {
      const ticker = a.ticker || a.symbol || null;
      const action = (a.action || '').toUpperCase();
      const qty_shares = pickFirst(a, ['qty_shares', 'shares', 'shares_to_sell', 'shares_to_buy', 'shares_to_trim', 'shares_to_add', 'quantity', 'qty']);
      const price_ref_usd = pickFirst(a, ['price_ref_usd', 'price_per_share_usd', 'approx_price_usd', 'price_usd']);
      let approx_dollars = pickFirst(a, ['approx_dollars', 'approx_proceeds_usd', 'estimated_proceeds_usd', 'approx_value_usd', 'proceeds_usd', 'dollars']);
      if ((approx_dollars === null || approx_dollars === undefined) && qty_shares != null && price_ref_usd != null) {
        approx_dollars = +(Number(qty_shares) * Number(price_ref_usd)).toFixed(2);
      }

      const section = extractTickerSection(ticker);
      const reason_full = section || null;
      const para = firstParagraph(section);
      const trigger = a.trigger || null;
      const concentration_pct_current = a.current_pct != null ? a.current_pct
        : (a.concentration_pct_current != null ? a.concentration_pct_current : null);
      const concentration_pct_post_trim = a.post_trim_pct != null ? a.post_trim_pct
        : (a.concentration_pct_post_trim != null ? a.concentration_pct_post_trim : null);

      let reason_short = para;
      if (!reason_short) {
        const bits = [];
        if (action) bits.push(action);
        if (qty_shares != null && ticker) bits.push(`${qty_shares} ${ticker}`);
        if (concentration_pct_current != null) bits.push(`(currently ${concentration_pct_current}%)`);
        if (trigger) bits.push(`-- trigger: ${trigger.replace(/_/g, ' ')}`);
        reason_short = bits.length ? bits.join(' ') : `${action} ${ticker || ''}`.trim();
      }

      // Heuristic details bullets from the per-ticker section: pull lines that look like "- foo" until we have a few
      const details = [];
      if (section) {
        const dlines = section.split(/\r?\n/).map(s => s.trim());
        for (const ln of dlines) {
          if (/^-\s+/.test(ln)) {
            const cleaned = ln.replace(/^-\s+/, '').replace(/\[sweep:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
            if (cleaned) details.push(cleaned);
            if (details.length >= 6) break;
          }
        }
      }
      if (a.holding_days != null) details.push(`Holding period: ${a.holding_days} days${a.ltcg_eligible ? ' (LTCG eligible)' : ''}`);
      if (concentration_pct_current != null && concentration_pct_post_trim != null) {
        details.push(`Concentration: ${concentration_pct_current}% -> ${concentration_pct_post_trim}% after trim`);
      } else if (concentration_pct_current != null) {
        details.push(`Concentration: ${concentration_pct_current}%`);
      }

      const citations = extractCitations(section);

      const rec_id = ticker && action && qty_shares != null
        ? `${ticker}-${action}-${qty_shares}-${(rec.date || dateUsed || '').replace(/-/g, '')}`
        : `${ticker || 'UNK'}-${action || 'UNK'}-${idx}`;

      return {
        ticker,
        action,
        qty_shares: qty_shares != null ? Number(qty_shares) : null,
        approx_dollars: approx_dollars != null ? Number(approx_dollars) : null,
        price_ref_usd: price_ref_usd != null ? Number(price_ref_usd) : null,
        priority: a.rank != null ? a.rank : (idx + 1),
        trigger,
        reason_short,
        reason_full,
        details,
        citations,
        confidence: a.confidence || null,
        holding_days: a.holding_days != null ? a.holding_days : null,
        ltcg_eligible: a.ltcg_eligible === true,
        concentration_pct_current,
        concentration_pct_post_trim,
        rec_id,
      };
    }

    // canonical action list = structured.actions (post-cooldown, post-override).
    // NEVER fall back to do_this_today / recommendations — those are pre-filter
    // LLM proposals; if cooldowns suppressed everything, actions[] is correctly
    // empty and the suppressed_cooldowns block already explains why.
    //
    // SPLIT: only BUY/ADD/SELL/TRIM go into `actions` (cards with copy-order
    // buttons). HOLD entries go into `holds`. NO_BUY / NO_RECOMMENDATION go
    // into `rejected_buys` (Stanley considered + said no, with the reason).
    const ACTIONABLE = new Set(['BUY', 'ADD', 'SELL', 'TRIM']);
    const REJECTED  = new Set(['NO_BUY', 'NO_RECOMMENDATION']);
    const rawActions = Array.isArray(structured.actions) ? structured.actions : [];
    const normalized = rawActions.map(normalizeAction);
    const actions = normalized.filter(a => ACTIONABLE.has((a.action || '').toUpperCase()));
    const inlineHolds = normalized.filter(a => (a.action || '').toUpperCase() === 'HOLD');
    // helper: strip [sweep:KEY] citation tags + take last reason (usually the verdict)
    const stripCitations = s => (s || '').replace(/\s*\[sweep:[^\]]+\]/g, '').trim();
    const verdictReason = a => {
      const rs = (a.reasons || []).map(stripCitations).filter(Boolean);
      // prefer a reason that starts with "Do NOT" / "wait" / "defer" / "buy" / "trim" - the verdict
      const verdict = rs.slice().reverse().find(r => /^(do |wait|defer|buy|trim|sell|hold|skip|revisit)/i.test(r));
      return verdict || rs[rs.length - 1] || rs[0] || null;
    };
    const rejected_buys = normalized.filter(a => REJECTED.has((a.action || '').toUpperCase())).map(a => ({
      ticker: a.ticker,
      action: a.action,
      action_label: a.action === 'NO_BUY' ? 'considered, skipped' : 'no recommendation',
      reason_short: verdictReason(a),
      reason_full: (a.reasons || []).map(stripCitations).filter(Boolean).join(' • '),
      details: (a.reasons || []).map(stripCitations).filter(Boolean),
      confidence: a.confidence,
    }));

    // watch_tomorrow - pass through with enrichment. Tolerate alt key names
    // the LLM uses: watch_list (string array), watches_tomorrow, watching, etc.
    let watchRaw = [];
    for (const k of ['watch_tomorrow', 'watch_list', 'watches_tomorrow', 'watching', 'watch']) {
      if (Array.isArray(structured[k]) && structured[k].length) {
        watchRaw = structured[k];
        break;
      }
    }
    const watch_tomorrow = watchRaw.map(w => {
      // string entries like "EFOR: insider cluster, defer until after FOMC..."
      if (typeof w === 'string') {
        const m = w.match(/^([A-Z]{1,5})[:\s-]+(.*)$/);
        return {
          ticker: m ? m[1] : null,
          action: null,
          qty_shares: null,
          reason: m ? m[2] : w,
        };
      }
      return {
        ticker: w.ticker || null,
        action: (w.action || w.potential_action || '').toUpperCase() || null,
        qty_shares: pickFirst(w, ['qty_shares', 'shares', 'shares_to_sell', 'shares_to_buy', 'shares_to_trim', 'shares_to_add', 'quantity', 'qty']),
        reason: w.note || w.reason || w.reason_deferred || w.suppression_reason || null,
      };
    });

    // holds - pull HOLD entries from structured.recommendations / positions / holds
    // PLUS any HOLD that landed in actions[] (which can happen when the LLM
    // emits actions=[14 HOLDs + 1 BUY] -- only the BUY makes it to actions
    // cards, the HOLDs land here).
    const holdSources = [];
    if (Array.isArray(structured.holds)) holdSources.push(...structured.holds);
    if (Array.isArray(structured.positions)) holdSources.push(...structured.positions);
    if (Array.isArray(structured.recommendations)) holdSources.push(...structured.recommendations);
    holdSources.push(...inlineHolds);
    const seenHolds = new Set();
    const holds = [];
    for (const h of holdSources) {
      const act = (h.action || '').toUpperCase();
      if (act !== 'HOLD') continue;
      const t = h.ticker || h.symbol;
      if (!t || seenHolds.has(t)) continue;
      seenHolds.add(t);
      // pull a one-line "why holding" if available
      // prefer a "verdict-shaped" reason (last one, usually says "no trim needed" / "wait for X")
      let reason = h.note || h.reason_short || h.reason || null;
      if (!reason && Array.isArray(h.reasons)) {
        const cleaned = h.reasons.map(r => (r || '').replace(/\s*\[sweep:[^\]]+\]/g, '').trim()).filter(Boolean);
        const verdict = cleaned.slice().reverse().find(r => /^(no |wait|hold|let|watch|revisit|patience|keep)/i.test(r));
        reason = verdict || cleaned[cleaned.length - 1] || cleaned[0] || null;
      }
      holds.push({ ticker: t, note: reason });
    }

    // suppressed_cooldowns - prefer top-level, fall back to structured.suppressed
    const suppressedRaw = Array.isArray(rec.suppressed_cooldowns) && rec.suppressed_cooldowns.length
      ? rec.suppressed_cooldowns
      : (Array.isArray(structured.suppressed) ? structured.suppressed : []);
    const suppressed_cooldowns = suppressedRaw.map(s => ({
      ticker: s.ticker || null,
      original: s.original || s.action || null,
      reason: s.reason || null,
      explanation: SUPPRESSION_REASONS[s.reason] || s.explanation || null,
      replacement: s.replacement != null ? s.replacement : null,
    }));

    // portfolio_snapshot - prefer sweep.portfolio_health, fall back to structured.portfolio_snapshot
    const ph = sweep.portfolio_health || {};
    const sps = structured.portfolio_snapshot || {};
    const portfolio_snapshot = {
      total_value_usd: ph.total_value_usd != null ? ph.total_value_usd : (sps.total_value_usd != null ? sps.total_value_usd : null),
      long_market_value_usd: ph.long_market_value_usd != null ? ph.long_market_value_usd : null,
      cash_balance_usd: ph.cash_balance_usd != null ? ph.cash_balance_usd : null,
      cash_pct: ph.cash_pct != null ? ph.cash_pct : (sps.cash_pct != null ? sps.cash_pct : null),
      margin_debt_usd: ph.margin_debt_usd != null ? ph.margin_debt_usd : (sps.margin_debt_usd != null ? sps.margin_debt_usd : null),
      buying_power_usd: ph.buying_power_usd != null ? ph.buying_power_usd : null,
      day_pl_usd: ph.day_pl_usd != null ? ph.day_pl_usd : null,
      day_pl_pct: (ph.day_pl_usd != null && ph.total_value_usd) ? +(ph.day_pl_usd / ph.total_value_usd * 100).toFixed(2) : null,
      is_pattern_day_trader: ph.is_pattern_day_trader === true,
      data_source: ph.data_source || null,
      tech_pct_lookthrough: ph.tech_pct_lookthrough != null ? ph.tech_pct_lookthrough : (sps.tech_pct_lookthrough != null ? sps.tech_pct_lookthrough : null),
      effective_n: ph.effective_n != null ? ph.effective_n : (sps.effective_n != null ? sps.effective_n : null),
      macro_regime: ph.macro_regime || sps.macro_regime || null,
      top_concentration: {
        ticker: ph.top1_concentration_ticker || sps.top1_ticker || null,
        pct: ph.top1_concentration_pct != null ? ph.top1_concentration_pct : (sps.top1_pct != null ? sps.top1_pct : null),
      },
    };

    // totals
    const total_proceeds_if_all_executed = +actions.reduce((s, a) => s + (a.approx_dollars || 0), 0).toFixed(2);
    const totals = {
      total_proceeds_if_all_executed,
      actions_count: actions.length,
      watch_count: watch_tomorrow.length,
      suppressed_count: suppressed_cooldowns.length,
    };

    // summary
    let summary = rec.summary_one_line || structured.summary_one_line || rec.verdict || null;
    if (!summary) {
      const trims = actions.filter(a => a.action === 'TRIM');
      const sells = actions.filter(a => a.action === 'SELL');
      const buys = actions.filter(a => a.action === 'BUY' || a.action === 'ADD');
      const parts = [];
      if (trims.length) {
        const sample = trims[0];
        const tail = sample ? ` ${sample.qty_shares != null ? sample.qty_shares + ' ' : ''}${sample.ticker || ''}${sample.approx_dollars != null ? ` (~$${Math.round(sample.approx_dollars).toLocaleString()})` : ''}` : '';
        parts.push(`${trims.length} trim${trims.length === 1 ? '' : 's'} today:${tail}.`);
      }
      if (sells.length) parts.push(`${sells.length} sell${sells.length === 1 ? '' : 's'}.`);
      if (buys.length) parts.push(`${buys.length} buy${buys.length === 1 ? '' : 's'}.`);
      if (watch_tomorrow.length) parts.push(`${watch_tomorrow.length} deferred to tomorrow.`);
      summary = parts.length ? parts.join(' ') : 'Nothing to do today.';
    }

    // as_of - sweep.timestamp, fall back to file mtime
    let as_of = sweep.timestamp || null;
    if (!as_of) {
      try { as_of = fs.statSync(recPath).mtime.toISOString(); } catch {}
    }

    // preflight_failures - normalize to flat array of code strings (decide.py emits tuples like ["MISSING_CITATIONS", [...]])
    const preflight_failures = Array.isArray(rec.preflight_failures)
      ? rec.preflight_failures.map(p => Array.isArray(p) ? p[0] : p).filter(Boolean)
      : [];

    // rule_pings - protocol violations the LLM flagged (effective N, tech overweight, FOMC proximity, etc)
    const rule_pings = Array.isArray(structured.rule_pings) ? structured.rule_pings : [];
    // discovery_top - first 5 candidates from sweep.discovery for the dashboard
    const discTop = ((sweep.discovery || {}).consolidated_top10 || []).slice(0, 8).map(c => ({
      ticker: c.ticker, name: c.name, signal_strength: c.signal_strength,
      screen: c.screen, sector: c.sector, price: c.price, mcap: c.market_cap,
      earnings_next: c.earnings_next, reasons: (c.reasons || []).slice(0, 3),
    }));

    const out = {
      date: rec.date || dateUsed,
      ok: rec.ok !== false,
      as_of,
      summary,
      actions,
      watch_tomorrow,
      holds,
      rejected_buys,
      suppressed_cooldowns,
      rule_pings,
      discovery_top: discTop,
      critiques: Array.isArray(rec.critiques) ? rec.critiques : (Array.isArray(structured.critiques) ? structured.critiques : []),
      portfolio_snapshot,
      totals,
      preflight_failures,
      raw: { path: `/data/recommendations/${rec.date || dateUsed}.json` },
    };

    res.end(JSON.stringify(out));
    return;
  }

  // GET /api/stanley/recommendations/list - last 7 mornings, summary only
  if (req.url === '/api/stanley/recommendations/list' && req.method === 'GET') {
    const dir = path.join(STANLEY_DATA, 'recommendations');
    let out = [];
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 7);
        out = files.map(f => {
          const j = _stanleyJson(path.join(dir, f), {});
          const recs = j.recommendations || j.recs || [];
          return {
            date: (f.replace('.json', '')),
            verdict: j.summary_one_line || j.verdict || null,
            actions: recs.length,
            buys: recs.filter(r => (r.action || '').toUpperCase().includes('BUY') || r.action === 'ADD').length,
            sells: recs.filter(r => /SELL|TRIM/.test((r.action || '').toUpperCase())).length,
          };
        });
      }
    } catch (e) { /* swallow */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ list: out }));
    return;
  }

  // GET /api/stanley/macro - latest sweep's macro block (or fresh if asked)
  if (req.url === '/api/stanley/macro' && req.method === 'GET') {
    const file = _stanleyLatest('sweeps');
    const sweep = _stanleyJson(file, {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sweep.macro || {}));
    return;
  }

  // GET /api/stanley/sycophancy - last sycophancy run findings
  if (req.url === '/api/stanley/sycophancy' && req.method === 'GET') {
    const file = path.join(STANLEY_DATA, 'sycophancy-latest.json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_stanleyJson(file, { findings: [], status: 'never_run' })));
    return;
  }

  // GET /api/stanley/incidents - tail of incidents log
  if (req.url === '/api/stanley/incidents' && req.method === 'GET') {
    const file = path.join(AI_DIR, 'Memory', 'Workers', 'Stanley', 'incidents.jsonl');
    let lines = [];
    try {
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-50)
          .map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      }
    } catch (e) { /* */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ incidents: lines.reverse() }));
    return;
  }

  // GET /api/stanley/overrides - active manual overrides
  if (req.url === '/api/stanley/overrides' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_stanleyJson(path.join(STANLEY_DATA, 'manual-overrides.json'), {})));
    return;
  }

  // POST /api/stanley/overrides  body: {ticker, action, until, reason}
  if (req.url === '/api/stanley/overrides' && req.method === 'POST') {
    (async () => {
      const body = await _stanleyReadBody(req);
      const { ticker, action, until, reason } = body;
      if (!ticker || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ticker + action required' })); return;
      }
      const args = ['-c',
        `import sys; sys.path.insert(0,"src"); import ledger, json; ` +
        `print(json.dumps(ledger.set_override(${JSON.stringify(ticker)}, ${JSON.stringify(action)}, ` +
        `${until ? JSON.stringify(until) : 'None'}, ${JSON.stringify(reason || '')})))`];
      _stanleyRunPy(args, (err, stdout, stderr) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(err ? JSON.stringify({ error: String(err), stderr }) : (stdout || '{}'));
      });
    })();
    return;
  }

  // DELETE /api/stanley/overrides/:ticker
  {
    const m = req.url.match(/^\/api\/stanley\/overrides\/([A-Z0-9.\-]+)$/i);
    if (m && req.method === 'DELETE') {
      const ticker = m[1].toUpperCase();
      _stanleyRunPy(['-c', `import sys; sys.path.insert(0,"src"); import ledger, json; print(json.dumps(ledger.clear_override(${JSON.stringify(ticker)})))`],
        (err, stdout, stderr) => {
          res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(err ? JSON.stringify({ error: String(err), stderr }) : (stdout || '{}'));
        });
      return;
    }
  }

  // POST /api/stanley/executions  body: {ticker, action, qty, price_ref, rec_date, rec_id, skipped, notes}
  if (req.url === '/api/stanley/executions' && req.method === 'POST') {
    (async () => {
      const b = await _stanleyReadBody(req);
      if (!b.ticker || !b.action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ticker + action required' })); return;
      }
      const args = ['-c',
        `import sys; sys.path.insert(0,"src"); import ledger, json; ` +
        `print(json.dumps(ledger.record_execution(` +
        `${JSON.stringify(b.ticker)}, ${JSON.stringify(b.action)}, ${Number(b.qty || 0)}, ` +
        `${b.price_ref != null ? Number(b.price_ref) : 'None'}, ` +
        `${b.rec_date ? JSON.stringify(b.rec_date) : 'None'}, ` +
        `${b.rec_id ? JSON.stringify(b.rec_id) : 'None'}, ` +
        `${b.skipped ? 'True' : 'False'}, ${JSON.stringify(b.notes || '')})))`];
      _stanleyRunPy(args, (err, stdout, stderr) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(err ? JSON.stringify({ error: String(err), stderr }) : (stdout || '{}'));
      });
    })();
    return;
  }

  // GET /api/stanley/hit-rate
  if (req.url === '/api/stanley/hit-rate' && req.method === 'GET') {
    _stanleyRunPy(['-c', 'import sys; sys.path.insert(0,"src"); import ledger, json; print(json.dumps(ledger.hit_rate_summary(90)))'],
      (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(err ? JSON.stringify({ executed: 0, skipped: 0 }) : (stdout || '{}'));
      });
    return;
  }

  // GET /api/stanley/dt_scanner - Day Trade Hunter: shells dt_scanner.py and returns
  // ranked RSI/MACD/Bollinger setups. Falls back to empty graceful response if the
  // scanner script doesn't exist yet or fails. Logs every successful scan to
  // data/_dt_cache/scan_log.jsonl (one JSON line: timestamp + top-3 tickers).
  if (req.url === '/api/stanley/dt_scanner' && req.method === 'GET') {
    const { execFile } = require('child_process');
    const dtScript = path.join(STANLEY_DIR, 'src', 'dt_scanner.py');
    const cacheDir = path.join(STANLEY_DATA, '_dt_cache');
    const logPath  = path.join(cacheDir, 'scan_log.jsonl');

    function emptyResp(note) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, setups: [], note: note || 'no setups' }));
    }
    function logHit(payload) {
      try {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const setups = (payload && payload.setups) || [];
        const top3 = setups.slice(0, 3).map(s => s && s.ticker).filter(Boolean);
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          universe_size: payload && payload.universe_size || 0,
          setup_count: setups.length,
          top3,
        }) + '\n';
        fs.appendFileSync(logPath, line);
      } catch (_) { /* logging is best-effort */ }
    }

    if (!fs.existsSync(dtScript)) {
      emptyResp('dt_scanner.py not yet built');
      return;
    }

    // Try direct script with --json flag first, fall back to import via _stanleyRunPy.
    execFile(STANLEY_PY, [dtScript, '--json', '8'], {
      cwd: STANLEY_DIR, timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (!err && stdout) {
        try {
          const payload = JSON.parse(stdout);
          logHit(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(Object.assign({ ok: true }, payload)));
          return;
        } catch (_) { /* fall through to import-mode fallback */ }
      }
      // Fallback: call dt_scanner.scan() via the same helper used by other endpoints.
      _stanleyRunPy(
        ['-c', 'import sys; sys.path.insert(0,"src"); import dt_scanner, json; print(json.dumps(dt_scanner.scan(max_results=8, cache_ttl=60)))'],
        (err2, stdout2) => {
          if (err2 || !stdout2) {
            emptyResp('scan failed: ' + String(err2 || stderr || 'no output').slice(0, 200));
            return;
          }
          try {
            const payload = JSON.parse(stdout2);
            logHit(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.assign({ ok: true }, payload)));
          } catch (e) {
            emptyResp('parse failed: ' + String(e).slice(0, 200));
          }
        }
      );
    });
    return;
  }

  // GET /api/kalshi-status - bot running? last tick how long ago?
  if (req.url === '/api/kalshi-status' && req.method === 'GET') {
    try {
      // paper_runner.log can get locked by a stuck SYSTEM-level runner instance;
      // prefer runner.log (what the wmi-launched user-space runner writes to) and
      // fall back to the legacy path.
      let logPath = path.join(TRADING_DIR, 'Kalshi', 'logs', 'runner.log');
      if (!fs.existsSync(logPath)) logPath = path.join(TRADING_DIR, 'Kalshi', 'logs', 'paper_runner.log');
      const out = { running: false, pid: null, last_tick_ago_s: null, tick_count: 0, last_line: '' };
      // Process check: prefer PowerShell CIM (wmic is deprecated and frequently no-ops on
      // newer Windows builds, which left the dashboard stuck on STOPPED even when the
      // bot was happily ticking). Fall through to log-mtime detection if both fail.
      try {
        const { execSync } = require('child_process');
        const ps = 'Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\' OR Name=\'pythonw.exe\'\\" | Where-Object { $_.CommandLine -like \'*paper_runner*\' } | Select-Object -First 1 -ExpandProperty ProcessId';
        const result = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const pid = parseInt((result || '').trim());
        if (pid) { out.running = true; out.pid = pid; }
      } catch(e) { /* fall back to log mtime */ }
      // Log-based check + tick stats. Fresh log = bot is alive even if process check failed.
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        out.last_line = lines[lines.length - 1] || '';
        const tickRegex = /\] tick (\d+) /g;
        let match, maxTick = 0;
        while ((match = tickRegex.exec(raw)) !== null) maxTick = Math.max(maxTick, parseInt(match[1]));
        out.tick_count = maxTick;
        out.last_tick_ago_s = Math.floor((Date.now() - stat.mtimeMs) / 1000);
        // Authoritative: log mtime under 3min = alive (paper_runner ticks every ~2min).
        // Over 3min = dead/stuck regardless of what process check said.
        if (out.last_tick_ago_s <= 180) out.running = true;
        else out.running = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, running: false }));
    }
    return;
  }

  // GET /api/kalshi-trades - reads every strategies/*/trades*.csv under AI/Kalshi
  // and returns fills + summary. Frontend renders equity curve + table.
  if (req.url === '/api/kalshi-trades' && req.method === 'GET') {
    (async () => {
    try {
      const kalshiRoot = path.join(TRADING_DIR, 'Kalshi', 'strategies');
      const out = { strategies: [], fills: [], summary: {} };
      if (fs.existsSync(kalshiRoot)) {
        const stratDirs = fs.readdirSync(kalshiRoot).filter(d => !d.startsWith('_'));
        for (const sd of stratDirs) {
          const stratPath = path.join(kalshiRoot, sd);
          if (!fs.statSync(stratPath).isDirectory()) continue;
          // Only surface folders that contain an actual strategy.py (matches
          // paper_runner's discovery rule). Skips empty stub dirs.
          if (!fs.existsSync(path.join(stratPath, 'strategy.py'))) continue;
          for (const journal of ['trades.csv', 'trades_live.csv']) {
            const p = path.join(stratPath, journal);
            if (!fs.existsSync(p)) continue;
            const raw = fs.readFileSync(p, 'utf8').trim();
            if (!raw) continue;
            const lines = raw.split(/\r?\n/);
            if (lines.length < 2) continue;
            const headers = lines[0].split(',');
            for (let i = 1; i < lines.length; i++) {
              const parts = lines[i].split(',');
              const row = {};
              headers.forEach((h, j) => row[h] = parts[j] || '');
              if (!row.fill_price) continue;
              row.strategy = sd;
              row.mode = journal === 'trades.csv' ? 'paper' : 'live-demo';
              out.fills.push(row);
            }
          }
          out.strategies.push(sd);
        }
      }
      // Sort fills by fill_ts
      out.fills.sort((a, b) => (a.fill_ts || '').localeCompare(b.fill_ts || ''));
      // Enrich with close_time from Kalshi public API (cached)
      try {
        const uniqTickers = Array.from(new Set(out.fills.map(f => f.ticker).filter(Boolean)));
        const cache = await enrichTickersWithCloseTime(uniqTickers);
        for (const f of out.fills) {
          const c = cache[f.ticker];
          if (c) {
            f.close_time = c.close_time || null;
            f.expected_expiration_time = c.expected_expiration_time || null;
            f.title = c.title || null;
            f.subtitle = c.subtitle || null;
            f.yes_sub_title = c.yes_sub_title || null;
            f.no_sub_title = c.no_sub_title || null;
            f.rules_primary = c.rules_primary || null;
            f.rules_secondary = c.rules_secondary || null;
            f.event_ticker = c.event_ticker || null;
            f.category = c.category || null;
            f.market_status = c.status || null;
          }
        }
      } catch (e) { console.error('[kalshi-trades] enrich failed:', e.message); }
      // Summary - aggregate + per-strategy breakdown. Aggregate fields kept for
      // back-compat; `by_strategy` is the new per-strategy index.
      function _empty() {
        return { total_fills: 0, open_positions: 0, settled: 0, wins: 0, losses: 0,
                 notional: 0, fees: 0, pnl: 0 };
      }
      function _finalize(a) {
        return {
          total_fills: a.total_fills,
          open_positions: a.open_positions,
          settled: a.settled,
          wins: a.wins,
          losses: a.losses,
          hit_rate: a.settled > 0 ? a.wins / a.settled : null,
          notional_committed: Math.round(a.notional * 100) / 100,
          total_fees: Math.round(a.fees * 100) / 100,
          realized_pnl: Math.round(a.pnl * 100) / 100,
        };
      }
      const _agg = _empty();
      const _perStrat = {};
      for (const f of out.fills) {
        const s = f.strategy || 'unknown';
        if (!_perStrat[s]) _perStrat[s] = _empty();
        const bag = _perStrat[s];
        const n = parseFloat(f.fill_price || 0) * parseInt(f.contracts || 0);
        const fee = parseFloat(f.fee || 0);
        _agg.total_fills++; bag.total_fills++;
        _agg.notional += n; bag.notional += n;
        _agg.fees += fee;   bag.fees += fee;
        if (f.resolved && f.resolved !== '') {
          const p = parseFloat(f.pnl || 0);
          _agg.settled++; bag.settled++;
          _agg.pnl += p;  bag.pnl += p;
          if (p > 0) { _agg.wins++; bag.wins++; }
          else if (p < 0) { _agg.losses++; bag.losses++; }
        } else {
          _agg.open_positions++; bag.open_positions++;
        }
      }
      out.summary = _finalize(_agg);
      out.by_strategy = {};
      for (const s of Object.keys(_perStrat)) out.by_strategy[s] = _finalize(_perStrat[s]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      console.error(`[ERROR] /api/kalshi-trades: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, fills: [], summary: {} }));
    }
    })();
    return;
  }

  if (req.url === '/api/usage-history') {
    try {
      const hist = fs.readFileSync(path.join(__dirname, 'usage-history.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(hist);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (req.url === '/api/optimizer') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(optimizerStatus));
    } catch (err) {
      console.error(`[ERROR] /api/optimizer: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get optimizer status' }));
    }
    return;
  }

  if (req.url === '/api/calls') {
    // Andy's call log - jsonl at C:\Users\Keela\Desktop\AI\Permit-Leads\call-log.jsonl
    try {
      const logPath = path.join(PERMIT_LEADS_DIR, 'call-log.jsonl');
      const calls = [];
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(l => l.trim());
        for (const ln of lines) {
          try { calls.push(JSON.parse(ln)); } catch {}
        }
      }
      // Newest first
      calls.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      // Stats
      const total = calls.length;
      const completed = calls.filter(c => c.outcome === 'ended').length;
      const totalSec = calls.reduce((s, c) => s + (Number(c.duration_sec) || 0), 0);
      const byCampaign = {};
      for (const c of calls) {
        const k = c.campaign || 'unknown';
        byCampaign[k] = (byCampaign[k] || 0) + 1;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats: { total, completed, totalSec, byCampaign }, calls }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats: { total: 0, completed: 0, totalSec: 0, byCampaign: {} }, calls: [] }));
    }
    return;
  }

  // Per-call transcript - reads transcripts/<call_id>.txt
  if (req.url.indexOf('/api/call-transcript/') === 0) {
    const callId = decodeURIComponent(req.url.split('/api/call-transcript/')[1] || '').replace(/[^A-Za-z0-9_\-]/g, '');
    try {
      const tPath = path.join(PERMIT_LEADS_DIR, 'transcripts', callId + '.txt');
      if (!fs.existsSync(tPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'transcript not found' }));
        return;
      }
      const text = fs.readFileSync(tPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ call_id: callId, transcript: text }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'failed to read transcript' }));
    }
    return;
  }

  // Andy's leads.json mirror lives at Permit-Leads/data/leads.json (rebuilt
  // by leads_db.sync_to_json()). It contains leads, demos, campaigns, hot
  // leads, dnc_count, and stats. The dashboard reads from there. We keep a
  // legacy fallback to dashboard/leads.json for backward compat.
  const PERMIT_DATA_DIR = path.join(PERMIT_LEADS_DIR, 'data');
  const PERMIT_LEADS_JSON = path.join(PERMIT_DATA_DIR, 'leads.json');
  const PERMIT_DEMOS_JSON = path.join(PERMIT_DATA_DIR, 'demos.json');
  const PERMIT_PAUSE_FLAG = path.join(PERMIT_DATA_DIR, '.dialing_paused');

  function readPermitLeadsMirror() {
    try {
      return JSON.parse(fs.readFileSync(PERMIT_LEADS_JSON, 'utf8'));
    } catch {
      return null;
    }
  }

  if (req.url === '/api/leads') {
    const mirror = readPermitLeadsMirror();
    if (mirror && Array.isArray(mirror.leads)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mirror.leads));
      return;
    }
    // Legacy fallback.
    try {
      const leads = JSON.parse(fs.readFileSync(path.join(__dirname, 'leads.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(leads));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // Full mirror for the new Cold Calling tab UI (leads + demos + campaigns + hot + stats)
  if (req.url.startsWith('/api/cold-call-snapshot') && req.method === 'GET') {
    const mirror = readPermitLeadsMirror();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // Never cache: keelan_decision changes need to be visible on refresh.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(JSON.stringify(mirror || {
      updated_at: null, leads: [], demos: [], campaigns: [],
      hot_leads: [], dnc_count: 0, dialing_paused: false, stats: {},
    }));
    return;
  }

  if (req.url === '/api/demos' && req.method === 'GET') {
    const mirror = readPermitLeadsMirror();
    if (mirror && Array.isArray(mirror.demos) && mirror.demos.length) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mirror.demos));
      return;
    }
    try {
      const demos = JSON.parse(fs.readFileSync(PERMIT_DEMOS_JSON, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(demos));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"demos":[]}');
    }
    return;
  }

  if (req.url === '/api/campaigns' && req.method === 'GET') {
    const mirror = readPermitLeadsMirror();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify((mirror && mirror.campaigns) || []));
    return;
  }

  if (req.url === '/api/hot-leads' && req.method === 'GET') {
    const mirror = readPermitLeadsMirror();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify((mirror && mirror.hot_leads) || []));
    return;
  }

  // POST /api/lead/:business/status   body: {status: "ready"|"called"|"hot"|...}
  // Spawns python -m andy.leads_db_update so the xlsx stays the source of truth.
  if (req.url.startsWith('/api/lead/') && req.url.endsWith('/status') && req.method === 'POST') {
    const segments = req.url.split('/');
    const business = decodeURIComponent(segments[3] || '');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      const status = String(parsed.status || '').slice(0, 40);
      if (!business || !status) {
        res.writeHead(400);
        res.end('{"error":"business and status required"}');
        return;
      }
      const { spawn } = require('child_process');
      const py = spawn('py', ['-c',
        `from andy import leads_db; leads_db.update_lead(${JSON.stringify(business)}, {"status": ${JSON.stringify(status)}}); print("OK")`
      ], { cwd: PERMIT_LEADS_DIR, windowsHide: true });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, business, status, stdout: out.trim(), stderr: err.trim() }));
      });
    });
    return;
  }

  // POST /api/lead/:business   body: { fields: {status, notes, site_critique, phone, email, ...} }
  // Generic field update. Whitelist what we'll accept so the UI can't write
  // arbitrary garbage into the xlsx. Phyllis owns site_critique normally but
  // Keelan can override from the dashboard, so we allow it here.
  if (req.url.match(/^\/api\/lead\/[^\/]+$/) && req.method === 'POST') {
    const segments = req.url.split('/');
    const business = decodeURIComponent(segments[3] || '');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      const incoming = (parsed && typeof parsed.fields === 'object' && parsed.fields) ? parsed.fields : parsed;
      const ALLOWED = new Set([
        'status', 'notes', 'site_critique', 'phone', 'email',
        'owner_name', 'industry', 'city', 'state', 'current_site',
        'demo_url', 'demo_slug', 'follow_up', 'response', 'email_sent',
        'date_sent', 'hot_lead', 'score',
        // Keelan's manual override - beats every auto recommendation.
        'keelan_decision', 'keelan_decision_at', 'keelan_decision_note',
        // Re-scrape pipeline manual overrides. When Keelan edits the website
        // in the approval card, the UI also flips current_site_reverified=true
        // so the lead can graduate without waiting for an automated re-verify.
        'current_site_reverified', 'current_site_reverified_at',
        'phone_rescraped', 'phone_rescraped_at',
        'email_rescraped', 'email_rescraped_at',
        'enrichment_ready', 'enrichment_ready_at',
        'rating', 'review_count',
        // Two-pitch routing: "bad" = original "your site is weak, here's a rebuild"
        // pitch. "good" = clone-and-undercut pitch (we copy a nice site and pitch
        // monthly hosting at a discount). Set by the GOOD/BAD buttons on the
        // approval card.
        'pitch_track', 'pitch_track_at',
      ]);
      const fields = {};
      for (const k of Object.keys(incoming || {})) {
        if (ALLOWED.has(k)) fields[k] = incoming[k];
      }
      if (!business || !Object.keys(fields).length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'business and at least one allowed field required', allowed: Array.from(ALLOWED) }));
        return;
      }
      const { spawn } = require('child_process');
      const py = spawn('py', ['-c',
        `import json, sys; from andy import leads_db; ok = leads_db.update_lead(${JSON.stringify(business)}, json.loads(sys.stdin.read())); print("OK" if ok else "NOTFOUND")`
      ], { cwd: PERMIT_LEADS_DIR, windowsHide: true });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.stdin.write(JSON.stringify(fields));
      py.stdin.end();
      py.on('close', code => {
        const ok = code === 0 && out.trim().endsWith('OK');
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, business, fields, stdout: out.trim(), stderr: err.trim() }));
      });
    });
    return;
  }

  // POST /api/dial   body: {business: "...", campaign?: "websites"}
  // Fire-and-forget: spawns python -m andy.dial_one.
  if (req.url === '/api/dial' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const business = String(p.business || '');
      const campaign = String(p.campaign || 'websites');
      if (!business) {
        res.writeHead(400); res.end('{"error":"business required"}'); return;
      }
      // Refuse if kill switch on
      if (fs.existsSync(PERMIT_PAUSE_FLAG)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'dialing_paused' }));
        return;
      }
      const { spawn } = require('child_process');
      const py = spawn('py', ['-m', 'andy.dial_one', '--business', business, '--campaign', campaign], {
        cwd: PERMIT_LEADS_DIR,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      py.unref();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: true, business, campaign, pid: py.pid }));
    });
    return;
  }

  // POST /api/dial-one-dry  - dry-run preview without dialing
  if (req.url === '/api/dial-one-dry' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const business = String(p.business || '');
      const campaign = String(p.campaign || 'websites');
      const { spawn } = require('child_process');
      const py = spawn('py', ['-m', 'andy.dial_one', '--business', business, '--campaign', campaign, '--dry-run'], {
        cwd: PERMIT_LEADS_DIR,
        windowsHide: true,
      });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, stdout: out, stderr: err }));
      });
    });
    return;
  }

  // POST /api/dial-custom   body: {to: "+1...", message: "..."}
  // Fires a one-off custom-message Andy call. No lead lookup required.
  if (req.url === '/api/dial-custom' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const to = String(p.to || '').trim();
      const message = String(p.message || '').trim();
      if (!to || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'to and message required' }));
        return;
      }
      if (fs.existsSync(PERMIT_PAUSE_FLAG)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'dialing_paused' }));
        return;
      }
      const { spawn } = require('child_process');
      const py = spawn('py', ['-m', 'andy.dial_custom', '--to', to, '--message', message], {
        cwd: PERMIT_LEADS_DIR,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      py.unref();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: true, to, pid: py.pid }));
    });
    return;
  }

  // POST /api/kill-switch   body: {paused: bool, reason?: string}
  if (req.url === '/api/kill-switch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const paused = !!p.paused;
      try {
        if (paused) {
          fs.mkdirSync(PERMIT_DATA_DIR, { recursive: true });
          fs.writeFileSync(PERMIT_PAUSE_FLAG, new Date().toISOString() + ' ' + (p.reason || 'dashboard') + '\n');
        } else if (fs.existsSync(PERMIT_PAUSE_FLAG)) {
          fs.unlinkSync(PERMIT_PAUSE_FLAG);
        }
        // Re-sync mirror so dialing_paused field flips immediately.
        const { spawn } = require('child_process');
        const py = spawn('py', ['-c', 'from andy import leads_db; leads_db.sync_to_json()'],
          { cwd: PERMIT_LEADS_DIR, windowsHide: true, detached: true, stdio: 'ignore' });
        py.unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/preflight - readiness checklist
  if (req.url === '/api/preflight' && req.method === 'GET') {
    const envPath = path.join(PERMIT_LEADS_DIR, '.env');
    let env = {};
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      raw.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      });
    } catch {}
    const mirror = readPermitLeadsMirror() || { leads: [], demos: [], hot_leads: [], stats: {} };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      retell_api_key: !!env.RETELL_API_KEY,
      retell_phone_set: !!env.RETELL_PHONE_NUMBER,
      retell_agent_websites: !!env.RETELL_AGENT_ID_WEBSITES,
      retell_agent_permits: !!env.RETELL_AGENT_ID_PERMITS,
      retell_agent_portfolio: !!env.RETELL_AGENT_ID_PORTFOLIO,
      twilio_configured: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
      anthropic_for_enrich: !!env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_API_KEY,
      dialing_paused: fs.existsSync(PERMIT_PAUSE_FLAG),
      lead_count: (mirror.leads || []).length,
      demo_count: (mirror.demos || []).length,
      hot_lead_count: (mirror.hot_leads || []).length,
      dnc_count: mirror.dnc_count || 0,
      calls_today: (mirror.stats || {}).calls_today || 0,
      cost_today_usd: (mirror.stats || {}).cost_today_usd || 0,
      connect_rate: (mirror.stats || {}).connect_rate || 0,
    }));
    return;
  }

  // POST /api/sync-leads  - manually trigger leads_db.sync_call_log + sync_to_json
  if (req.url === '/api/sync-leads' && req.method === 'POST') {
    const { spawn } = require('child_process');
    const py = spawn('py', ['-m', 'andy.leads_db', 'sync'], {
      cwd: PERMIT_LEADS_DIR,
      windowsHide: true,
    });
    let out = '', err = '';
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('close', code => {
      res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }));
    });
    return;
  }

  // POST /api/draft-email/:business
  // Triggers andy.draft_emails for a single approved lead. Synchronous so
  // the UI can show success/failure immediately. Falls back gracefully if
  // Google OAuth is not configured yet (returns auth_missing).
  if (req.url.startsWith('/api/draft-email/') && req.method === 'POST') {
    const segments = req.url.split('/');
    const business = decodeURIComponent(segments[3] || '');
    if (!business) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'business required' }));
      return;
    }
    const { spawn } = require('child_process');
    const py = spawn('py', ['-m', 'andy.draft_emails', '--business', business], {
      cwd: PERMIT_LEADS_DIR,
      windowsHide: true,
    });
    let out = '', err = '';
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('close', code => {
      const stdout = out.trim();
      const authMissing = stdout.includes('auth_missing') || stdout.includes('Missing OAuth client file');
      res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: code === 0,
        business,
        auth_missing: authMissing,
        stdout,
        stderr: err.trim(),
      }));
    });
    return;
  }

  // POST /api/run-campaign  body: {campaign, dry_run?}
  if (req.url === '/api/run-campaign' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const campaign = String(p.campaign || 'websites_warmup');
      const args = ['-m', 'andy.run_campaign', '--campaign', campaign];
      if (p.dry_run) args.push('--dry-run');
      if (p.ignore_hours) args.push('--ignore-hours');
      const { spawn } = require('child_process');
      if (p.dry_run) {
        // Capture and return output for dry runs.
        const py = spawn('py', args, { cwd: PERMIT_LEADS_DIR, windowsHide: true });
        let out = '', err = '';
        py.stdout.on('data', d => out += d);
        py.stderr.on('data', d => err += d);
        py.on('close', code => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: code === 0, stdout: out, stderr: err }));
        });
      } else {
        const py = spawn('py', args, {
          cwd: PERMIT_LEADS_DIR,
          windowsHide: true, detached: true, stdio: 'ignore',
        });
        py.unref();
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: true, campaign, pid: py.pid }));
      }
    });
    return;
  }

  // POST /api/add-lead  body: {business, phone, owner_name, email, industry, city, state, current_site, source}
  if (req.url === '/api/add-lead' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      if (!p.business) { res.writeHead(400); res.end('{"error":"business required"}'); return; }
      const safe = JSON.stringify(p);
      const { spawn } = require('child_process');
      const py = spawn('py', ['-c',
        `import json; from andy import leads_db; leads_db.add_lead(json.loads(${JSON.stringify(safe)})); print("OK")`
      ], { cwd: PERMIT_LEADS_DIR, windowsHide: true });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }));
      });
    });
    return;
  }

  // POST /api/add-dnc  body: {phone, source?}
  if (req.url === '/api/add-dnc' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}'); } catch { p = {}; }
      const phone = String(p.phone || '').trim();
      const source = String(p.source || 'manual').trim();
      if (!phone) { res.writeHead(400); res.end('{"error":"phone required"}'); return; }
      const { spawn } = require('child_process');
      const py = spawn('py', ['-c',
        `from andy import leads_db; leads_db.add_dnc(${JSON.stringify(phone)}, source=${JSON.stringify(source)}); print("OK")`
      ], { cwd: PERMIT_LEADS_DIR, windowsHide: true });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }));
      });
    });
    return;
  }

  // POST /api/quality-scan
  if (req.url === '/api/quality-scan' && req.method === 'POST') {
    const { spawn } = require('child_process');
    const py = spawn('py', ['-m', 'andy.quality_scan'], { cwd: PERMIT_LEADS_DIR, windowsHide: true });
    let out = '', err = '';
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('close', code => {
      res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: code === 0, stdout: out, stderr: err }));
    });
    return;
  }

  if (req.url === '/api/quality-report' && req.method === 'GET') {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PERMIT_DATA_DIR, 'quality-report.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: { scanned: 0, with_issues: 0, counts: {} }, issues: [] }));
    }
    return;
  }

  if (req.url === '/api/work-sessions') {
    // Read workspace memory files and strategy for work session data
    const sessions = [];
    const memDir = path.join(MEMORY_PROJECTS_DIR, 'system', 'System', 'Research-Archive', 'Memory');
    const stratFile = path.join(STRATEGY_DIR, 'strategy.md');
    try {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 10);
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(memDir, f), 'utf8');
          const stat = fs.statSync(path.join(memDir, f));
          sessions.push({ file: f, modified: stat.mtime, preview: content.slice(0, 300) });
        } catch {}
      }
    } catch {}
    // Also read overnight logs
    const overnightDir = path.join(MEMORY_PROJECTS_DIR, 'system', 'System', 'Research-Archive', 'Overnight');
    try {
      const files = fs.readdirSync(overnightDir).filter(f => f.endsWith('.md') || f.endsWith('.log')).sort().reverse().slice(0, 5);
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(overnightDir, f));
          const content = fs.readFileSync(path.join(overnightDir, f), 'utf8');
          sessions.push({ file: 'overnight/' + f, modified: stat.mtime, preview: content.slice(0, 300) });
        } catch {}
      }
    } catch {}
    // Strategy summary
    try {
      const strat = fs.readFileSync(stratFile, 'utf8');
      const stat = fs.statSync(stratFile);
      sessions.unshift({ file: 'strategy.md', modified: stat.mtime, preview: strat.slice(0, 500) });
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // Research config
  const RESEARCH_CONFIG = path.join(MEMORY_PROJECTS_DIR, 'system', 'System', 'Research-Archive', 'research-config.json');

  if (req.url === '/api/research-config' && req.method === 'GET') {
    try {
      const config = fs.readFileSync(RESEARCH_CONFIG, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(config);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"areas":{}}');
    }
    return;
  }

  if (req.url === '/api/research-config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(RESEARCH_CONFIG, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  if (req.url === '/api/scheduler-status') {
    try {
      const s = fs.readFileSync(path.join(__dirname, 'scheduler-status.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(s);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"areas":{}}');
    }
    return;
  }

  // P&L tracker (Keelan-editable spent/made)
  // Stored in pnl.json, written via POST. UI lets Keelan click values to edit.
  const PNL_FILE = path.join(__dirname, 'pnl.json');
  if (req.url === '/api/pnl' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(PNL_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch {
      // Default seed: $100 Claude Max baseline
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spent: 100, made: 0, updatedAt: null }));
    }
    return;
  }
  if (req.url === '/api/pnl' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const out = {
          spent: Number(data.spent) || 0,
          made: Number(data.made) || 0,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(PNL_FILE, JSON.stringify(out, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // Agent background status files
  // Heartbeat fix: Stale JSON files are common when agents forget to flip their
  // status. We self-correct by also checking worker folder mtime. If any file in
  // Workers/{Name}/ was modified within the last 10 minutes, we mark the agent
  // active regardless of what the JSON says. Keeps the JSON's task string.
  if (req.url === '/api/agent-status') {
    var statusDir = path.join(__dirname, 'agent-status');
    var HEARTBEAT_WINDOW_MS = 30 * 60 * 1000;
    var nowMs = Date.now();

    // In-memory cache with 2s TTL. Reading 15+ JSON files plus statting every
    // file in each Workers/{name}/ folder on every request was the slowness
    // Keelan saw when opening the agent panel. Cache invalidates by wall
    // clock; subsequent requests inside the window return instantly.
    if (!global._agentStatusCache) global._agentStatusCache = { ts: 0, payload: null };
    var CACHE_TTL_MS = 2000;
    if (global._agentStatusCache.payload && (nowMs - global._agentStatusCache.ts) < CACHE_TTL_MS) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(global._agentStatusCache.payload);
      return;
    }

    var statuses = {};
    try {
      var files = fs.readdirSync(statusDir).filter(function(f) { return f.endsWith('.json'); });
      for (var si = 0; si < files.length; si++) {
        try {
          var name = files[si].replace('.json', '');
          var data = JSON.parse(fs.readFileSync(path.join(statusDir, files[si]), 'utf8'));

          // Heartbeat check: look at mtimes in Workers/{name}/
          var heartbeatActive = false;
          var lastActivityMs = 0;
          try {
            var workerFolder = path.join(WORKERS_DIR, name);
            var workerFiles = fs.readdirSync(workerFolder);
            for (var wi = 0; wi < workerFiles.length; wi++) {
              try {
                var wStat = fs.statSync(path.join(workerFolder, workerFiles[wi]));
                if (wStat.mtimeMs > lastActivityMs) lastActivityMs = wStat.mtimeMs;
              } catch(e) {}
            }
            // Also include the folder mtime itself
            try {
              var folderStat = fs.statSync(workerFolder);
              if (folderStat.mtimeMs > lastActivityMs) lastActivityMs = folderStat.mtimeMs;
            } catch(e) {}
            if (lastActivityMs > 0 && (nowMs - lastActivityMs) < HEARTBEAT_WINDOW_MS) {
              heartbeatActive = true;
            }
          } catch(e) {}

          // If the heartbeat JSON explicitly says active:false, respect that
          // (Keelan stopped the agent manually). Don't let stale Worker folder
          // mtime override an explicit shutdown.
          var explicitInactive = (data.active === false);
          statuses[name] = {
            active: explicitInactive ? false : (heartbeatActive || !!data.active),
            task: data.task || '',
            task_description: data.task_description || '',
            started_at: data.started_at || '',
            last_seen: data.last_seen || '',
            subagents: data.subagents || [],
            jsonActive: !!data.active,
            heartbeatActive: heartbeatActive,
            lastActivityMs: lastActivityMs || null,
          };
        } catch(e) {}
      }
    } catch(e) {}
    var payload = JSON.stringify(statuses);
    global._agentStatusCache = { ts: nowMs, payload: payload };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
    return;
  }

  if (req.url === '/api/agents') {
    try {
      const sessions = getActiveSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      console.error(`[ERROR] /api/agents: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get agent sessions' }));
    }
    return;
  }

  // Agent detail: memory file + recent conversation
  // ---- Workers registry (loaded once, cached) ----
  if (!global._workersRegistry) {
    const regPath = path.join(require('os').homedir(), 'Desktop', 'AI', 'Memory', 'Workers', 'registry.json');
    try { global._workersRegistry = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch { global._workersRegistry = []; }
    // Reload every 60s
    setInterval(() => {
      try { global._workersRegistry = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch {}
    }, 60000);
  }

  // Serve the registry for the dashboard
  if (req.url === '/api/workers') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(global._workersRegistry || []));
    } catch (err) {
      console.error(`[ERROR] /api/workers: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get workers registry' }));
    }
    return;
  }

  if (req.url.startsWith('/api/agent-detail')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const agent = urlObj.searchParams.get('agent') || 'Tyrone';
    const result = { agent, memory: '', conversation: [] };
    const homedir = require('os').homedir();
    const workersDir = path.join(homedir, 'Desktop', 'AI', 'Memory', 'Workers');

    // Find this agent in registry
    const reg = (global._workersRegistry || []).find(w => w.name === agent);

    // Memory file: Workers/<name>/memory.md, or MEMORY.md for Tyrone
    const memFile = agent === 'Tyrone'
      ? path.join(homedir, 'Desktop', 'AI', 'Memory', 'MEMORY.md')
      : path.join(workersDir, agent, 'memory.md');
    try { result.memory = fs.readFileSync(memFile, 'utf8'); } catch { result.memory = '(memory file not found)'; }

    // Messages file: Workers/<name>/messages.md
    const msgFile = path.join(workersDir, agent, 'messages.md');
    try {
      result.messages = fs.readFileSync(msgFile, 'utf8');
      try { result.messagesMtime = fs.statSync(msgFile).mtimeMs; } catch {}
    } catch { result.messages = ''; }

    // Research log (if agent has one)
    if (reg && reg.hasResearchLog) {
      const rlFile = path.join(workersDir, agent, 'research-log.md');
      try { result.researchLog = fs.readFileSync(rlFile, 'utf8'); } catch { result.researchLog = ''; }
    }

    // Build keyword sets for transcript routing
    const allWorkers = global._workersRegistry || [];
    const agentKeywords = reg ? reg.cwdKeywords : [];
    const allOtherKeywords = allWorkers.filter(w => w.name !== agent).flatMap(w => w.cwdKeywords);

    // Find most recent transcript for this agent
    const projectsDir = path.join(homedir, '.claude', 'projects');
    try {
      const allJsonl = [];
      const projectDirs = fs.readdirSync(projectsDir).filter(d => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
      for (const pd of projectDirs) {
        const pdPath = path.join(projectsDir, pd);
        const pdLower = pd.toLowerCase();
        if (agent === 'Tyrone') {
          // Tyrone gets everything NOT claimed by another worker
          if (allOtherKeywords.some(k => pdLower.includes(k))) continue;
        } else {
          // Workers only get folders matching their keywords
          if (!agentKeywords.some(k => pdLower.includes(k))) continue;
        }
        try {
          const files = fs.readdirSync(pdPath).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const fp = path.join(pdPath, f);
            try {
              const stat = fs.statSync(fp);
              allJsonl.push({ path: fp, mtime: stat.mtimeMs });
            } catch {}
          }
        } catch {}
      }
      allJsonl.sort((a, b) => b.mtime - a.mtime);
      let totalInputTokens = 0, totalOutputTokens = 0;
      if (allJsonl.length > 0) {
        const allLines = fs.readFileSync(allJsonl[0].path, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of allLines) {
          try {
            const entry = JSON.parse(line);
            const msg = entry.message;
            if (msg && msg.usage) {
              totalInputTokens += (msg.usage.input_tokens || 0);
              totalOutputTokens += (msg.usage.output_tokens || 0);
            }
          } catch {}
        }
        const recent = allLines.slice(-60);
        for (const line of recent) {
          try {
            const entry = JSON.parse(line);
            const msg = entry.message;
            if (!msg || !msg.role) continue;
            const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;
            if (msg.role === 'user') {
              const textParts = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
              if (textParts.trim()) result.conversation.push({ role: 'user', text: textParts.trim().slice(0, 300), ts });
            } else if (msg.role === 'assistant') {
              const textParts = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
              if (textParts.trim()) result.conversation.push({ role: 'assistant', text: textParts.trim().slice(0, 400), ts });
            }
          } catch {}
        }
        result.conversation = result.conversation.slice(-12);
      }
      result.tokens = { input: totalInputTokens, output: totalOutputTokens, total: totalInputTokens + totalOutputTokens };
    } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === '/api/usage' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // ---- /api/research-files: list all research .md files across workers ----
  if (req.url === '/api/research-files' && req.method === 'GET') {
    try {
      const results = [];
      const workerDirs = fs.readdirSync(WORKERS_DIR).filter(d => {
        try { return fs.statSync(path.join(WORKERS_DIR, d)).isDirectory(); } catch { return false; }
      });
      for (const agent of workerDirs) {
        const agentDir = path.join(WORKERS_DIR, agent);
        try {
          const files = fs.readdirSync(agentDir).filter(f =>
            f.endsWith('.md') && f !== 'memory.md' && f !== 'messages.md'
          );
          for (const file of files) {
            try {
              const fp = path.join(agentDir, file);
              const stat = fs.statSync(fp);
              const content = fs.readFileSync(fp, 'utf8');
              results.push({
                agent,
                fileName: file,
                fileSize: stat.size,
                lastModified: stat.mtime.toISOString(),
                preview: content.slice(0, 200),
              });
            } catch {}
          }
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (err) {
      console.error(`[ERROR] /api/research-files: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to scan research files' }));
    }
    return;
  }

  // ---- /api/research-file: return full content of a single research file ----
  if (req.url.startsWith('/api/research-file') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const filePath = urlObj.searchParams.get('path') || '';
      // Security: validate path stays within Workers directory
      const resolved = path.resolve(WORKERS_DIR, filePath);
      if (!resolved.startsWith(WORKERS_DIR) || filePath.includes('..')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied: path outside Workers directory' }));
        return;
      }
      const content = fs.readFileSync(resolved, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err) {
      console.error(`[ERROR] /api/research-file: ${err.message}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // ---- /api/system-health: server and process health info ----
  if (req.url === '/api/system-health' && req.method === 'GET') {
    try {
      // Server uptime
      const uptimeSeconds = process.uptime();

      // Scraper status: check usage.json modification time
      let scraperStatus = 'unknown';
      let scraperLastRun = null;
      try {
        const usageStat = fs.statSync(DATA_FILE);
        scraperLastRun = usageStat.mtime.toISOString();
        const ageMs = Date.now() - usageStat.mtimeMs;
        scraperStatus = ageMs < 5 * 60 * 1000 ? 'active' : ageMs < 30 * 60 * 1000 ? 'stale' : 'inactive';
      } catch { scraperStatus = 'missing'; }

      // Watchdog status: check if scraper-watchdog process is running
      let watchdogRunning = false;
      try {
        const { execSync } = require('child_process');
        const psOut = execSync('powershell -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id,CommandLine | ConvertTo-Json"', { timeout: 5000, windowsHide: true }).toString();
        watchdogRunning = psOut.includes('scraper-watchdog');
      } catch {}

      // Active agent-status files
      let agentStatusCount = 0;
      try {
        const statusDir = path.join(__dirname, 'agent-status');
        agentStatusCount = fs.readdirSync(statusDir).filter(f => f.endsWith('.json')).length;
      } catch {}

      // Disk usage of dashboard directory
      let dashboardSizeBytes = 0;
      try {
        const { execSync } = require('child_process');
        const duOut = execSync(`powershell -Command "(Get-ChildItem -Recurse -File '${__dirname}' -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`, { timeout: 10000, windowsHide: true }).toString().trim();
        dashboardSizeBytes = parseInt(duOut) || 0;
      } catch {}

      // Node process memory
      const mem = process.memoryUsage();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptimeSeconds: Math.round(uptimeSeconds),
        uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${Math.round(uptimeSeconds % 60)}s`,
        scraper: { status: scraperStatus, lastRun: scraperLastRun },
        watchdog: { running: watchdogRunning },
        agentStatusFiles: agentStatusCount,
        dashboardDiskBytes: dashboardSizeBytes,
        dashboardDiskMB: +(dashboardSizeBytes / (1024 * 1024)).toFixed(2),
        processMemory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          rssMB: +(mem.rss / (1024 * 1024)).toFixed(2),
          heapUsedMB: +(mem.heapUsed / (1024 * 1024)).toFixed(2),
        },
      }));
    } catch (err) {
      console.error(`[ERROR] /api/system-health: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get system health' }));
    }
    return;
  }

  // ---- /api/chat-stats: office chat statistics ----
  if (req.url === '/api/chat-stats' && req.method === 'GET') {
    try {
      let msgs = [];
      try { msgs = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch {}
      if (!Array.isArray(msgs)) msgs = [];

      const totalMessages = msgs.length;

      // Messages per agent
      const perAgent = {};
      for (const m of msgs) {
        const sender = m.sender || 'unknown';
        perAgent[sender] = (perAgent[sender] || 0) + 1;
      }

      // Most active agent
      let mostActive = null;
      let maxCount = 0;
      for (const [agent, count] of Object.entries(perAgent)) {
        if (count > maxCount) { mostActive = agent; maxCount = count; }
      }

      // Messages today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayMs = todayStart.getTime();
      const messagesToday = msgs.filter(m => (m.ts || 0) >= todayMs).length;

      // Last activity
      const lastTs = msgs.length > 0 ? Math.max(...msgs.map(m => m.ts || 0)) : null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalMessages,
        messagesToday,
        messagesPerAgent: perAgent,
        mostActiveAgent: mostActive ? { name: mostActive, messageCount: maxCount } : null,
        lastActivity: lastTs ? new Date(lastTs).toISOString() : null,
      }));
    } catch (err) {
      console.error(`[ERROR] /api/chat-stats: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get chat stats' }));
    }
    return;
  }

  // Floor plan editor page
  if (req.url === '/editor') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'floor-plan-editor.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('floor-plan-editor.html not found: ' + e.message);
    }
    return;
  }

  // Floor plan data API
  if (req.url === '/api/floor-plan-data' && req.method === 'GET') {
    try {
      const fpData = fs.readFileSync(path.join(__dirname, 'floor-plan-data.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fpData);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"rooms":[],"walkableZones":[],"desks":[]}');
    }
    return;
  }

  if (req.url === '/api/floor-plan-data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const fpData = JSON.parse(body);
        fs.writeFileSync(path.join(__dirname, 'floor-plan-data.json'), JSON.stringify(fpData, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // ---- /api/lamp - audio-reactive lamp control ----
  if (req.url === '/api/lamp' && req.method === 'GET') {
    const lampDir = 'C:\\Users\\Keela\\Desktop\\AI\\Memory\\projects\\system\\System\\Scripts\\spotify-lamp';
    const pidFile = path.join(lampDir, 'lamp.pids.json');
    let running = false;
    try {
      if (fs.existsSync(pidFile)) {
        const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        const { execSync } = require('child_process');
        for (const pid of [pids.lamp, pids.monitor].filter(Boolean)) {
          try {
            const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { windowsHide: true, timeout: 2000 }).toString();
            if (out.toLowerCase().includes('python')) { running = true; break; }
          } catch {}
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running }));
    return;
  }

  if (req.url === '/api/lamp' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const lampDir = 'C:\\Users\\Keela\\Desktop\\AI\\Memory\\projects\\system\\System\\Scripts\\spotify-lamp';
      const pidFile = path.join(lampDir, 'lamp.pids.json');
      const { spawn, execSync } = require('child_process');
      let on = false;
      try { on = !!JSON.parse(body || '{}').on; } catch {}

      // Always kill existing first
      try {
        if (fs.existsSync(pidFile)) {
          const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
          for (const pid of [pids.lamp, pids.monitor].filter(Boolean)) {
            try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, timeout: 3000 }); } catch {}
          }
          try { fs.unlinkSync(pidFile); } catch {}
        }
      } catch {}

      if (!on) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false }));
        return;
      }

      const out = { lamp: null, monitor: null };
      const PY = 'C:\\Users\\Keela\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
      try {
        const m = spawn(PY, ['-u', 'source_monitor.py'], {
          cwd: lampDir, stdio: ['ignore', 'inherit', 'inherit'], detached: false, windowsHide: true, env: process.env,
        });
        m.on('error', (e) => console.error('[lamp] monitor spawn err:', e.message));
        m.unref();
        out.monitor = m.pid;
      } catch (e) { console.error('[lamp] monitor try err:', e.message); }
      try {
        const l = spawn(PY, ['-u', 'audio_lamp.py'], {
          cwd: lampDir, stdio: ['ignore', 'inherit', 'inherit'], detached: false, windowsHide: true, env: process.env,
        });
        l.on('error', (e) => console.error('[lamp] lamp spawn err:', e.message));
        l.unref();
        out.lamp = l.pid;
      } catch (e) { console.error('[lamp] lamp try err:', e.message); }
      try { fs.writeFileSync(pidFile, JSON.stringify(out)); } catch {}

      // turn down lamp off when music lamp turns ON
      try {
        const haToken = fs.readFileSync('C:\\Users\\Keela\\Desktop\\AI\\Memory\\Secrets\\ha_token.txt', 'utf8').trim();
        const https = require('https');
        const body = JSON.stringify({ entity_id: 'light.hue_white_lamp_1' });
        const req = https.request({
          hostname: 'ha.keelanodoherty.org', path: '/api/services/light/turn_off',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + haToken,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, () => {});
        req.on('error', (e) => console.error('[lamp] HA off err:', e.message));
        req.write(body); req.end();
      } catch (e) { console.error('[lamp] HA call err:', e.message); }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: !!(out.lamp), pids: out }));
    });
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('index.html not found: ' + e.message);
    }
    return;
  }

  // Serve static assets (character sprites, images, etc.)
  if (req.url.startsWith('/assets/')) {
    const safePath = req.url.split('?')[0].replace(/\.\./g, '');
    const filePath = path.join(__dirname, safePath);
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Asset not found');
    }
    return;
  }

  // Static JSON fallbacks so index.html can fetch local files directly
  if (req.url === '/usage.json' || req.url === '/usage-history.json') {
    try {
      const file = fs.readFileSync(path.join(__dirname, req.url.slice(1)), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(file);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url.includes('history') ? '[]' : '{}');
    }
    return;
  }

  // Office chat endpoints
  if (req.url === '/api/office-chat' && req.method === 'GET') {
    try {
      const msgs = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
      const last50 = msgs.slice(-50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(last50));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (req.url === '/api/office-chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (!msg.sender || !msg.text) { res.writeHead(400); res.end('{"error":"sender and text required"}'); return; }
        // Enforce 15 word limit
        const words = msg.text.trim().split(/\s+/);
        if (words.length > 15) msg.text = words.slice(0, 15).join(' ') + '...';
        msg.ts = msg.ts || Date.now();
        let msgs = [];
        try { msgs = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch {}
        msgs.push(msg);
        // Keep last 200 messages on disk
        if (msgs.length > 200) msgs = msgs.slice(-200);
        fs.writeFileSync(CHAT_FILE, JSON.stringify(msgs, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // ---- /api/session-stats: analytics session statistics ----
  if (req.url === '/api/session-stats' && req.method === 'GET') {
    try {
      const uptimeMs = Date.now() - serverStartTime;
      const uptimeSec = Math.round(uptimeMs / 1000);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = uptimeSec % 60;

      // Chat message count
      let chatMessageCount = 0;
      try {
        const msgs = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
        if (Array.isArray(msgs)) chatMessageCount = msgs.length;
      } catch {}

      // Research file count
      let researchFileCount = 0;
      try {
        const workerDirs = fs.readdirSync(WORKERS_DIR).filter(d => {
          try { return fs.statSync(path.join(WORKERS_DIR, d)).isDirectory(); } catch { return false; }
        });
        for (const agent of workerDirs) {
          try {
            const files = fs.readdirSync(path.join(WORKERS_DIR, agent)).filter(f =>
              f.endsWith('.md') && f !== 'memory.md' && f !== 'messages.md'
            );
            researchFileCount += files.length;
          } catch {}
        }
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        serverStartTime,
        uptimeMs,
        uptimeFormatted: `${h}h ${m}m ${s}s`,
        totalApiCalls: apiCallCount,
        chatMessageCount,
        researchFileCount,
      }));
    } catch (err) {
      console.error(`[ERROR] /api/session-stats: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get session stats' }));
    }
    return;
  }

  // ==================== CREED (PC HEALTH) ====================
  const CREED_DIR = path.join(require('os').homedir(), 'Desktop', 'AI', 'Personal', 'creed');
  const CREED_STATUS = path.join(__dirname, 'agent-status', 'creed.json');
  const CREED_ALERTS = path.join(CREED_DIR, 'alerts.jsonl');
  const CREED_REPORTS = path.join(CREED_DIR, 'reports');

  if (req.url === '/api/creed-status' && req.method === 'GET') {
    try {
      let status = {};
      try { status = JSON.parse(fs.readFileSync(CREED_STATUS, 'utf8')); } catch {}
      let alerts = [];
      try {
        const raw = fs.readFileSync(CREED_ALERTS, 'utf8');
        alerts = raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      // Pull ALL non-dismissed cleanup_proposals + morning_reports (these are actionable and
      // survive indefinitely), plus last 40 other alerts (monitor noise, audits, etc).
      // This keeps the Creed tab useful even when monitor spam floods the tail.
      const actionable = alerts.filter(a => !a.dismissed && (a.kind === 'cleanup_proposal' || a.kind === 'morning_report'));
      const other = alerts.filter(a => !(a.kind === 'cleanup_proposal' || a.kind === 'morning_report')).slice(-40);
      alerts = [...actionable, ...other].reverse();
      let auditMd = null;
      let auditMeta = null;
      try {
        const latest = path.join(CREED_REPORTS, 'latest.json');
        if (fs.existsSync(latest)) {
          const j = JSON.parse(fs.readFileSync(latest, 'utf8'));
          auditMeta = {
            captured_at: j.captured_at,
            health_score: j.health_score,
            verdicts: j.verdicts,
            elapsed_sec: j.elapsed_sec,
            installed_count: (j.installed_programs || []).length,
            startup_count: (j.startup || []).length,
            scheduled_tasks_count: (j.scheduled_tasks || []).length,
            disks: j.disks && j.disks.partitions,
            firewall: j.firewall,
            bitlocker: j.bitlocker,
            updates: j.updates,
            os_uptime_days: j.os && j.os.uptime_days,
            largest_desktop: j.desktop_largest,
          };
        }
        const md = path.join(CREED_REPORTS, 'latest.md');
        if (fs.existsSync(md)) auditMd = fs.readFileSync(md, 'utf8');
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status, alerts, audit: auditMeta, audit_md: auditMd }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/creed-action/run-audit' && req.method === 'POST') {
    try {
      const { spawn } = require('child_process');
      const child = spawn('py', [path.join(CREED_DIR, 'audit.py')], {
        cwd: CREED_DIR, stdio: 'ignore', detached: true, windowsHide: true,
      });
      child.unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: child.pid, msg: 'Creed: starting fresh audit. Check back in a couple minutes.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/creed-action/disk-suggest' && req.method === 'POST') {
    try {
      const desktop = path.join(require('os').homedir(), 'Desktop');
      const items = [];
      let entries = [];
      try { entries = fs.readdirSync(desktop, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        try {
          const full = path.join(desktop, e.name);
          if (e.isFile()) {
            const st = fs.statSync(full);
            items.push({ name: e.name, type: 'file', size_mb: +(st.size / 1048576).toFixed(2) });
          } else if (e.isDirectory()) {
            // shallow walk - top-level size sum (1 level deep) for speed
            let total = 0;
            try {
              const inner = fs.readdirSync(full, { withFileTypes: true });
              for (const ie of inner) {
                try {
                  const st = fs.statSync(path.join(full, ie.name));
                  total += st.size;
                } catch {}
              }
            } catch {}
            items.push({ name: e.name, type: 'dir', size_mb: +(total / 1048576).toFixed(2) });
          }
        } catch {}
      }
      items.sort((a, b) => b.size_mb - a.size_mb);
      const top = items.slice(0, 25);
      const suggestions = top.filter(i => i.size_mb > 50).map(i => ({
        name: i.name,
        size_mb: i.size_mb,
        suggestion: i.type === 'dir'
          ? `Folder is ${i.size_mb} MB. Consider archiving to OneDrive or external drive (do not delete without checking).`
          : `File is ${i.size_mb} MB. Consider moving to OneDrive if rarely used.`
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        creed_msg: suggestions.length
          ? "Creed: Found some big stuff on your desktop. I would not delete it. Just move it."
          : "Creed: Desktop looks pretty lean. Nothing big to worry about.",
        items: top, suggestions
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Approve/deny a Creed cleanup_proposal. NEVER auto-executes (master protocol §4).
  // "approve" flags the alert; destructive action goes into pending-actions.jsonl
  // for Keelan to run via the dedicated executor script.
  if ((req.url === '/api/creed-alert/approve' || req.url === '/api/creed-alert/deny') && req.method === 'POST') {
    const isApprove = req.url.endsWith('/approve');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body || '{}');
        if (!id) { res.writeHead(400); res.end('{"error":"id required"}'); return; }
        const lines = fs.existsSync(CREED_ALERTS) ? fs.readFileSync(CREED_ALERTS, 'utf8').split(/\r?\n/) : [];
        const out = []; let matched = null;
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const o = JSON.parse(ln);
            if (o.id === id) {
              o.decision = isApprove ? 'approved' : 'denied';
              o.decided_at = new Date().toISOString();
              o.dismissed = true;
              matched = o;
            }
            out.push(JSON.stringify(o));
          } catch { out.push(ln); }
        }
        fs.writeFileSync(CREED_ALERTS, out.join('\n') + '\n', 'utf8');
        if (matched && matched.proposed_action) {
          // Persistent decision log so the emitter never re-proposes this pair.
          const file = path.join(CREED_DIR, isApprove ? 'pending-actions.jsonl' : 'denied-actions.jsonl');
          fs.appendFileSync(file, JSON.stringify({
            ts: new Date().toISOString(),
            id: matched.id,
            kind: matched.kind,
            action: matched.proposed_action,
            target: matched.target,
            msg: matched.msg,
            reasoning: matched.reasoning || '',
          }) + '\n', 'utf8');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, decision: isApprove ? 'approved' : 'denied' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Approved queue - things Keelan has approved but not yet executed.
  if (req.url === '/api/creed-pending' && req.method === 'GET') {
    try {
      const p = path.join(CREED_DIR, 'pending-actions.jsonl');
      const c = path.join(CREED_DIR, 'completed-actions.jsonl');
      const completedIds = new Set();
      if (fs.existsSync(c)) {
        for (const ln of fs.readFileSync(c, 'utf8').split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try { completedIds.add(JSON.parse(ln).id); } catch {}
        }
      }
      const out = [];
      if (fs.existsSync(p)) {
        for (const ln of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try {
            const o = JSON.parse(ln);
            if (!completedIds.has(o.id)) out.push(o);
          } catch {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: out }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Completed archive - things Keelan confirmed as done.
  if (req.url === '/api/creed-completed' && req.method === 'GET') {
    try {
      const c = path.join(CREED_DIR, 'completed-actions.jsonl');
      const out = [];
      if (fs.existsSync(c)) {
        for (const ln of fs.readFileSync(c, 'utf8').split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try { out.push(JSON.parse(ln)); } catch {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ completed: out.reverse() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Mark a pending action as complete. Snapshots current metrics so impact
  // can be tracked in /api/creed-metrics.
  if (req.url === '/api/creed-pending/complete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body || '{}');
        if (!id) { res.writeHead(400); res.end('{"error":"id required"}'); return; }
        const pFile = path.join(CREED_DIR, 'pending-actions.jsonl');
        const cFile = path.join(CREED_DIR, 'completed-actions.jsonl');
        let found = null;
        if (fs.existsSync(pFile)) {
          for (const ln of fs.readFileSync(pFile, 'utf8').split(/\r?\n/)) {
            if (!ln.trim()) continue;
            try {
              const o = JSON.parse(ln);
              if (o.id === id) { found = o; break; }
            } catch {}
          }
        }
        if (!found) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
        // capture current live metric snapshot
        let snapshot = {};
        try { snapshot = JSON.parse(fs.readFileSync(CREED_STATUS, 'utf8')); } catch {}
        const rec = Object.assign({}, found, {
          completed_at: new Date().toISOString(),
          snapshot_at_completion: {
            cpu_pct: snapshot.cpu_pct,
            ram_pct: snapshot.ram_pct,
            ram_used_gb: snapshot.ram_used_gb,
            disk_c_free_gb: snapshot.disk_c_free_gb,
            disk_c_free_pct: snapshot.disk_c_free_pct,
            uptime_days: snapshot.uptime_days,
            health_score: snapshot.health_score,
            top_process_count: (snapshot.top_processes || []).length,
          },
        });
        fs.appendFileSync(cFile, JSON.stringify(rec) + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Impact metrics - baseline (first completion or baseline.json) vs current.
  if (req.url === '/api/creed-metrics' && req.method === 'GET') {
    try {
      const baselinePath = path.join(CREED_DIR, 'baseline.json');
      const cFile = path.join(CREED_DIR, 'completed-actions.jsonl');
      let baseline = null;
      if (fs.existsSync(baselinePath)) {
        try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch {}
      }
      let firstCompleted = null;
      if (fs.existsSync(cFile)) {
        for (const ln of fs.readFileSync(cFile, 'utf8').split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try { firstCompleted = JSON.parse(ln); break; } catch {}
        }
      }
      const basis = baseline || (firstCompleted && firstCompleted.snapshot_at_completion) || null;
      let current = {};
      try { current = JSON.parse(fs.readFileSync(CREED_STATUS, 'utf8')); } catch {}
      const cur = {
        cpu_pct: current.cpu_pct,
        ram_pct: current.ram_pct,
        ram_used_gb: current.ram_used_gb,
        disk_c_free_gb: current.disk_c_free_gb,
        disk_c_free_pct: current.disk_c_free_pct,
        uptime_days: current.uptime_days,
        health_score: current.health_score,
      };
      // completed count + total size reclaimed (rough, sum from pending snapshots)
      let completedCount = 0; let reclaimedMb = 0; const byAction = {};
      if (fs.existsSync(cFile)) {
        for (const ln of fs.readFileSync(cFile, 'utf8').split(/\r?\n/)) {
          if (!ln.trim()) continue;
          try {
            const o = JSON.parse(ln);
            completedCount += 1;
            byAction[o.action] = (byAction[o.action] || 0) + 1;
            // look up original alert for size_mb
            // (cheap: keep running sum only if we have it)
            // size_mb may live in reasoning; skip precise number here
          } catch {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        baseline: basis,
        current: cur,
        completed_count: completedCount,
        completed_by_action: byAction,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // One-shot: set (or reset) the baseline snapshot. Keelan calls this when
  // he wants to pin "this is before the cleanup" for impact tracking.
  if (req.url === '/api/creed-baseline/set' && req.method === 'POST') {
    try {
      let snapshot = {};
      try { snapshot = JSON.parse(fs.readFileSync(CREED_STATUS, 'utf8')); } catch {}
      const base = {
        captured_at: new Date().toISOString(),
        cpu_pct: snapshot.cpu_pct,
        ram_pct: snapshot.ram_pct,
        ram_used_gb: snapshot.ram_used_gb,
        disk_c_free_gb: snapshot.disk_c_free_gb,
        disk_c_free_pct: snapshot.disk_c_free_pct,
        uptime_days: snapshot.uptime_days,
        health_score: snapshot.health_score,
      };
      fs.writeFileSync(path.join(CREED_DIR, 'baseline.json'), JSON.stringify(base, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, baseline: base }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/creed-alert/dismiss' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body || '{}');
        if (!id) { res.writeHead(400); res.end('{"error":"id required"}'); return; }
        const lines = fs.existsSync(CREED_ALERTS) ? fs.readFileSync(CREED_ALERTS, 'utf8').split(/\r?\n/) : [];
        const out = [];
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const o = JSON.parse(ln);
            if (o.id === id) o.dismissed = true;
            out.push(JSON.stringify(o));
          } catch { out.push(ln); }
        }
        fs.writeFileSync(CREED_ALERTS, out.join('\n') + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: req.url }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, attempting to kill old process...`);
    try {
      require('child_process').execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', timeout: 5000, windowsHide: true }
      );
    } catch {}
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 2000);
  } else {
    console.error('Server error:', err);
  }
});

// ---- Scraper Watchdog ----
function startWatchdog() {
  const { spawn } = require('child_process');
  const watchdogScript = path.join(__dirname, 'scraper-watchdog.js');
  try {
    if (!fs.existsSync(watchdogScript)) {
      console.log('[SERVER] scraper-watchdog.js not found, skipping watchdog.');
      return;
    }
    const child = spawn('node', [watchdogScript], {
      cwd: __dirname,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
    console.log(`[SERVER] Scraper watchdog started (PID ${child.pid})`);
  } catch (err) {
    console.log('[SERVER] Failed to start watchdog: ' + err.message);
  }
}

// ---- Creed PC monitor ----
function startCreed() {
  const { spawn, execSync } = require('child_process');
  const creedDir = path.join(require('os').homedir(), 'Desktop', 'AI', 'Personal', 'creed');
  const monitorScript = path.join(creedDir, 'monitor.py');
  const pidFile = path.join(creedDir, 'monitor.pid');
  try {
    if (!fs.existsSync(monitorScript)) {
      console.log('[SERVER] Creed monitor.py not found, skipping.');
      return;
    }
    // check existing pid
    if (fs.existsSync(pidFile)) {
      try {
        const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (oldPid) {
          const out = execSync(`tasklist /FI "PID eq ${oldPid}" /NH`, { windowsHide: true, timeout: 3000 }).toString();
          if (out.includes(String(oldPid)) && out.toLowerCase().includes('python')) {
            console.log(`[SERVER] Creed monitor already running (PID ${oldPid})`);
            return;
          }
        }
      } catch {}
    }
    const child = spawn('py', [monitorScript], {
      cwd: creedDir, stdio: 'ignore', detached: true, windowsHide: true,
    });
    child.unref();
    console.log(`[SERVER] Creed monitor started (PID ${child.pid})`);
  } catch (err) {
    console.log('[SERVER] Failed to start Creed: ' + err.message);
  }
}

const serverReady = new Promise((resolve) => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Dashboard running at http://localhost:${PORT}`);
    startWatchdog();
    startCreed();
    resolve();
  });
});

module.exports = { serverReady };
