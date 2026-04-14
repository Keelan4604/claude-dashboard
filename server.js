// Local dashboard server - NOT used by Cloudflare Pages
// Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3847;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Research config path
const RESEARCH_CONFIG = path.join(__dirname, '..', 'AI', 'Research-Archive', 'research-config.json');

const server = http.createServer((req, res) => {
  // API: research config
  if (req.url === '/api/research-config' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(RESEARCH_CONFIG, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end('{}');
    }
    return;
  }

  if (req.url === '/api/research-config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        fs.writeFileSync(RESEARCH_CONFIG, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(500);
        res.end('{"error":"' + e.message + '"}');
      }
    });
    return;
  }

  // Static files - serve from repo root
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, attempting to kill old process...`);
    try {
      require('child_process').execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', timeout: 5000 }
      );
    } catch {}
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 2000);
  } else {
    console.error('Server error:', err);
  }
});
