// HA → iCUE Bridge
// Polls Home Assistant for scene.off activation and switches iCUE profile
// Requires: iCUE hotkey Ctrl+Shift+F12 assigned to "sons of the forst" profile

const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const HA_URL = 'https://ha.keelanodoherty.org';
const HA_TOKEN = fs.readFileSync(
  path.join(require('os').homedir(), '.openclaw', 'secrets', 'ha_token.txt'), 'utf8'
).trim();

const POLL_INTERVAL = 3000; // 3 seconds
let lastSceneState = null;
let lastSceneChanged = null;

function log(msg) {
  console.log(`[ha-icue ${new Date().toLocaleTimeString()}] ${msg}`);
}

function haGet(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, HA_URL);
    const req = https.get(url.href, {
      headers: { 'Authorization': `Bearer ${HA_TOKEN}` }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sendIcueHotkey(profile) {
  // Ctrl+Shift+F12 = ^+{F12} in SendKeys notation
  const hotkey = '^+{F12}';
  const ps = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${hotkey}')"`;
  exec(ps, { shell: 'cmd.exe' }, (err) => {
    if (err) log('ERROR sending hotkey: ' + err.message);
    else log('Sent iCUE hotkey for profile: ' + profile);
  });
}

async function pollScene() {
  try {
    const state = await haGet('/api/states/scene.off');
    const changed = state.last_changed || state.last_updated;

    // First run - just record the state
    if (lastSceneChanged === null) {
      lastSceneChanged = changed;
      log('Watching scene.off (last_changed: ' + changed + ')');
      return;
    }

    // Scene was activated (last_changed moved forward)
    if (changed !== lastSceneChanged) {
      lastSceneChanged = changed;
      log('scene.off activated! Switching iCUE to "sons of the forst"');
      sendIcueHotkey('sons of the forst');
    }
  } catch (err) {
    log('Poll error: ' + err.message);
  }
}

log('Starting HA → iCUE bridge');
log('Polling scene.off every ' + (POLL_INTERVAL / 1000) + 's');
log('IMPORTANT: Assign Ctrl+Shift+F12 in iCUE to "sons of the forst" profile');

// Initial poll
pollScene();
// Regular polling
setInterval(pollScene, POLL_INTERVAL);
