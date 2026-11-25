const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (p === '/') p = '/dashboard.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', types[path.extname(f)] || 'text/plain');
    res.end(d);
  });
});
server.listen(8123, () => console.log('serving http://localhost:8123'));
