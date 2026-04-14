// HA → iCUE Bridge
// Polls Home Assistant scenes and switches iCUE profile accordingly
// scene.off → Sons of the Forest (RGB off)
// scene.bright/dark/chill → Default (Macros) (RGB on)

const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const HA_URL = 'https://ha.keelanodoherty.org';
const HA_TOKEN = fs.readFileSync(
  path.join(require('os').homedir(), 'Desktop', 'AI', 'Secrets', 'ha_token.txt'), 'utf8'
).trim();

// iCUE profile GUIDs (from tree.cueprofileorder)
const PROFILES = {
  off:     { id: '{6c7fd6d9-9554-4a7a-9aea-c0bd64c698ae}', name: 'Sons of the Forest' },
  default: { id: '{d7e366cb-d656-43c2-b958-4ab66d61dd10}', name: 'Default (Macros)' },
};

const CONFIG_PATH = path.join(
  require('os').homedir(), 'AppData', 'Roaming', 'Corsair', 'CUE5', 'config.cuecfg'
);
const ICUE_LAUNCHER = 'C:\\Program Files\\Corsair\\Corsair iCUE5 Software\\iCUE Launcher.exe';

const POLL_INTERVAL = 3000;
let lastChanged = {};
let currentProfile = null;
let switching = false;

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
        catch { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function switchProfile(profile) {
  if (switching) return;
  if (currentProfile === profile.id) return;
  switching = true;

  try {
    let config = fs.readFileSync(CONFIG_PATH, 'utf8');
    const match = config.match(/<value name="defaultProfile">\{[^}]+\}<\/value>/);
    if (match) {
      config = config.replace(match[0], `<value name="defaultProfile">${profile.id}</value>`);
      fs.writeFileSync(CONFIG_PATH, config);
      log('Config updated → ' + profile.name);

      // Kill and restart iCUE
      exec('taskkill /F /IM iCUE.exe', { shell: 'cmd.exe' }, () => {
        setTimeout(() => {
          exec(`start "" "${ICUE_LAUNCHER}"`, { shell: 'cmd.exe' }, (err) => {
            if (err) log('iCUE restart failed: ' + err.message);
            else log('iCUE restarted with: ' + profile.name);
            currentProfile = profile.id;
            switching = false;
          });
        }, 1500);
      });
    } else {
      log('Could not find defaultProfile in config');
      switching = false;
    }
  } catch (err) {
    log('Switch error: ' + err.message);
    switching = false;
  }
}

async function poll() {
  if (switching) return;

  try {
    const scenes = ['scene.off', 'scene.bright', 'scene.dark', 'scene.chill'];
    for (const scene of scenes) {
      const state = await haGet('/api/states/' + scene);
      const changed = state.last_changed || state.last_updated;

      if (!lastChanged[scene]) {
        lastChanged[scene] = changed;
        continue;
      }

      if (changed !== lastChanged[scene]) {
        lastChanged[scene] = changed;
        if (scene === 'scene.off') {
          log('scene.off activated');
          switchProfile(PROFILES.off);
        } else {
          log(scene + ' activated');
          switchProfile(PROFILES.default);
        }
      }
    }
  } catch (err) {
    log('Poll error: ' + err.message);
  }
}

log('HA → iCUE bridge started');
log('Off → ' + PROFILES.off.name + ' | Other → ' + PROFILES.default.name);
poll();
setInterval(poll, POLL_INTERVAL);
