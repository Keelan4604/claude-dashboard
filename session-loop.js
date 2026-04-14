/**
 * Session Loop — ensures Claude sessions never sit idle.
 *
 * Runs continuously. Every 10 minutes:
 * 1. Checks if any Claude session is active
 * 2. If NOT, kicks off a productive session automatically
 * 3. Sends WhatsApp notification when auto-starting
 *
 * This means sessions are ALWAYS being used, whether Keelan is
 * awake, asleep, or away. No tokens wasted.
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AI_DIR = 'C:\\Users\\Keela\\Desktop\\AI';
const LOG_FILE = path.join(AI_DIR, 'Research-Archive', 'session-loop.log');
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

let lastAutoStart = 0;
const COOLDOWN = 30 * 60 * 1000; // 30 min cooldown between auto-starts

function log(msg) {
  const line = '[' + new Date().toISOString() + '] [SESSION-LOOP] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function sendNotification(message) {
  // WhatsApp via OpenClaw discontinued. Log only.
  log('NOTIFICATION: ' + message);
}

function isClaudeRunning() {
  try {
    // Check for any claude processes
    const result = execSync('tasklist /fi "imagename eq claude.exe" /fo csv /nh', {
      encoding: 'utf8', timeout: 10000, shell: 'cmd.exe'
    });
    if (result.includes('claude.exe')) return true;
  } catch {}

  try {
    // Also check for node processes running claude
    const result = execSync('wmic process where "commandline like \'%claude%\' and commandline like \'%--print%\'" get processid /format:csv 2>nul', {
      encoding: 'utf8', timeout: 10000, shell: 'cmd.exe'
    });
    const lines = result.trim().split('\n').filter(l => l.trim() && !l.includes('ProcessId'));
    if (lines.length > 0) return true;
  } catch {}

  return false;
}

function startProductiveSession() {
  log('No active Claude session detected. Starting autonomous session...');

  // Read strategy to know what to work on
  let priority = 'website-sales';
  try {
    const strategy = fs.readFileSync(path.join(AI_DIR, 'Website-Business', 'Strategy', 'strategy.md'), 'utf8');
    // Simple heuristic: if there are unsent emails, prioritize outreach
    if (strategy.includes('drafts sitting unsent') || strategy.includes('needs to review')) {
      priority = 'website-sales';
    }
  } catch {}

  const hour = new Date().getHours();
  let agentFile, label, model;

  if (hour >= 1 && hour < 6) {
    // Late night: run the full night brain
    agentFile = null; // special case
    label = 'night-brain';
    model = 'claude-opus-4-6';
  } else if (hour >= 6 && hour < 12) {
    // Morning: lead gen and outreach prep
    agentFile = 'website-sales.md';
    label = 'website-sales';
    model = 'claude-sonnet-4-6';
  } else {
    // Afternoon/evening: mix of sales and ideas
    agentFile = 'website-sales.md';
    label = 'website-sales';
    model = 'claude-sonnet-4-6';
  }

  lastAutoStart = Date.now();

  if (label === 'night-brain') {
    const promptPath = path.join(AI_DIR, 'Research-Archive', 'night-brain.md');
    let prompt;
    try { prompt = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
      log('Failed to read night-brain.md: ' + e.message);
      return;
    }
    const tmpPrompt = path.join(AI_DIR, 'tmp-autoloop-' + Date.now() + '.md');
    fs.writeFileSync(tmpPrompt, prompt);

    exec(
      'cd /d "' + AI_DIR + '" && claude --print --dangerously-skip-permissions --model ' + model + ' -p "@' + tmpPrompt + '"',
      { shell: 'cmd.exe', timeout: 90 * 60 * 1000 },
      (err, stdout) => {
        try { fs.unlinkSync(tmpPrompt); } catch {}
        log('Auto-session (' + label + ') ' + (err ? 'error: ' + err.message : 'completed. ' + stdout.length + ' chars'));
        const outFile = path.join(AI_DIR, 'Research-Archive', 'Overnight', 'autoloop-' + label + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
        try { fs.mkdirSync(path.join(AI_DIR, 'Research-Archive', 'Overnight'), { recursive: true }); fs.writeFileSync(outFile, stdout || ''); } catch {}
      }
    );
  } else {
    const promptPath = path.join(AI_DIR, 'Research-Archive', agentFile);
    let prompt;
    try { prompt = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
      log('Failed to read ' + promptPath + ': ' + e.message);
      return;
    }
    const tmpPrompt = path.join(AI_DIR, 'tmp-autoloop-' + Date.now() + '.md');
    fs.writeFileSync(tmpPrompt, prompt);

    exec(
      'cd /d "' + AI_DIR + '" && claude --print --dangerously-skip-permissions --model ' + model + ' -p "@' + tmpPrompt + '"',
      { shell: 'cmd.exe', timeout: 60 * 60 * 1000 },
      (err, stdout) => {
        try { fs.unlinkSync(tmpPrompt); } catch {}
        log('Auto-session (' + label + ') ' + (err ? 'error: ' + err.message : 'completed. ' + stdout.length + ' chars'));
        const outFile = path.join(AI_DIR, 'Research-Archive', 'Overnight', 'autoloop-' + label + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
        try { fs.mkdirSync(path.join(AI_DIR, 'Research-Archive', 'Overnight'), { recursive: true }); fs.writeFileSync(outFile, stdout || ''); } catch {}
      }
    );
  }

  sendNotification('Session loop: No active session detected. Auto-started ' + label + ' agent (' + model + ') at ' + new Date().toLocaleTimeString() + '.');
  log('Auto-started: ' + label + ' on ' + model);
}

function check() {
  // Cooldown check
  if (Date.now() - lastAutoStart < COOLDOWN) {
    log('Within cooldown (' + Math.round((COOLDOWN - (Date.now() - lastAutoStart)) / 60000) + 'm left). Skipping.');
    return;
  }

  if (isClaudeRunning()) {
    log('Claude session active. Nothing to do.');
  } else {
    startProductiveSession();
  }
}

log('Session loop started. Checking every 10 minutes. Cooldown: 30 min between auto-starts.');
log('Late night (1-6AM) = night-brain on Opus. Other times = website-sales on Sonnet.');
check();
setInterval(check, CHECK_INTERVAL);
