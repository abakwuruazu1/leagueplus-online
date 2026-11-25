// Local preview for the standalone Netlify slip-builder site.
// Serves web/ and proxies /api/odds through the same Netlify function.
const http = require('http');
const fs = require('fs');
const path = require('path');
const odds = require('../netlify/functions/odds.js');

const root = path.join(__dirname, '..', 'web');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = String(req.url || '/').split('?')[0];
  if (url === '/api/odds' || url === '/.netlify/functions/odds') {
    try {
      const r = await odds.handler({});
      res.statusCode = r.statusCode || 200;
      Object.entries(r.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      res.end(r.body);
    } catch (e) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  let p = decodeURIComponent(url);
  if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', types[path.extname(f)] || 'text/plain');
    res.end(d);
  });
});

const port = Number(process.env.PORT || 8124);
server.listen(port, () => console.log('serving web on http://localhost:' + port));
