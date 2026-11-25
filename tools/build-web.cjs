#!/usr/bin/env node
// Build the standalone Netlify slip-builder site.
// Copies the shared browser modules into web/lib so the publish directory is
// self-contained. Run locally with: node tools/build-web.cjs
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const lib = path.join(web, 'lib');

fs.mkdirSync(lib, { recursive: true });
for (const name of ['core.js', 'model.js', 'slip.js']) {
  fs.copyFileSync(path.join(root, 'lib', name), path.join(lib, name));
  console.log('copied lib/' + name + ' -> web/lib/' + name);
}
fs.copyFileSync(path.join(root, 'dashboard.css'), path.join(web, 'dashboard.css'));
console.log('copied dashboard.css -> web/dashboard.css');
