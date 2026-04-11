/**
 * Usage Scraper - Periodically scrapes claude.ai/settings for real usage data
 * and writes it to usage.json so the dashboard always has fresh numbers.
 *
 * Connects to Chrome via DevTools Protocol (port 9222).
 * Chrome must be running with: --remote-debugging-port=9222
 *
 * Runs every 5 minutes. Also updates on first launch.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, 'usage.json');
const PUBLIC_USAGE_FILE = path.join(__dirname, 'public', 'usage.json');
const HISTORY_FILE = path.join(__dirname, 'usage-history.json');
const CDP_PORT = 9222;
const SCRAPE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SETTINGS_URL = 'https://claude.ai/settings/usage';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [SCRAPER] ${msg}`);
}

function writeUsage(data) {
  data.scrapedAt = Date.now();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(USAGE_FILE, json);
  try { fs.writeFileSync(PUBLIC_USAGE_FILE, json); } catch {}
  log('Wrote usage.json: session=' + data.session.pct + '%, weekly=' + data.weeklyAll.pct + '%');

  // Append to history
  appendHistory(data);
}

function appendHistory(data) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}

  history.push({
    t: Date.now(),
    session: data.session.pct,
    weekly: data.weeklyAll.pct,
    sonnet: data.sonnet.pct,
    spent: data.spending.spent
  });

  // Keep last 7 days (7 * 24 * 12 = 2016 points at 5-min intervals)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  history = history.filter(h => h.t > cutoff);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

// Talk to Chrome DevTools Protocol
function cdpRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// Send a CDP command over WebSocket
function cdpCommand(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const id = Date.now();
    let resolved = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.id === id) {
          resolved = true;
          ws.close();
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        }
      } catch {}
    });

    ws.on('error', (err) => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) {
        ws.close();
        reject(new Error('CDP command timeout'));
      }
    }, 15000);
  });
}

// Use CDP to navigate and scrape the page
async function scrapeWithCDP(wsUrl) {
  const WebSocket = require('ws');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = {};
    let resolved = false;

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((res, rej) => {
        pending[id] = { resolve: res, reject: rej };
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id && pending[msg.id]) {
          if (msg.error) pending[msg.id].reject(new Error(msg.error.message));
          else pending[msg.id].resolve(msg.result);
          delete pending[msg.id];
        }
      } catch {}
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });

    ws.on('open', async () => {
      try {
        // Navigate to settings
        await send('Page.enable');
        await send('Page.navigate', { url: SETTINGS_URL });

        // Wait for page to load
        await new Promise(r => setTimeout(r, 5000));

        // Execute JS to scrape usage data from the page
        // Actual page text looks like (concatenated, no spaces between sections):
        // "...Current sessionResets in 2 hr 53 min97% usedWeekly limits...All modelsResets Wed 8:00 PM43% usedSonnet onlyResets Wed 8:00 PM7% used...
        //  $30.15 spentResets May 1100% used$30Monthly spend limit...$90.62Current balance..."
        const result = await send('Runtime.evaluate', {
          expression: `
            (function() {
              var text = document.body.innerText;

              // Parse "Current session" - text runs together: "Current sessionResets in X hr Y min##% used"
              var sessionMatch = text.match(/Current session[\\s\\S]*?Resets in (\\d+ hr \\d+ min|\\d+ min)(\\d+)% used/);
              var sessionPct = sessionMatch ? parseInt(sessionMatch[2]) : null;
              var sessionReset = sessionMatch ? 'Resets in ' + sessionMatch[1] : null;

              // Fallback: try with whitespace/newlines between parts
              if (sessionPct === null) {
                var alt = text.match(/Current session[\\s\\S]*?Resets in (\\d+ hr \\d+ min|\\d+ min)[\\s\\S]*?(\\d+)% used/);
                if (alt) { sessionPct = parseInt(alt[2]); sessionReset = 'Resets in ' + alt[1]; }
              }

              // Parse "All models" - "All modelsResets Wed 8:00 PM43% used"
              var weeklyMatch = text.match(/All models[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)[\\s\\S]*?(\\d+)% used/);
              var weeklyPct = weeklyMatch ? parseInt(weeklyMatch[2]) : null;
              var weeklyReset = weeklyMatch ? 'Resets ' + weeklyMatch[1] : null;

              // Parse "Sonnet only" - "Sonnet onlyResets Wed 8:00 PM7% used"
              var sonnetMatch = text.match(/Sonnet only[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)[\\s\\S]*?(\\d+)% used/);
              var sonnetPct = sonnetMatch ? parseInt(sonnetMatch[2]) : null;
              var sonnetReset = sonnetMatch ? 'Resets ' + sonnetMatch[1] : null;

              // Parse spending - "$30.15 spent"
              var spentMatch = text.match(/\\$([\\.\\d]+)\\s*spent/);
              var spent = spentMatch ? parseFloat(spentMatch[1]) : 0;
              // "$30" followed eventually by "Monthly spend limit"
              var limitMatch = text.match(/\\$(\\d+)[\\s\\S]*?Monthly spend limit/);
              var limit = limitMatch ? parseInt(limitMatch[1]) : 30;
              // "$90.62" followed by "Current balance"
              var balMatch = text.match(/\\$([\\.\\d]+)[\\s\\S]*?Current balance/);
              var balance = balMatch ? parseFloat(balMatch[1]) : 0;
              // "Resets May 1" (spending reset, after "spent")
              var spendResetMatch = text.match(/spent[\\s\\S]*?Resets (\\w+ \\d+)/);
              var spendReset = spendResetMatch ? 'Resets ' + spendResetMatch[1] : '';

              return JSON.stringify({
                session: { pct: sessionPct, reset: sessionReset },
                weeklyAll: { pct: weeklyPct, reset: weeklyReset },
                sonnet: { pct: sonnetPct, reset: sonnetReset },
                spending: {
                  spent: spent, limit: limit, balance: balance,
                  pct: limit > 0 ? Math.min(100, Math.round(spent/limit*100)) : 0,
                  reset: spendReset
                }
              });
            })()
          `,
          returnByValue: true
        });

        ws.close();
        resolved = true;

        if (result && result.result && result.result.value) {
          resolve(JSON.parse(result.result.value));
        } else {
          reject(new Error('Could not parse usage from page'));
        }
      } catch (err) {
        ws.close();
        if (!resolved) { resolved = true; reject(err); }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('Scrape timeout (30s)'));
      }
    }, 30000);
  });
}

async function scrape() {
  try {
    // Check if Chrome DevTools is available
    const pages = await cdpRequest('/json');
    log('Chrome DevTools connected, found ' + pages.length + ' pages');

    // Find an existing claude.ai tab or use the first tab
    let target = pages.find(p => p.url && p.url.includes('claude.ai'));
    if (!target) {
      // Create a new tab
      target = await cdpRequest('/json/new?' + encodeURIComponent(SETTINGS_URL));
      log('Opened new tab for claude.ai/settings');
    }

    if (!target || !target.webSocketDebuggerUrl) {
      log('No suitable Chrome tab found');
      return;
    }

    const data = await scrapeWithCDP(target.webSocketDebuggerUrl);

    // Only update if we got valid data
    if (data.session.pct !== null) {
      // Read existing data to preserve fields we didn't scrape
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}

      const merged = {
        session: data.session.pct !== null ? data.session : (existing.session || { pct: 0, reset: '-' }),
        weeklyAll: data.weeklyAll.pct !== null ? data.weeklyAll : (existing.weeklyAll || { pct: 0, reset: '-' }),
        sonnet: data.sonnet.pct !== null ? data.sonnet : (existing.sonnet || { pct: 0, reset: '-' }),
        spending: data.spending.spent > 0 ? data.spending : (existing.spending || { spent: 0, limit: 30, balance: 0, pct: 0, reset: '' }),
      };

      writeUsage(merged);
    } else {
      log('Scrape returned null session data, skipping update');
    }
  } catch (err) {
    log('Scrape failed: ' + err.message);
    // Not fatal - we just keep the old data
  }
}

// Install ws if needed
try {
  require('ws');
} catch {
  log('Installing ws package...');
  require('child_process').execSync('npm install ws', { cwd: __dirname, stdio: 'pipe' });
  log('ws installed');
}

// Start
log('Usage scraper started. Scraping every ' + (SCRAPE_INTERVAL / 60000) + ' minutes.');
log('Requires Chrome with --remote-debugging-port=' + CDP_PORT);

// Initial scrape
scrape();

// Periodic scrape
setInterval(scrape, SCRAPE_INTERVAL);

module.exports = { scrape };
