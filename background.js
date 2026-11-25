importScripts(
  'lib/core.js', 'lib/model.js', 'lib/stats.js', 'lib/modelEval.js',
  'lib/calibration.js', 'lib/weights.js', 'lib/decision.js', 'lib/accumulator.js',
  'lib/sequence.js', 'lib/patterns.js', 'lib/specialists.js', 'lib/learn.js',
  'lib/performance.js', 'lib/ledger.js', 'lib/cloud.js'
);
try { if (typeof LPLedger !== 'undefined') LPSync.configure({ ledger: LPLedger, learning: typeof LPLearn !== 'undefined' ? LPLearn : null }); } catch (e) { }
// League Plus rounds are ~6 minutes in the main games and ~3.5 minutes in
// Sonic; each match lasts 60 seconds. Instead of polling every game every 30
// seconds we schedule one alarm per game at the next meaningful event
// (result ready, or a closing-price check). A 10-minute fallback alarm recovers
// from missed one-shot alarms or a suspended service worker. A separate
// hourly learning alarm refits calibrators/weights only when enough new data
// has arrived; it never blocks the capture path.
async function ensureAlarms() {
  try { await LPDB.ready(); } catch (e) { }
  try {
    // Remove the old v1 30-second polling alarm if it survived the upgrade.
    const old = await chrome.alarms.get('lpSync');
    if (old) chrome.alarms.clear('lpSync');
  } catch (e) { }
  try {
    const a = await chrome.alarms.get('lpSyncFallback');
    if (!a) chrome.alarms.create('lpSyncFallback', { periodInMinutes: 10, delayInMinutes: 1 });
  } catch (e) { }
  try {
    const l = await chrome.alarms.get('lpLearn');
    if (!l) chrome.alarms.create('lpLearn', { periodInMinutes: 60, delayInMinutes: 5 });
  } catch (e) { }
  try { await LPSync.ensureSchedules(); } catch (e) { }
}
async function runLearning(opts = {}) {
  try {
    await LPDB.ready();
    const r = typeof LPLearn !== 'undefined' ? await LPLearn.refresh(Object.assign({ db: LPDB }, opts)) : { ok: false, error: 'learning module not loaded' };
    try {
      await LPSync.updateStatus({
        lastLearning: Date.now(),
        learning: {
          at: Date.now(), ok: !!r.ok, skipped: !!r.skipped, reason: r.reason || null,
          state: r.state || null, status: r.status || null,
          calibration: r.calibration || null, weights: r.weights || null,
          error: r.error || null
        }
      });
    } catch (e) { }
    try { if (typeof LPCloud !== 'undefined') await LPCloud.maybeUpload({ db: LPDB, force: true, reason: 'learning', lastCaptureAt: Date.now() }); } catch (e) { }
    return r;
  } catch (e) {
    try { await LPSync.updateStatus({ learning: { at: Date.now(), ok: false, error: e.message } }); } catch (e2) { }
    return { ok: false, error: e.message };
  }
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'lpLearn') { runLearning(); return; }
  if (a.name === 'lpSyncFallback') { lpSync(); return; }
  if (a.name && a.name.indexOf('lpG:') === 0) { lpSyncGame(+a.name.slice(4)); return; }
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && msg.type === 'lpSyncNow') {
    lpSync().then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpSyncGame') {
    lpSyncGame(+msg.gameId).then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpLearnNow') {
    runLearning({ force: true }).then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpReady') {
    LPDB.ready().then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpLearnConfig') {
    LPLearn.setConfig(LPDB, msg.config || {}, { by: 'dashboard' }).then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpActivate') {
    LPLearn.activate(LPDB, msg.version || null, { by: 'dashboard', reason: msg.reason || 'manual activation', force: !!msg.force }).then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'lpRollback') {
    LPLearn.rollback(LPDB, msg.version === undefined ? null : msg.version, { by: 'dashboard' }).then(send).catch(e => send({ ok: false, error: e.message }));
    return true;
  }
});
ensureAlarms();
