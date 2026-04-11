// Reads leads-raw.tsv (tab-separated from Google Sheets) and outputs leads.json
const fs = require('fs');
const path = require('path');

const TSV = path.join(__dirname, 'leads-raw.tsv');
const OUT = path.join(__dirname, 'leads.json');

const headers = ['business','industry','location','phone','email','score','tier','demoSite','status','notes','outreachMethod','script','emailSent','followUp','response','dateSent'];

const lines = fs.readFileSync(TSV, 'utf8').trim().split('\n');
const leads = [];

for (const line of lines) {
  const cols = line.split('\t');
  if (!cols[0] || cols[0].trim() === '') continue;
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = (cols[i] || '').trim();
  });
  obj.score = parseInt(obj.score) || 0;
  leads.push(obj);
}

// Sort by score descending
leads.sort((a, b) => b.score - a.score);

fs.writeFileSync(OUT, JSON.stringify(leads, null, 2));
console.log(`Wrote ${leads.length} leads to ${OUT}`);
