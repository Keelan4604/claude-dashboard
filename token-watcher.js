/**
 * Token Watcher — auto-deploys agents when session tokens are running low.
 * Thresholds: 80% → website-sales, 90% → +idea-discovery, 95% → +night-brain
 */

const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');

const USAGE_FILE = path.join(__dirname, 'usage.json');
const LOG_FILE = path.join('C:\\Users\\Keela\\.openclaw\\workspace', 'token-optimizer.log');
const WORKSPACE = 'C:\\Users\\Keela\\.openclaw\\workspace';
const OPENCLAW_CLI = 'C:\\Users\\Keela\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const THRESHOLDS = { sales: 80, ideas: 90, nightbrain: 95 };

let state = {
  deployedSales: false,
  deployedIdeas: false,
  deployedNightbrain: false,
  lastPct: 0,
  lastFired: null,
};

// Exported so server.js can expose /api/optimizer-status
const optimizerStatus = {
  armed: true,
  lastPct: 0,
  lastFired: null,
  deployedThisCycle: [],
  resetAt: null,
};

function log(msg) {
  const line = `[${new Date().toISOString()}] [TOKEN-WATCHER] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch { return null; }
}

function sendWhatsApp(message) {
  const cmd = `node "${OPENCLAW_CLI}" agent --channel whatsapp --deliver --message "${message.replace(/"/g, "'")}"`;
  exec(cmd, (err) => {
    if (err) log('WhatsApp send failed: ' + err.message);
    else log('WhatsApp sent: ' + message.slice(0, 60));
  });
}

function spawnAgent(agentPromptFile, label) {
  const promptPath = path.join(WORKSPACE, 'agents', agentPromptFile);
  log(`Spawning agent: ${label} (${agentPromptFile})`);

  // Read prompt file content
  let prompt;
  try {
    prompt = fs.readFileSync(promptPath, 'utf8');
  } catch (e) {
    log(`Failed to read prompt ${promptPath}: ${e.message}`);
    return;
  }

  // Write prompt to a temp file to avoid shell escaping issues
  const tmpPrompt = path.join(WORKSPACE, `tmp-${label.replace(/\s/g,'-')}-${Date.now()}.md`);
  fs.writeFileSync(tmpPrompt, prompt);

  const args = [
    '--print',
    '--permission-mode', 'bypassPermissions',
    '--model', 'claude-sonnet-4-6',
    '--cwd', WORKSPACE,
    '-p', prompt.slice(0, 200) + '...' // abbreviated for log
  ];

  // Use exec with the full command
  const cmd = `claude --print --dangerously-skip-permissions --model claude-sonnet-4-6 --cwd "${WORKSPACE}" -p "$(type '${tmpPrompt}')"`;

  const proc = exec(
    `cd /d "${WORKSPACE}" && claude --print --dangerously-skip-permissions --model claude-sonnet-4-6 -p "@${tmpPrompt}"`,
    { shell: 'cmd.exe', timeout: 30 * 60 * 1000 },
    (err, stdout, stderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpPrompt); } catch {}
      if (err) {
        log(`Agent ${label} error: ${err.message}`);
      } else {
        log(`Agent ${label} completed. Output length: ${stdout.length}`);
        // Append output to log
        const outFile = path.join(WORKSPACE, `overnight/token-optimizer-${label}-${new Date().toISOString().split('T')[0]}.log`);
        try {
          fs.mkdirSync(path.join(WORKSPACE, 'overnight'), { recursive: true });
          fs.writeFileSync(outFile, stdout);
        } catch {}
      }
    }
  );

  log(`Spawned PID: ${proc.pid || 'unknown'}`);
  return proc;
}

function spawnNightBrain() {
  const promptPath = path.join(WORKSPACE, 'night-brain.md');
  let prompt;
  try { prompt = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
    log('Failed to read night-brain.md: ' + e.message);
    return;
  }
  const tmpPrompt = path.join(WORKSPACE, `tmp-nightbrain-${Date.now()}.md`);
  fs.writeFileSync(tmpPrompt, prompt);

  const proc = exec(
    `cd /d "${WORKSPACE}" && claude --print --dangerously-skip-permissions --model claude-opus-4-6 -p "@${tmpPrompt}"`,
    { shell: 'cmd.exe', timeout: 60 * 60 * 1000 },
    (err, stdout) => {
      try { fs.unlinkSync(tmpPrompt); } catch {}
      log(`Night brain ${err ? 'error: ' + err.message : 'completed, output: ' + stdout.length + ' chars'}`);
    }
  );
  log(`Night brain spawned PID: ${proc.pid || 'unknown'}`);
}

function check() {
  const usage = readUsage();
  if (!usage) return;

  const pct = usage.session?.pct || 0;
  optimizerStatus.lastPct = pct;
  optimizerStatus.resetAt = usage.session?.reset || null;

  // Reset cycle when session resets (pct drops significantly)
  if (pct < 20 && state.lastPct > 50) {
    log(`New session detected (pct dropped ${state.lastPct}% → ${pct}%). Resetting deploy flags.`);
    state.deployedSales = false;
    state.deployedIdeas = false;
    state.deployedNightbrain = false;
    optimizerStatus.deployedThisCycle = [];
  }

  state.lastPct = pct;

  // Check thresholds
  if (pct >= THRESHOLDS.nightbrain && !state.deployedNightbrain) {
    log(`Session at ${pct}% — firing NIGHT BRAIN (95% threshold)`);
    state.deployedNightbrain = true;
    state.lastFired = new Date().toISOString();
    optimizerStatus.lastFired = state.lastFired;
    optimizerStatus.deployedThisCycle.push('night-brain');
    spawnNightBrain();
    sendWhatsApp(`⚡ Token optimizer: ${pct}% used — fired night-brain to maximize remaining tokens.`);
  } else if (pct >= THRESHOLDS.ideas && !state.deployedIdeas) {
    log(`Session at ${pct}% — firing IDEA DISCOVERY (90% threshold)`);
    state.deployedIdeas = true;
    state.lastFired = new Date().toISOString();
    optimizerStatus.lastFired = state.lastFired;
    optimizerStatus.deployedThisCycle.push('idea-discovery');
    spawnAgent('idea-discovery.md', 'idea-discovery');
    sendWhatsApp(`⚡ Token optimizer: ${pct}% used — launched idea-discovery agent to burn remaining tokens.`);
  } else if (pct >= THRESHOLDS.sales && !state.deployedSales) {
    log(`Session at ${pct}% — firing WEBSITE SALES (80% threshold)`);
    state.deployedSales = true;
    state.lastFired = new Date().toISOString();
    optimizerStatus.lastFired = state.lastFired;
    optimizerStatus.deployedThisCycle.push('website-sales');
    spawnAgent('website-sales.md', 'website-sales');
    sendWhatsApp(`⚡ Token optimizer: ${pct}% used — launched website-sales agent to burn remaining tokens.`);
  }
}

// Start watching
log('Token watcher started. Thresholds: 80%=sales, 90%=ideas, 95%=night-brain');
check(); // immediate check on start
setInterval(check, CHECK_INTERVAL_MS);

module.exports = { optimizerStatus };
