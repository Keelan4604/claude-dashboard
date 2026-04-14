/**
 * Usage Scraper - Scrapes claude.ai/settings/usage for real usage data.
 *
 * Uses puppeteer-core with a DEDICATED Chrome profile directory
 * at ./scraper-chrome-data/. This profile is separate from the user's
 * main Chrome, so it can run headless without conflicting.
 *
 * FIRST-TIME SETUP:
 *   node usage-scraper.js --login
 *   (Opens a visible Chrome window. Log into claude.ai manually, then close.)
 *
 * After login, the scraper runs headless using the saved session.
 */

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, 'usage.json');
const PUBLIC_USAGE_FILE = path.join(__dirname, 'public', 'usage.json');
const HISTORY_FILE = path.join(__dirname, 'usage-history.json');
const SCRAPE_INTERVAL = 5 * 60 * 1000;
const SETTINGS_URL = 'https://claude.ai/settings/usage';
const CHROME_PATH = path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const SCRAPER_DATA_DIR = path.join(__dirname, 'scraper-chrome-data');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [SCRAPER] ${msg}`);
}

function writeUsage(data) {
  data.scrapedAt = Date.now();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(USAGE_FILE, json);
  try { fs.writeFileSync(PUBLIC_USAGE_FILE, json); } catch {}
  log('Wrote: session=' + data.session.pct + '% weekly=' + data.weeklyAll.pct + '% sonnet=' + data.sonnet.pct + '%');
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
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  history = history.filter(h => h.t > cutoff);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

const PARSE_SCRIPT = `(function() {
  var text = document.body.innerText;

  var sm = text.match(/Current session[\\s\\S]*?Resets in (\\d+ hr \\d+ min|\\d+ hr|\\d+ min)[\\s]*(\\d+)% used/);
  var sessionPct = sm ? parseInt(sm[2]) : null;
  var sessionReset = sm ? 'Resets in ' + sm[1] : null;
  if (sessionPct === null) {
    var sa = text.match(/Current session[\\s\\S]*?Resets in ([^]*?\\d+ (?:hr \\d+ )?min|\\d+ hr)[\\s\\S]*?(\\d+)% used/);
    if (sa) { sessionPct = parseInt(sa[2]); sessionReset = 'Resets in ' + sa[1]; }
  }

  var wm = text.match(/All models[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)(\\d+)% used/);
  var weeklyPct = wm ? parseInt(wm[2]) : null;
  var weeklyReset = wm ? 'Resets ' + wm[1] : null;
  if (weeklyPct === null) {
    var wa = text.match(/All models[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)[\\s]*(\\d+)% used/);
    if (wa) { weeklyPct = parseInt(wa[2]); weeklyReset = 'Resets ' + wa[1]; }
  }

  var snm = text.match(/Sonnet only[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)(\\d+)% used/);
  var sonnetPct = snm ? parseInt(snm[2]) : null;
  var sonnetReset = snm ? 'Resets ' + snm[1] : null;
  if (sonnetPct === null) {
    var sna = text.match(/Sonnet only[\\s\\S]*?Resets (\\w+ \\d+:\\d+\\s*[AP]M)[\\s]*(\\d+)% used/);
    if (sna) { sonnetPct = parseInt(sna[2]); sonnetReset = 'Resets ' + sna[1]; }
  }

  var spm = text.match(/\\$([\\d.]+)\\s*spent/);
  var spent = spm ? parseFloat(spm[1]) : 0;
  var lm = text.match(/\\$([\\d.]+)\\s*Monthly spend limit/) || text.match(/\\$([\\d.]+)Monthly spend limit/);
  var limit = lm ? parseFloat(lm[1]) : 30;
  var bm = text.match(/\\$([\\d.]+)\\s*Current balance/) || text.match(/\\$([\\d.]+)Current balance/);
  var balance = bm ? parseFloat(bm[1]) : 0;

  var srm = text.match(/spent[\\s\\S]*?Resets (\\w+ \\d+)[\\s]*(\\d+)% used/) || text.match(/spentResets (\\w+) (\\d+?)(\\d{1,3})% used/);
  var spendReset = '';
  if (srm) {
    spendReset = 'Resets ' + srm[1];
  }

  var debug = (sessionPct === null || weeklyPct === null) ? text.slice(0, 800) : null;

  return {
    session: { pct: sessionPct, reset: sessionReset },
    weeklyAll: { pct: weeklyPct, reset: weeklyReset },
    sonnet: { pct: sonnetPct, reset: sonnetReset },
    spending: {
      spent: spent, limit: limit, balance: balance,
      pct: limit > 0 ? Math.min(100, Math.round(spent/limit*100)) : 0,
      reset: spendReset
    },
    _debug: debug
  };
})()`;

// ============ Login Mode ============

async function loginMode() {
  const puppeteer = require('puppeteer-core');
  log('Opening Chrome for login. Please log into claude.ai, then close the browser.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,  // Visible!
    userDataDir: SCRAPER_DATA_DIR,
    args: ['--no-first-run', '--disable-extensions'],
    defaultViewport: null,
    timeout: 0,
  });

  const page = await browser.newPage();
  await page.goto('https://claude.ai/login', { waitUntil: 'networkidle2', timeout: 60000 });

  log('Browser opened. Log in and close the window when done.');
  log('The session will be saved to: ' + SCRAPER_DATA_DIR);

  // Wait for browser to close
  await new Promise(resolve => browser.on('disconnected', resolve));
  log('Browser closed. Session saved. You can now run the scraper normally.');
}

// ============ Scrape Mode ============

async function scrape() {
  const puppeteer = require('puppeteer-core');

  // Check if scraper profile exists
  if (!fs.existsSync(SCRAPER_DATA_DIR)) {
    log('No scraper profile found. Run with --login first:');
    log('  node usage-scraper.js --login');
    return;
  }

  // Clean up stale lock files from crashed Chrome
  const lockFile = path.join(SCRAPER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    log('Removing stale SingletonLock...');
    try { fs.unlinkSync(lockFile); } catch {}
  }

  try {
    log('Launching headless Chrome...');
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      userDataDir: SCRAPER_DATA_DIR,
      args: [
        '--no-first-run',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.178 Safari/537.36',
      ],
      timeout: 20000,
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      log('Navigating to settings/usage...');
      await page.goto(SETTINGS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      const url = page.url();
      if (url.includes('login') || url.includes('oauth')) {
        log('Session expired - redirected to login. Run: node usage-scraper.js --login');
        await page.close();
        return;
      }

      await page.waitForFunction(
        () => document.body.innerText.includes('% used'),
        { timeout: 15000 }
      ).catch(() => log('Warning: "% used" not found on page'));

      await new Promise(r => setTimeout(r, 2000));

      const data = await page.evaluate(PARSE_SCRIPT);
      await page.close();

      if (data._debug) log('DEBUG: ' + data._debug);
      delete data._debug;

      if (data.session.pct !== null) {
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}

        const merged = {
          session: data.session.pct !== null ? data.session : (existing.session || { pct: 0, reset: '-' }),
          weeklyAll: data.weeklyAll.pct !== null ? data.weeklyAll : (existing.weeklyAll || { pct: 0, reset: '-' }),
          sonnet: data.sonnet.pct !== null ? data.sonnet : (existing.sonnet || { pct: 0, reset: '-' }),
          spending: data.spending.spent > 0 ? data.spending : (existing.spending || { spent: 0, limit: 30, balance: 0, pct: 0, reset: '' }),
        };

        writeUsage(merged);
        log('Scrape successful');
      } else {
        log('Scrape returned null session data');
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    log('Scrape failed: ' + err.message);
  }
}

// ============ Entry Point ============

const isLogin = process.argv.includes('--login');

if (isLogin) {
  loginMode().catch(e => { log('Login error: ' + e.message); process.exit(1); });
} else {
  log('Usage scraper started. Every ' + (SCRAPE_INTERVAL / 60000) + 'min.');
  log('Profile: ' + SCRAPER_DATA_DIR);
  scrape();
  setInterval(scrape, SCRAPE_INTERVAL);
}

module.exports = { scrape };
