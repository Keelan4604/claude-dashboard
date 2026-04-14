/**
 * Token Watcher v2 — TIME-BASED session optimizer.
 *
 * Sessions last ~6 hours. This watcher ensures every session gets used.
 *
 * Logic:
 * - If 2+ hours into a session and usage is under 30%, deploy agents (idle session)
 * - If 4+ hours into a session and usage is under 60%, deploy more agents (wasting time)
 * - If 5+ hours in and under 80%, go all-out (session expiring soon)
 * - When a session resets, immediately kick off a new productive session
 *
 * Also keeps the old pct-based thresholds as a safety net.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const USAGE_FILE = path.join(__dirname, 'usage.json');
const AI_DIR = 'C:\\Users\\Keela\\Desktop\\AI';
const LOG_FILE = path.join(AI_DIR, 'Research-Archive', 'token-optimizer.log');
const DISABLE_FLAG = path.join(__dirname, 'token-watcher-disabled.flag');

// Check if disabled
if (fs.existsSync(DISABLE_FLAG)) {
  console.log('[TOKEN-WATCHER] Disabled via flag file. Delete token-watcher-disabled.flag to re-enable.');
  module.exports = { optimizerStatus: { armed: false, mode: 'disabled', lastPct: 0, deployedThisCycle: [] } };
  return;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_HOURS = 6;

let state = {
  deployedSales: false,
  deployedIdeas: false,
  deployedNightbrain: false,
  deployedIdleAgent: false,
  lastPct: 0,
  sessionStartTime: null,    // estimated session start
  lastResetString: null,     // track session changes
  sessionNumber: 0,
};

const optimizerStatus = {
  armed: true,
  lastPct: 0,
  lastFired: null,
  deployedThisCycle: [],
  resetAt: null,
  sessionAge: null,
  mode: 'watching',
};

function log(msg) {
  const line = `[${new Date().toISOString()}] [TOKEN-WATCHER] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return null; }
}

function sendNotification(message) {
  // WhatsApp via OpenClaw discontinued. Log only.
  log('NOTIFICATION: ' + message);
}

function spawnAgent(agentPromptFile, label, model) {
  model = model || 'claude-sonnet-4-6';
  const promptPath = path.join(AI_DIR, 'Research-Archive', agentPromptFile);
  log('Spawning agent: ' + label + ' (' + agentPromptFile + ') on ' + model);

  let prompt;
  try { prompt = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
    log('Failed to read prompt ' + promptPath + ': ' + e.message);
    return;
  }

  const tmpPrompt = path.join(AI_DIR, 'tmp-' + label.replace(/\s/g, '-') + '-' + Date.now() + '.md');
  fs.writeFileSync(tmpPrompt, prompt);

  const proc = exec(
    'cd /d "' + AI_DIR + '" && claude --print --dangerously-skip-permissions --model ' + model + ' -p "@' + tmpPrompt + '"',
    { shell: 'cmd.exe', timeout: 45 * 60 * 1000 },
    (err, stdout) => {
      try { fs.unlinkSync(tmpPrompt); } catch {}
      if (err) log('Agent ' + label + ' error: ' + err.message);
      else {
        log('Agent ' + label + ' completed. Output: ' + stdout.length + ' chars');
        const outFile = path.join(AI_DIR, 'Research-Archive', 'Overnight', 'optimizer-' + label + '-' + new Date().toISOString().split('T')[0] + '.log');
        try {
          fs.mkdirSync(path.join(AI_DIR, 'Research-Archive', 'Overnight'), { recursive: true });
          fs.writeFileSync(outFile, stdout);
        } catch {}
      }
    }
  );
  log('Spawned PID: ' + (proc.pid || 'unknown'));
  return proc;
}

function spawnNightBrain() {
  const promptPath = path.join(AI_DIR, 'Research-Archive', 'night-brain.md');
  let prompt;
  try { prompt = fs.readFileSync(promptPath, 'utf8'); } catch (e) {
    log('Failed to read night-brain.md: ' + e.message);
    return;
  }
  const tmpPrompt = path.join(AI_DIR, 'tmp-nightbrain-' + Date.now() + '.md');
  fs.writeFileSync(tmpPrompt, prompt);

  const proc = exec(
    'cd /d "' + AI_DIR + '" && claude --print --dangerously-skip-permissions --model claude-opus-4-6 -p "@' + tmpPrompt + '"',
    { shell: 'cmd.exe', timeout: 60 * 60 * 1000 },
    (err, stdout) => {
      try { fs.unlinkSync(tmpPrompt); } catch {}
      log('Night brain ' + (err ? 'error: ' + err.message : 'completed, output: ' + stdout.length + ' chars'));
    }
  );
  log('Night brain spawned PID: ' + (proc.pid || 'unknown'));
}

/**
 * Parse the reset string to estimate hours remaining in session.
 * Examples: "Resets in 4 hr 31 min", "Resets in 2 hr 10 min", "Resets in 45 min"
 */
function parseHoursRemaining(resetStr) {
  if (!resetStr) return null;
  const hrMatch = resetStr.match(/(\d+)\s*hr/);
  const minMatch = resetStr.match(/(\d+)\s*min/);
  const hrs = hrMatch ? parseInt(hrMatch[1]) : 0;
  const mins = minMatch ? parseInt(minMatch[1]) : 0;
  return hrs + mins / 60;
}

function resetCycle(reason) {
  log('Resetting cycle: ' + reason);
  state.deployedSales = false;
  state.deployedIdeas = false;
  state.deployedNightbrain = false;
  state.deployedIdleAgent = false;
  state.sessionStartTime = Date.now();
  state.sessionNumber++;
  optimizerStatus.deployedThisCycle = [];
  optimizerStatus.mode = 'watching';
}

function deployWithLabel(agentFile, label, model, reason) {
  optimizerStatus.deployedThisCycle.push(label);
  optimizerStatus.lastFired = new Date().toISOString();
  optimizerStatus.mode = 'deploying';
  spawnAgent(agentFile, label, model);
  sendNotification('Token optimizer: ' + reason);
}

function check() {
  const usage = readUsage();
  if (!usage) return;

  const pct = usage.session?.pct || 0;
  const resetStr = usage.session?.reset || '';
  optimizerStatus.lastPct = pct;
  optimizerStatus.resetAt = resetStr;

  // Detect session reset (reset string changed significantly or pct dropped)
  if (state.lastResetString && resetStr !== state.lastResetString) {
    const oldHrs = parseHoursRemaining(state.lastResetString);
    const newHrs = parseHoursRemaining(resetStr);
    // If time remaining jumped UP, session reset
    if (oldHrs !== null && newHrs !== null && newHrs > oldHrs + 1) {
      resetCycle('Session reset detected (time jumped from ' + oldHrs.toFixed(1) + 'h to ' + newHrs.toFixed(1) + 'h remaining)');
    }
  }
  // Also detect via pct drop
  if (pct < 15 && state.lastPct > 40) {
    resetCycle('Session reset detected (pct dropped ' + state.lastPct + '% to ' + pct + '%)');
  }

  state.lastResetString = resetStr;
  state.lastPct = pct;

  // Calculate session age
  const hoursRemaining = parseHoursRemaining(resetStr);
  const hoursElapsed = hoursRemaining !== null ? (SESSION_HOURS - hoursRemaining) : null;
  optimizerStatus.sessionAge = hoursElapsed !== null ? hoursElapsed.toFixed(1) + 'h elapsed' : 'unknown';

  if (hoursElapsed === null) return;

  // ============ TIME-BASED LOGIC ============
  // The goal: never waste a session. If tokens are sitting idle, use them.

  // PHASE 1: 2+ hours in, under 30% used = idle session, deploy sales agent
  if (hoursElapsed >= 2 && pct < 30 && !state.deployedSales) {
    log('IDLE SESSION: ' + hoursElapsed.toFixed(1) + 'h in, only ' + pct + '% used. Deploying sales agent.');
    state.deployedSales = true;
    deployWithLabel('website-sales.md', 'website-sales', 'claude-sonnet-4-6',
      'Session idle (' + pct + '% at ' + hoursElapsed.toFixed(1) + 'h). Deploying website-sales to use tokens.');
  }

  // PHASE 2: 3.5+ hours in, under 50% used = still idle, add idea discovery
  if (hoursElapsed >= 3.5 && pct < 50 && !state.deployedIdeas) {
    log('STILL IDLE: ' + hoursElapsed.toFixed(1) + 'h in, only ' + pct + '% used. Adding idea-discovery.');
    state.deployedIdeas = true;
    deployWithLabel('idea-discovery.md', 'idea-discovery', 'claude-sonnet-4-6',
      'Session still idle (' + pct + '% at ' + hoursElapsed.toFixed(1) + 'h). Added idea-discovery agent.');
  }

  // PHASE 3: 5+ hours in, under 70% used = session expiring, go all out
  if (hoursElapsed >= 5 && pct < 70 && !state.deployedNightbrain) {
    log('SESSION EXPIRING: ' + hoursElapsed.toFixed(1) + 'h in, only ' + pct + '% used. Firing night brain.');
    state.deployedNightbrain = true;
    optimizerStatus.deployedThisCycle.push('night-brain');
    optimizerStatus.lastFired = new Date().toISOString();
    spawnNightBrain();
    sendNotification('Session expiring soon (' + pct + '% at ' + hoursElapsed.toFixed(1) + 'h). Night brain deployed to maximize value.');
  }

  // ============ PCT-BASED SAFETY NET ============
  // If someone IS using it heavily and it's getting high, still deploy
  if (pct >= 90 && !state.deployedIdeas) {
    log('High usage: ' + pct + '%. Deploying idea-discovery.');
    state.deployedIdeas = true;
    deployWithLabel('idea-discovery.md', 'idea-discovery', 'claude-sonnet-4-6',
      'Session at ' + pct + '%. Deploying idea-discovery with remaining tokens.');
  }
  if (pct >= 95 && !state.deployedNightbrain) {
    log('Critical usage: ' + pct + '%. Firing night brain.');
    state.deployedNightbrain = true;
    optimizerStatus.deployedThisCycle.push('night-brain');
    optimizerStatus.lastFired = new Date().toISOString();
    spawnNightBrain();
    sendNotification('Session at ' + pct + '%. Night brain deployed to burn remaining tokens.');
  }

  // Update mode
  if (optimizerStatus.deployedThisCycle.length > 0) {
    optimizerStatus.mode = 'deployed';
  } else if (hoursElapsed >= 1.5 && pct < 30) {
    optimizerStatus.mode = 'idle-alert';
  } else {
    optimizerStatus.mode = 'watching';
  }
}

// Start
log('Token watcher v2 started. TIME-BASED optimizer.');
log('Logic: 2h+<30%=sales, 3.5h+<50%=+ideas, 5h+<70%=+nightbrain. Also 90%=ideas, 95%=nightbrain.');
state.sessionStartTime = Date.now();
check();
setInterval(check, CHECK_INTERVAL_MS);

module.exports = { optimizerStatus };
