// Local demo server for the private /remote page. It serves web/ and returns a
// sample snapshot built from the test fixtures. This is for UI testing only;
// use Netlify + a real extension upload for production.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LPCat, LPParse } = require('../lib/core.js');

const root = path.join(__dirname, '..', 'web');
const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'demo', capturedAt: Date.now() });
const demoNow = Date.now();
up.fixtures.forEach((f, i) => { f.close = demoNow + 5 * 60e3 + i * 1000; f.betClose = f.close; f.ts = demoNow; });
const cat = LPCat.buildMap(init);
const snapshot = {
  schema: 1, version: 'demo', source: 'leagueplus-extension', generatedAt: Date.now(),
  lastCaptureAt: Date.now(),
  catalogue: { markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [] },
  games: init.games, fixtures: up.fixtures, selsets: up.selsets,
  active: null,
  performance: {
    counts: { predictions: 0, settlements: 0, pending: 0, noBets: 0, bets: 0 },
    modelLeaderboard: [], calibration: {},
    bets: { n: 0, wins: 0, losses: 0, winRate: null, staked: 0, profit: 0, roi: null, flatProfit: 0, flatRoi: null, avgStake: null, maxStake: null, maxDrawdown: 0, maxDrawdownPct: 0, rows: [], byMarket: {}, byComp: {}, byPolicy: {}, byCheckpoint: {} },
    bankroll: { start: 1000, end: 1000, unitValue: 10, change: 0, changePct: 0, maxDrawdown: 0, maxDrawdownPct: 0, curve: [] },
    clv: { n: 0, avgPriceClv: null, positiveShare: null, betN: 0, betAvgPriceClv: null, rows: [] },
    warnings: ['Demo snapshot: no ledger performance.']
  },
  ledger: { recentPredictions: [], recentSettlements: [] },
  counts: { matches: 0, rounds: 0, predictions: 0, settlements: 0, catalogues: 1, conflicts: 0, quality: 0 },
  warnings: ['Demo snapshot from test fixtures.']
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0];
  if (url === '/api/session') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); return; }
  if (url === '/api/snapshot') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(snapshot)); return; }
  if (url === '/api/login' || url === '/api/logout') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); return; }
  let p = decodeURIComponent(url);
  if (p === '/' || p === '/remote') p = '/remote.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', types[path.extname(f)] || 'text/plain');
    res.end(d);
  });
});
const port = Number(process.env.PORT || 8125);
server.listen(port, () => console.log('serving remote demo on http://localhost:' + port + '/remote'));
