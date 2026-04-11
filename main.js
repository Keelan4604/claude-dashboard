const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { serverReady } = require('./server.js');

const PORT = 3847;
const DATA_FILE = path.join(__dirname, 'usage.json');
const SETTINGS_URL = 'https://claude.ai/settings/usage';
const LOG_FILE = path.join(__dirname, 'scraper.log');

let mainWindow;
let scraperWindow;
let loginShown = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 400,
    minHeight: 400,
    title: 'Claude Usage',
    backgroundColor: '#0d0d11',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d11', symbolColor: '#71717a', height: 36 },
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
    show: false,
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createScraper() {
  scraperWindow = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    title: 'Claude Usage Sync (log in to activate)',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:claude-usage-scraper',
    },
  });
  scraperWindow.on('closed', () => { scraperWindow = null; loginShown = false; });
}

async function scrapeUsage() {
  if (!scraperWindow) createScraper();

  try {
    log('Loading ' + SETTINGS_URL);
    await scraperWindow.loadURL(SETTINGS_URL);
    await new Promise(r => setTimeout(r, 5000));

    const currentUrl = scraperWindow.webContents.getURL();
    log('Current URL after load: ' + currentUrl);

    // Check if we're on the login page
    if (currentUrl.includes('login') || currentUrl.includes('oauth') || currentUrl.includes('auth')) {
      log('Not logged in - showing login window');
      showLoginWindow();
      return;
    }

    const text = await scraperWindow.webContents.executeJavaScript(`document.body.innerText`);
    log('Page text length: ' + text.length);

    // Save raw text for debugging
    fs.writeFileSync(path.join(__dirname, 'last-scrape.txt'), text);

    // Check if Cloudflare blocked us
    if (text.includes('Just a moment') || text.includes('Enable JavaScript and cookies') || text.length < 200) {
      log('Cloudflare block or short page - showing window for manual auth');
      showLoginWindow();
      return;
    }

    // Check if we got the settings page
    if (!text.includes('usage') && !text.includes('session') && !text.includes('plan')) {
      log('Page does not look like usage page. Text preview: ' + text.slice(0, 200));
      showLoginWindow();
      return;
    }

    const data = parseUsageText(text);
    if (data) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      log('Updated usage.json successfully');
      // Hide scraper if it was shown
      if (scraperWindow.isVisible()) scraperWindow.hide();
    } else {
      log('Parse returned null - check last-scrape.txt for page content');
    }
  } catch (err) {
    log('Scrape error: ' + err.message);
  }
}

function showLoginWindow() {
  if (!scraperWindow) createScraper();
  if (!loginShown) {
    loginShown = true;
    scraperWindow.setTitle('Log into Claude to enable usage sync');
    scraperWindow.center();
    scraperWindow.show();

    scraperWindow.webContents.on('did-navigate', (e, url) => {
      log('Navigated to: ' + url);
      // Once past login, try scraping
      if (url.includes('claude.ai') && !url.includes('login') && !url.includes('oauth')) {
        setTimeout(async () => {
          // Navigate directly to usage page
          try {
            await scraperWindow.loadURL(SETTINGS_URL);
            await new Promise(r => setTimeout(r, 4000));
            const text = await scraperWindow.webContents.executeJavaScript(`document.body.innerText`);
            log('Post-login scrape, text length: ' + text.length);
            fs.writeFileSync(path.join(__dirname, 'last-scrape.txt'), text);
            const data = parseUsageText(text);
            if (data) {
              fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
              log('Post-login update success');
              scraperWindow.hide();
              loginShown = false;
            }
          } catch (e) { log('Post-login scrape error: ' + e.message); }
        }, 2000);
      }
    });
  }
}

function parseUsageText(text) {
  try {
    const data = {
      session: { pct: 0, reset: 'no data' },
      weeklyAll: { pct: 0, reset: '' },
      sonnet: { pct: 0, reset: '' },
      spending: { spent: 0, limit: 30, balance: 0, pct: 0, reset: '' },
    };

    // Normalize: collapse multiple newlines, trim whitespace
    const t = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');

    // Current session
    let m;
    m = t.match(/Current session\s*\n([^\n]*)\n[\s\S]*?(\d+)%\s*used/i);
    if (m) { data.session.reset = m[1].trim(); data.session.pct = parseInt(m[2]); }

    // All models weekly
    m = t.match(/All models\s*\n([^\n]*)\n[\s\S]*?(\d+)%\s*used/i);
    if (m) { data.weeklyAll.reset = m[1].trim(); data.weeklyAll.pct = parseInt(m[2]); }

    // Sonnet only
    m = t.match(/Sonnet only[\s\S]*?\n([^\n]*Resets[^\n]*)\n[\s\S]*?(\d+)%\s*used/i);
    if (!m) m = t.match(/Sonnet only\s*\n([^\n]*)\n[\s\S]*?(\d+)%\s*used/i);
    if (m) { data.sonnet.reset = m[1].trim(); data.sonnet.pct = parseInt(m[2]); }

    // Extract all % used occurrences with their labels
    const pctMatches = [...t.matchAll(/(\d+)%\s*used/gi)];
    log('Found % matches: ' + pctMatches.map(x => x[1]).join(', '));

    // Spending
    m = t.match(/\$([0-9.]+)\s*spent/i);
    if (m) data.spending.spent = parseFloat(m[1]);

    m = t.match(/Resets\s+(May\s+\d+|[A-Za-z]+\s+\d+)/i);
    if (m) data.spending.reset = 'Resets ' + m[1].trim();

    // Find spending % - look for last % used that correlates with spending section
    m = t.match(/spent[\s\S]{0,200}?(\d+)%\s*used/i);
    if (m) data.spending.pct = parseInt(m[1]);

    m = t.match(/\$(\d+)\s*\n[^\n]*Monthly spend limit/i);
    if (!m) m = t.match(/Monthly spend limit[\s\S]{0,50}?\$(\d+)/i);
    if (!m) m = t.match(/\$(\d+)[^\n]*\nMonthly spend limit/i);
    if (m) data.spending.limit = parseInt(m[1]);

    m = t.match(/\$([0-9.]+)\s*\n[^\n]*Current balance/i);
    if (!m) m = t.match(/Current balance[\s\S]{0,50}?\$([0-9.]+)/i);
    if (m) data.spending.balance = parseFloat(m[1]);

    log('Parsed: session=' + data.session.pct + '% weekly=' + data.weeklyAll.pct + '% spent=$' + data.spending.spent);

    const hasData = data.session.pct > 0 || data.weeklyAll.pct > 0 || data.spending.spent > 0 || data.spending.balance > 0;
    return hasData ? data : null;
  } catch (err) {
    log('Parse error: ' + err.message);
    return null;
  }
}

app.whenReady().then(async () => {
  log('App ready, waiting for server...');
  await serverReady;
  log('Server ready, creating window');
  createWindow();
  setTimeout(scrapeUsage, 3000);
  setInterval(scrapeUsage, 90000); // every 90 seconds
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
