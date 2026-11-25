// Minimal in-memory IndexedDB used by the Node test-suite. It implements only
// the subset used by lib/core.js: open/upgrade, object stores, indexes and
// asynchronous requests/transactions.
const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

class Req {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

function makeRequest(tx, fn) {
  const r = new Req();
  tx.pending++;
  setTimeout(() => {
    try {
      r.result = fn();
      try { if (r.onsuccess) r.onsuccess(); } catch (e) { tx.fail(e); }
    } catch (e) {
      r.error = e;
      try { if (r.onerror) r.onerror(e); else tx.fail(e); } catch (e2) { tx.fail(e2); }
    } finally {
      tx.pending--;
      tx.maybeComplete();
    }
  }, 0);
  return r;
}

function makeStore(name, opts = {}) {
  const store = {
    name, keyPath: opts.keyPath || null, autoIncrement: !!opts.autoIncrement,
    data: new Map(), indexes: new Map(), nextId: 1
  };
  store.indexNames = { contains: n => store.indexes.has(n) };
  store.createIndex = (iname, ipath) => { if (!store.indexes.has(iname)) store.indexes.set(iname, { name: iname, keyPath: ipath }); };
  store.keyOf = (item) => {
    if (store.keyPath && item[store.keyPath] != null) {
      const k = item[store.keyPath];
      if (typeof k === 'number' && k >= store.nextId) store.nextId = k + 1;
      return k;
    }
    if (store.autoIncrement) {
      const k = store.nextId++;
      if (store.keyPath) item[store.keyPath] = k;
      return k;
    }
    throw new Error('KeyPath/autoIncrement required for ' + store.name);
  };
  store.index = (iname) => {
    const ix = store.indexes.get(iname);
    if (!ix) throw new Error('No index ' + iname + ' on ' + store.name);
    return {
      getAll: (key) => makeRequest(store.__tx, () => {
        let vals = [...store.data.values()];
        if (key !== undefined) vals = vals.filter(v => getPath(v, ix.keyPath) === key);
        return vals.map(clone);
      }),
      count: (key) => makeRequest(store.__tx, () => {
        let vals = [...store.data.values()];
        if (key !== undefined) vals = vals.filter(v => getPath(v, ix.keyPath) === key);
        return vals.length;
      })
    };
  };
  return store;
}

function wrapStore(tx, store) {
  const bound = Object.create(store);
  bound.__tx = tx;
  bound.get = key => makeRequest(tx, () => { const v = store.data.get(key); return v == null ? undefined : clone(v); });
  bound.getAll = () => makeRequest(tx, () => [...store.data.values()].map(clone));
  bound.count = () => makeRequest(tx, () => store.data.size);
  bound.add = item => makeRequest(tx, () => {
    const it = clone(item); const k = store.keyOf(it);
    if (store.data.has(k)) throw new Error('ConstraintError: duplicate key ' + k);
    store.data.set(k, it); return k;
  });
  bound.put = item => makeRequest(tx, () => {
    const it = clone(item); const k = store.keyOf(it);
    store.data.set(k, it); return k;
  });
  bound.delete = key => makeRequest(tx, () => { store.data.delete(key); return undefined; });
  bound.clear = () => makeRequest(tx, () => { store.data.clear(); return undefined; });
  bound.index = iname => {
    const ix = store.indexes.get(iname);
    if (!ix) throw new Error('No index ' + iname + ' on ' + store.name);
    return {
      getAll: (key) => makeRequest(tx, () => {
        let vals = [...store.data.values()];
        if (key !== undefined) vals = vals.filter(v => getPath(v, ix.keyPath) === key);
        return vals.map(clone);
      }),
      count: (key) => makeRequest(tx, () => {
        let vals = [...store.data.values()];
        if (key !== undefined) vals = vals.filter(v => getPath(v, ix.keyPath) === key);
        return vals.length;
      })
    };
  };
  return bound;
}

function makeTx(db, names) {
  const list = Array.isArray(names) ? names : [names];
  const tx = {
    pending: 0, completed: false, error: null, oncomplete: null, onerror: null, onabort: null,
    objectStore(name) {
      if (!list.includes(name)) throw new Error('Store ' + name + ' not in transaction');
      const s = db.stores.get(name);
      if (!s) throw new Error('No object store ' + name);
      return wrapStore(tx, s);
    },
    fail(e) {
      if (tx.error) return;
      tx.error = e;
      setTimeout(() => {
        try { if (tx.onerror) tx.onerror(e); } catch (_) { }
        try { if (tx.onabort) tx.onabort(); } catch (_) { }
      }, 0);
    },
    abort() { tx.fail(new Error('aborted')); },
    maybeComplete() {
      if (tx.completed || tx.error || tx.pending > 0) return;
      setTimeout(() => {
        if (tx.completed || tx.error || tx.pending > 0) return;
        tx.completed = true;
        try { if (tx.oncomplete) tx.oncomplete(); } catch (e) { tx.fail(e); }
      }, 0);
    }
  };
  setTimeout(() => tx.maybeComplete(), 0);
  return tx;
}

const DBS = new Map();

function createDB(name) {
  const db = {
    name, version: 0, stores: new Map(), onversionchange: null,
    objectStoreNames: { contains: n => db.stores.has(n) },
    createObjectStore: (n, opts = {}) => {
      const s = makeStore(n, opts);
      db.stores.set(n, s);
      return s;
    },
    deleteObjectStore: n => db.stores.delete(n),
    transaction: (names) => makeTx(db, names),
    close() { }
  };
  return db;
}

const indexedDB = {
  open(name, version) {
    const req = new Req();
    setTimeout(() => {
      let db = DBS.get(name);
      if (!db) { db = createDB(name); DBS.set(name, db); }
      const v = version || 1;
      if (v < db.version) {
        req.error = new Error('VersionError');
        if (req.onerror) req.onerror(req.error);
        return;
      }
      req.result = db;
      if (v > db.version) {
        const upgradeTx = {
          objectStore: (n) => {
            const s = db.stores.get(n);
            if (!s) throw new Error('No object store ' + n);
            return s;
          },
          abort() { }
        };
        req.transaction = upgradeTx;
        if (req.onupgradeneeded) req.onupgradeneeded();
        db.version = v;
      }
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }
};

module.exports = { indexedDB, DBS, reset: () => DBS.clear() };
