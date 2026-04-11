// HA → iCUE Bridge
// Polls Home Assistant for scene.off activation and switches Corsair RGB off
// Uses PowerShell COM automation to click the iCUE system tray profile menu

const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const HA_URL = 'https://ha.keelanodoherty.org';
const HA_TOKEN = fs.readFileSync(
  path.join(require('os').homedir(), '.openclaw', 'secrets', 'ha_token.txt'), 'utf8'
).trim();

const POLL_INTERVAL = 3000;
let lastOffChanged = null;
let lastOtherChanged = {};
let rgbState = 'unknown'; // 'off' or 'on' or 'unknown'

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

// Switch iCUE profile by editing config and sending a refresh signal
// Profile GUIDs from tree.cueprofileorder:
//   Sons of the Forest: {6c7fd6d9-9554-4a7a-9aea-c0bd64c698ae}  (lights off / minimal)
//   Default (Macros):   next GUID in tree
const PROFILES = {
  off: '{6c7fd6d9-9554-4a7a-9aea-c0bd64c698ae}',    // Sons of the Forest
};

const CONFIG_PATH = path.join(
  require('os').homedir(),
  'AppData', 'Roaming', 'Corsair', 'CUE5', 'config.cuecfg'
);

function switchProfile(profileId, profileName) {
  // Read current config, update defaultProfile, write it back, restart iCUE
  try {
    let config = fs.readFileSync(CONFIG_PATH, 'utf8');
    const oldDefault = config.match(/<value name="defaultProfile">\{[^}]+\}<\/value>/);
    if (oldDefault) {
      config = config.replace(
        oldDefault[0],
        `<value name="defaultProfile">${profileId}</value>`
      );
      fs.writeFileSync(CONFIG_PATH, config);
      log('Updated config.cuecfg defaultProfile to ' + profileName);

      // Restart iCUE to pick up the change
      const icuePath = 'C:\\Program Files\\Corsair\\Corsair iCUE5 Software\\iCUE Launcher.exe';
      exec('taskkill /F /IM iCUE.exe', { shell: 'cmd.exe' }, (err) => {
        setTimeout(() => {
          exec(`start "" "${icuePath}"`, { shell: 'cmd.exe' }, (err2) => {
            if (err2) log('Failed to restart iCUE: ' + err2.message);
            else log('iCUE restarted with profile: ' + profileName);
          });
        }, 2000);
      });
    }
  } catch (err) {
    log('Profile switch error: ' + err.message);
  }
}

async function pollScenes() {
  try {
    // Check scene.off
    const offState = await haGet('/api/states/scene.off');
    const offChanged = offState.last_changed || offState.last_updated;

    // Check other scenes - any means "not off"
    const otherScenes = ['scene.bright', 'scene.dark', 'scene.chill'];
    for (const scene of otherScenes) {
      try {
        const s = await haGet('/api/states/' + scene);
        const changed = s.last_changed || s.last_updated;
        if (lastOtherChanged[scene] === undefined) {
          lastOtherChanged[scene] = changed;
        } else if (changed !== lastOtherChanged[scene]) {
          lastOtherChanged[scene] = changed;
          if (rgbState === 'off') {
            log(scene + ' activated -> RGB should come back (iCUE default)');
            rgbState = 'on';
            // No action needed - iCUE default profile handles it
          }
        }
      } catch {}
    }

    // First run
    if (lastOffChanged === null) {
      lastOffChanged = offChanged;
      log('Watching scenes (off last_changed: ' + offChanged + ')');
      return;
    }

    // scene.off activated
    if (offChanged !== lastOffChanged) {
      lastOffChanged = offChanged;
      if (rgbState !== 'off') {
        log('scene.off activated! Switching to Sons of the Forest profile');
        switchProfile(PROFILES.off, 'Sons of the Forest');
        rgbState = 'off';
      }
    }
  } catch (err) {
    log('Poll error: ' + err.message);
  }
}

log('Starting HA → iCUE bridge');
log('Polling scenes every ' + (POLL_INTERVAL / 1000) + 's');
log('scene.off → Sons of the Forest profile (RGB off)');

pollScenes();
setInterval(pollScenes, POLL_INTERVAL);
