'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'ip-email-map.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d));
}

/** Store email+name associated with an IP (from PIX form) */
function storeIpEmail(ip, email, name) {
  if (!ip || !email) return;
  const d = load();
  d[ip] = { email, name: name || null, storedAt: Date.now() };
  save(d);
}

/** Get email+name for an IP, or null */
function getIpEmail(ip) {
  if (!ip) return null;
  const d = load();
  return d[ip] || null;
}

/** Track whether first-capture email was sent for an identifier */
function claimFirstCaptureEmail(identifier) {
  if (!identifier) return false;
  const d = load();
  const key = `sent:${identifier}`;
  if (d[key]) return false;
  d[key] = true;
  save(d);
  return true;
}

module.exports = { storeIpEmail, getIpEmail, claimFirstCaptureEmail };
