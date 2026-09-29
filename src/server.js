'use strict';
// 零依赖 HTTP 服务：JSON API + 六个静态页面
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const core = require('./core');
const { seed } = require('./seed');
const { TaskRunner } = require('./tasks');

const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(__dirname, '..', 'public');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
const db = openDb(dbFile);

// 单命令启动：数据库为空时自动播种演出前后周转样例
function ensureSeeded() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  if (n === 0) {
    seed(db);
    console.log('🧩 已自动创建演出前后周转样例数据');
  }
}
ensureSeeded();

const tasks = new TaskRunner(db, { intervalMs: Number(process.env.TICK_MS || 5000) });
tasks.start();

// ---------------------------------------------------------------------------
// 会话：cookie uid
function currentUser(req) {
  const m = /(?:^|;\s*)uid=(\d+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  return db.prepare('SELECT * FROM staff WHERE id=?').get(Number(m[1])) || null;
}
function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BIZ' })); }
    });
    req.on('error', reject);
  });
}

function handler(fn) {
  return async (req, res, params) => {
    try {
      const user = currentUser(req) || { id: null, name: '未登录', role: null };
      await fn(req, res, { user, params, body: req.method === 'GET' ? {} : await readBody(req) });
    } catch (e) {
      if (e.code === 'FORBIDDEN') return sendJson(res, 403, { error: e.message });
      if (e.code === 'BIZ') return sendJson(res, 400, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: '服务器内部错误：' + e.message });
    }
  };
}

const routes = [];
const r = (method, re, fn) => routes.push({ method, re, fn: handler(fn) });

// 会话
r('POST', /^\/api\/login$/, (_q, s, { body }) => {
  const staff = db.prepare('SELECT * FROM staff WHERE id=?').get(Number(body.staff_id));
  if (!staff) throw Object.assign(new Error('人员不存在'), { code: 'BIZ' });
  sendJson(s, 200, staff, { 'Set-Cookie': `uid=${staff.id}; Path=/; HttpOnly; SameSite=Lax` });
});
r('POST', /^\/api\/logout$/, (_q, s) => {
  sendJson(s, 200, { ok: true }, { 'Set-Cookie': 'uid=; Path=/; Max-Age=0' });
});
r('GET', /^\/api\/me$/, (_q, s, { user }) => sendJson(s, 200, { user, permissions: user ? core.PERMISSIONS[user.role] : [] }));
r('GET', /^\/api\/staff$/, (_q, s) => sendJson(s, 200, core.listStaff(db)));

// 主数据
r('GET', /^\/api\/shows$/, (_q, s) => sendJson(s, 200, core.listShows(db)));
r('POST', /^\/api\/shows$/, (_q, s, { user, body }) => {
  core.assertCan(user.role, 'show:create');
  const info = db.prepare('INSERT INTO shows (name, venue, start_at, end_at) VALUES (?,?,?,?)')
    .run(body.name, body.venue, body.start_at, body.end_at);
  sendJson(s, 200, { id: Number(info.lastInsertRowid) });
});
r('GET', /^\/api\/batteries$/, (_q, s) => sendJson(s, 200, core.listBatteries(db)));
r('GET', /^\/api\/microphones$/, (_q, s) => sendJson(s, 200, core.listMicrophones(db)));
r('GET', /^\/api\/beltpacks$/, (_q, s) => sendJson(s, 200, core.listBeltpacks(db)));

// 充电柜
r('GET', /^\/api\/chargers$/, (_q, s) => sendJson(s, 200, core.chargerGrid(db)));
r('POST', /^\/api\/dock$/, (_q, s, { user, body }) =>
  sendJson(s, 200, core.dockBattery(db, user, body.battery_code, body.charger_code, Number(body.position))));
r('POST', /^\/api\/eject$/, (_q, s, { user, body }) =>
  sendJson(s, 200, core.ejectBattery(db, user, body.charger_code, Number(body.position))));
r('POST', /^\/api\/receipt$/, (_q, s, { body }) =>
  sendJson(s, 200, { queued: core.receiveReceipt(db, body), applied: core.applyReceipts(db) }));
r('GET', /^\/api\/receipts$/, (_q, s) =>
  sendJson(s, 200, db.prepare('SELECT slot_code, battery_code, seq, event, charge_pct, applied, received_at FROM slot_receipts ORDER BY id DESC LIMIT 30').all()));

// 隔离复核
r('POST', /^\/api\/batteries\/(\d+)\/release-request$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.requestRelease(db, user, Number(params[0]), body.note)));
r('POST', /^\/api\/batteries\/(\d+)\/review$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.reviewRelease(db, user, Number(params[0]), body.decision, body.note)));

// 领用清单 / 设备套装
r('GET', /^\/api\/checklists$/, (_q, s) => sendJson(s, 200, core.listChecklists(db)));
r('GET', /^\/api\/checklists\/(\d+)$/, (_q, s, { params }) => {
  const cl = core.getChecklist(db, Number(params[0]));
  if (!cl) return sendJson(s, 404, { error: '清单不存在' });
  sendJson(s, 200, cl);
});
r('GET', /^\/api\/shows\/(\d+)\/checklist$/, (_q, s, { params }) =>
  sendJson(s, 200, core.getChecklistByShow(db, Number(params[0]))));
r('POST', /^\/api\/checklists$/, (_q, s, { user, body }) =>
  sendJson(s, 200, core.createChecklist(db, user, Number(body.show_id))));
r('POST', /^\/api\/checklists\/(\d+)\/items$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.addItem(db, user, Number(params[0]), body)));
r('DELETE', /^\/api\/items\/(\d+)$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.removeItem(db, user, Number(params[0]))));
r('POST', /^\/api\/checklists\/(\d+)\/lock$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.lockChecklist(db, user, Number(params[0]))));
r('POST', /^\/api\/checklists\/(\d+)\/issue$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.issueChecklist(db, user, Number(params[0]))));

// 归还检测
r('POST', /^\/api\/checklists\/(\d+)\/scan$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.scanReturn(db, user, Number(params[0]), body.code)));
r('POST', /^\/api\/checklists\/(\d+)\/settle$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.settleChecklist(db, user, Number(params[0]), body.note)));
r('GET', /^\/api\/checklists\/(\d+)\/scans$/, (_q, s, { params }) =>
  sendJson(s, 200, db.prepare('SELECT * FROM return_scans WHERE checklist_id=? ORDER BY id').all(Number(params[0]))));

// 错频
r('GET', /^\/api\/shows\/(\d+)\/freq$/, (_q, s, { params }) =>
  sendJson(s, 200, core.listFreqPlan(db, Number(params[0]))));
r('POST', /^\/api\/shows\/(\d+)\/freq-check$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.checkFrequencies(db, user, Number(params[0]))));
r('POST', /^\/api\/microphones\/(\d+)\/freq$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.fixFrequency(db, user, Number(params[0]), Number(body.freq_mhz))));

// 故障队列
r('GET', /^\/api\/faults$/, (req, s) => {
  const url = new URL(req.url, 'http://x');
  sendJson(s, 200, core.listFaults(db, url.searchParams.get('status') || 'open'));
});
r('POST', /^\/api\/faults\/(\d+)\/ack$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.acknowledgeFault(db, user, Number(params[0]))));
r('POST', /^\/api\/faults\/(\d+)\/resolve$/, (_q, s, { user, params, body }) =>
  sendJson(s, 200, core.resolveFault(db, user, Number(params[0]), body.resolution)));
r('POST', /^\/api\/faults\/(\d+)\/lost$/, (_q, s, { user, params }) =>
  sendJson(s, 200, core.markLost(db, user, Number(params[0]))));

// 进程任务（演示：手动推进一拍；读取提醒）
r('POST', /^\/api\/tasks\/tick$/, (_q, s) => sendJson(s, 200, tasks.tick()));
r('GET', /^\/api\/alerts$/, (_q, s) => sendJson(s, 200, tasks.drainAlerts()));

// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    for (const rt of routes) {
      if (rt.method !== req.method) continue;
      const m = rt.re.exec(pathname);
      if (m) return rt.fn(req, res, m.slice(1));
    }
    return sendJson(res, 404, { error: '接口不存在' });
  }
  // 静态页
  let file = pathname === '/' ? '/index.html' : pathname;
  const fp = path.normalize(path.join(PUB, file));
  if (!fp.startsWith(PUB)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (e, data) => {
    if (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('页面不存在');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🎤 无线麦克风电池周转系统已启动：http://localhost:${PORT}`);
    console.log(`   数据库：${dbFile}`);
    console.log('   演示岗位：舞台监督 周婉清 / 音响师 陈牧野 / 库房管理员 何砚舟、林知夏');
  });
}

module.exports = { server, db };
