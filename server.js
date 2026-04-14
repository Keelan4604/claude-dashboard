const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const DATA_FILE = path.join(__dirname, 'usage.json');
const SESSIONS_DIR = path.join(require('os').homedir(), '.claude', 'sessions');
const AI_DIR = path.join(require('os').homedir(), 'Desktop', 'AI');

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

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/usage' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readUsage()));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(optimizerStatus));
    return;
  }

  if (req.url === '/api/leads') {
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

  if (req.url === '/api/work-sessions') {
    // Read workspace memory files and strategy for work session data
    const sessions = [];
    const memDir = path.join(AI_DIR, 'Research-Archive', 'Memory');
    const stratFile = path.join(AI_DIR, 'Website-Business', 'Strategy', 'strategy.md');
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
    const overnightDir = path.join(AI_DIR, 'Research-Archive', 'Overnight');
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
  const RESEARCH_CONFIG = path.join(AI_DIR, 'Research-Archive', 'research-config.json');

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

  if (req.url === '/api/agents') {
    const sessions = getActiveSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
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

  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, killing old process and retrying...`);
    require('child_process').execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${PORT}') do taskkill /F /PID %a`, { shell: 'cmd.exe', stdio: 'ignore' });
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 1000);
  } else {
    console.error('Server error:', err);
  }
});

const serverReady = new Promise((resolve) => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Dashboard running at http://localhost:${PORT}`);
    resolve();
  });
});

module.exports = { serverReady };
