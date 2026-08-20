/**
 * Research Scheduler — SOLE spawner of research agents.
 *
 * Reads research-config.json every tick. For each area with enabled=true,
 * if the current local HH:MM matches any entry in schedule[], spawn
 * the agent via `claude --print --dangerously-skip-permissions`.
 *
 * Dedupe: an area fires at most once per (hour, minute) tick. State is
 * in-memory; restarting the scheduler clears the dedupe cache.
 *
 * Config is re-read every tick, so UI edits take effect immediately.
 *
 * Replaces: token-watcher.js auto-spawns and session-loop.js auto-spawns.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const AI_DIR = 'C:\\Users\\Keela\\Desktop\\AI';
// 2026-08-20: System moved into Memory/projects/system/System/
const RESEARCH_DIR = path.join(AI_DIR, 'Memory', 'projects', 'system', 'System', 'Research-Archive');
const CONFIG_FILE = path.join(RESEARCH_DIR, 'research-config.json');
const OVERNIGHT_DIR = path.join(RESEARCH_DIR, 'Overnight');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'scheduler.log');
const STATUS_FILE = path.join(__dirname, 'scheduler-status.json');
const UPDATING_FLAG = path.join(__dirname, 'updating.flag');

const TICK_MS = 60 * 1000;

// In-memory dedupe: { area: "YYYY-MM-DDTHH:MM" of last fire }
const lastFiredKey = {};
// For /api/scheduler-status: { area: { lastFiredAt, lastFiredOk, nextFireAt } }
const status = { areas: {}, startedAt: new Date().toISOString() };

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(OVERNIGHT_DIR, { recursive: true }); } catch {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] [SCHEDULER] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { log('Failed to read config: ' + e.message); return null; }
}

function minuteKey(d) {
  // "YYYY-MM-DDTHH:MM" in local time
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function nextFireFor(schedule, now) {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  let best = null;
  for (const s of schedule) {
    const h = s.hour, m = s.minute || 0;
    if (h == null) continue;
    const candidate = new Date(now);
    candidate.setHours(h, m, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    if (!best || candidate < best) best = candidate;
  }
  return best ? best.toISOString() : null;
}

function spawnArea(areaKey, area) {
  // Guard: skip all spawns while an update is in flight. Running claude CLIs
  // hold the claude.exe binary open and block the updater from replacing it.
  // Create updating.flag before updating, delete it after.
  if (fs.existsSync(UPDATING_FLAG)) {
    log('SKIP ' + areaKey + ': updating.flag present, not spawning during update');
    status.areas[areaKey] = Object.assign({}, status.areas[areaKey] || {}, {
      lastSkippedAt: new Date().toISOString(), lastSkipReason: 'updating.flag'
    });
    writeStatus();
    return;
  }

  const agentFile = area.agentFile || (areaKey + '.md');
  const model = area.model || 'claude-sonnet-4-6';
  const promptPath = path.join(RESEARCH_DIR, agentFile);

  let prompt;
  try { prompt = fs.readFileSync(promptPath, 'utf8'); }
  catch (e) {
    log('FIRE FAIL ' + areaKey + ': cannot read ' + promptPath + ' (' + e.message + ')');
    status.areas[areaKey] = Object.assign({}, status.areas[areaKey] || {}, {
      lastFiredAt: new Date().toISOString(), lastFiredOk: false, lastError: e.message
    });
    writeStatus();
    return;
  }

  const tmpPrompt = path.join(AI_DIR, 'tmp-scheduler-' + areaKey + '-' + Date.now() + '.md');
  try { fs.writeFileSync(tmpPrompt, prompt); } catch (e) {
    log('FIRE FAIL ' + areaKey + ': cannot write tmp prompt: ' + e.message);
    return;
  }

  const cmd = 'cd /d "' + AI_DIR + '" && claude --print --dangerously-skip-permissions --model '
    + model + ' -p "@' + tmpPrompt + '"';
  const timeoutMs = (areaKey === 'night-brain' ? 120 : 60) * 60 * 1000;

  log('FIRE ' + areaKey + ' (' + agentFile + ' on ' + model + ')');
  status.areas[areaKey] = Object.assign({}, status.areas[areaKey] || {}, {
    lastFiredAt: new Date().toISOString(), lastFiredOk: null, lastError: null
  });
  writeStatus();

  const child = exec(cmd, { shell: 'cmd.exe', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpPrompt); } catch {}
      const ok = !err;
      if (err) log('DONE ' + areaKey + ' ERROR: ' + err.message);
      else log('DONE ' + areaKey + ' ok (' + (stdout ? stdout.length : 0) + ' chars)');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outFile = path.join(OVERNIGHT_DIR, 'scheduler-' + areaKey + '-' + stamp + '.log');
      try { fs.writeFileSync(outFile, (stdout || '') + (stderr ? '\n---STDERR---\n' + stderr : '')); } catch {}

      status.areas[areaKey] = Object.assign({}, status.areas[areaKey] || {}, {
        lastFiredOk: ok,
        lastError: err ? err.message : null,
        lastOutputFile: outFile
      });
      writeStatus();
    });
  log('  pid=' + (child.pid || 'unknown'));
}

function writeStatus() {
  try {
    const now = new Date();
    const cfg = readConfig();
    if (cfg && cfg.areas) {
      for (const k of Object.keys(cfg.areas)) {
        const a = cfg.areas[k];
        status.areas[k] = Object.assign({
          enabled: !!a.enabled, schedule: a.schedule || []
        }, status.areas[k] || {});
        status.areas[k].enabled = !!a.enabled;
        status.areas[k].schedule = a.schedule || [];
        status.areas[k].nextFireAt = a.enabled ? nextFireFor(a.schedule, now) : null;
      }
    }
    status.updatedAt = now.toISOString();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) { log('writeStatus error: ' + e.message); }
}

function tick() {
  const cfg = readConfig();
  if (!cfg || !cfg.areas) { writeStatus(); return; }

  const now = new Date();
  const curH = now.getHours();
  const curM = now.getMinutes();
  const key = minuteKey(now);

  for (const areaKey of Object.keys(cfg.areas)) {
    const a = cfg.areas[areaKey];
    if (!a || !a.enabled) continue;
    if (!Array.isArray(a.schedule) || !a.schedule.length) continue;

    const match = a.schedule.some(s => s && s.hour === curH && (s.minute || 0) === curM);
    if (!match) continue;
    if (lastFiredKey[areaKey] === key) continue;

    lastFiredKey[areaKey] = key;
    spawnArea(areaKey, a);
  }

  writeStatus();
}

if (require.main === module) {
  log('Research scheduler started. Tick every 60s. Config: ' + CONFIG_FILE);
  tick();
  setInterval(tick, TICK_MS);
}

module.exports = { tick, readConfig, nextFireFor, minuteKey };
