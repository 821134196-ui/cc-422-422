'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createServices, DomainError } = require('./domain');
const { createChargerAdapter } = require('./charger');
const { createScheduler } = require('./tasks');
const { buildState } = require('./queries');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT || 8080);
const DB_FILE = process.env.DB_FILE || 'data/turnover.db';

function createApp({ reseed, startScheduler = true } = {}) {
  const db = openDb(DB_FILE);
  const empty = db.prepare('SELECT COUNT(*) n FROM staff').get().n === 0;
  if (reseed === true || (reseed === undefined && empty)) seed(db);
  const svc = createServices(db);
  const adapter = createChargerAdapter(svc, {
    // 让演示里故障概率低一些，主要靠手动/播种展示故障态
    failRate: 0.06, contactRate: 0.04,
  });
  const scheduler = createScheduler(svc, adapter, { intervalMs: 6000 });
  if (startScheduler) scheduler.start();

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const routes = [];
  const route = (method, re, handler) => routes.push({ method, re, handler });

  route('GET', /^\/api\/state$/, () => ({ ok: true, state: buildState(db) }));
  route('POST', /^\/api\/debug\/tick$/, () => ({ ok: true, report: scheduler.tick() }));
  route('POST', /^\/api\/shows\/(\d+)\/status$/, (m, b) => svc.setShowStatus(Number(m[1]), b.status));

  route('POST', /^\/api\/checklists$/, (m, b) => {
    const id = svc.createChecklist(Number(b.show_id), String(b.role_name || ''), b.assignee_id ? Number(b.assignee_id) : null);
    return { ok: true, id };
  });
  route('POST', /^\/api\/checklists\/(\d+)\/items$/, (m, b) =>
    svc.addKitItem(Number(m[1]), b.kind, Number(b.ref_id), b.is_spare ? 1 : 0));
  route('DELETE', /^\/api\/items\/(\d+)$/, (m, b) =>
    svc.removeKitItem(Number(b.checklist_id), Number(m[1])));
  route('POST', /^\/api\/checklists\/(\d+)\/lock$/, (m, b) =>
    svc.lockChecklist(Number(b.staff_id), Number(m[1])));
  route('POST', /^\/api\/checklists\/(\d+)\/scan$/, (m, b) =>
    svc.scanReturn(Number(b.staff_id), Number(m[1]), b.kind, Number(b.ref_id), b.note || ''));
  route('POST', /^\/api\/checklists\/(\d+)\/settle$/, (m, b) =>
    svc.settleChecklist(Number(b.staff_id), Number(m[1]), Array.isArray(b.exceptions) ? b.exceptions : []));

  route('POST', /^\/api\/slots\/(\d+)\/dock$/, (m, b) =>
    svc.dockBattery(Number(b.staff_id), Number(m[1]), Number(b.battery_id)));
  route('POST', /^\/api\/slots\/(\d+)\/undock$/, (m, b) =>
    svc.undockBattery(Number(b.staff_id), Number(m[1])));
  route('POST', /^\/api\/slots\/(\d+)\/receipt$/, (m, b) =>
    svc.receiveReceipt(Number(m[1]), b));
  route('POST', /^\/api\/slots\/(\d+)\/receipt-ooo$/, (m, b) => {
    const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(Number(m[1]));
    return { ok: true, ...adapter.emitOutOfOrder(slot, b.later || {}, b.earlier || {}) };
  });

  route('POST', /^\/api\/mics\/(\d+)\/freq$/, (m, b) =>
    svc.setMicFrequency(Number(b.staff_id), Number(m[1]), b.freq_mhz));
  route('POST', /^\/api\/mics\/(\d+)\/flag-freq$/, (m, b) =>
    svc.flagWrongFreq(Number(b.staff_id), Number(m[1]), b.detail || ''));

  route('POST', /^\/api\/batteries\/(\d+)\/review-request$/, (m, b) =>
    svc.requestRelease(Number(b.staff_id), Number(m[1])));
  route('POST', /^\/api\/batteries\/(\d+)\/review$/, (m, b) =>
    svc.reviewRelease(Number(b.staff_id), Number(m[1]), !!b.approved, b.comment || ''));

  route('POST', /^\/api\/faults\/(\d+)\/close$/, (m, b) =>
    svc.closeFault(Number(b.staff_id), Number(m[1]), b.resolution || ''));

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const PUBLIC = path.join(__dirname, '..', 'public');

  function serveStatic(req, res) {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(PUBLIC, urlPath));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    if (!urlPath.startsWith('/api/')) return serveStatic(req, res);
    let body = {};
    if (req.method === 'POST' || req.method === 'DELETE') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: 'JSON 解析失败' }); } }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = urlPath.match(r.re);
      if (!m) continue;
      try {
        const result = await r.handler(m, body);
        return send(res, 200, result ?? { ok: true });
      } catch (e) {
        if (e instanceof DomainError) {
          return send(res, 400, { ok: false, error: e.message, code: e.code, ...e.extra, conflicts: e.conflicts, missing: e.missing });
        }
        console.error(e);
        return send(res, 500, { ok: false, error: '服务器内部错误' });
      }
    }
    send(res, 404, { ok: false, error: '未知接口' });
  });

  return { server, db, svc, adapter, scheduler, listen: (...args) => server.listen(...(args.length ? args : [PORT])) };
}

if (require.main === module) {
  const app = createApp();
  app.listen();
  console.log(`\n  演艺场馆麦克风电池周转系统  →  http://localhost:${PORT}\n  数据文件：${DB_FILE}（已重建演示数据）\n`);
}

module.exports = { createApp };
