'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, ROLES } = require('../src/db');
const { createServices } = require('../src/domain');
const { createChargerAdapter } = require('../src/charger');

// ---------- 夹具 ----------
function harness() {
  const db = openDb(':memory:');
  let clock = 0;
  const svc = createServices(db, () => `2026-09-29T12:0${clock++}:00.000Z`);
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const staffIds = {};
  for (const [key, role] of Object.entries(ROLES)) {
    staffIds[key === 'AUDIO' ? 'audio' : key === 'STAGE' ? 'stage' : key === 'TECH' ? 'tech' : 'manager'] =
      ins('INSERT INTO staff(name, role) VALUES(?,?)', key, role);
  }
  const showId = ins("INSERT INTO shows(name, start_at, end_at, status) VALUES('测试场','2026-09-29T19:30','2026-09-29T21:00','scheduled')");
  const mic = (code = 'M1') => ins('INSERT INTO microphones(code, freq_mhz) VALUES(?,500)', code);
  const pack = (code = 'P1') => ins('INSERT INTO beltpacks(code) VALUES(?)', code);
  const bat = (code, charge = 100, health = 100, status = 'active') =>
    ins('INSERT INTO batteries(code, charge_pct, health_pct, status) VALUES(?,?,?,?)', code, charge, health, status);
  const cabinet = ins("INSERT INTO cabinets(name) VALUES('C')");
  const slot = (pos = 'S1') => ins('INSERT INTO slots(cabinet_id, position) VALUES(?,?)', cabinet, pos);

  const makeLockedKit = (role, items) => {
    const cl = svc.createChecklist(showId, role, staffIds.stage);
    for (const it of items) svc.addKitItem(cl, it.kind, it.id, it.spare ? 1 : 0);
    svc.lockChecklist(staffIds.stage, cl);
    return cl;
  };

  return { db, svc, ids: staffIds, showId, mic, pack, bat, slot, makeLockedKit };
}

// ========== 1. 套装唯一性 ==========
test('同一电池不能同时出现在两张已锁定清单；先锁定者占用', () => {
  const h = harness();
  const b1 = h.bat('B1');
  const m1 = h.mic('M1'), m2 = h.mic('M2');

  h.makeLockedKit('角色甲', [{ kind: 'mic', id: m1 }, { kind: 'battery', id: b1 }]);

  const cl2 = h.svc.createChecklist(h.showId, '角色乙', h.ids.stage);
  h.svc.addKitItem(cl2, 'mic', m2);
  h.svc.addKitItem(cl2, 'battery', b1);
  assert.equal(e2code(() => h.svc.lockChecklist(h.ids.stage, cl2)), 'kit_conflict');

  // 草稿仍允许配置（未占用），但锁定被拦
  const rows = h.db.prepare('SELECT * FROM holds WHERE kind=? AND ref_id=?').all('battery', b1);
  assert.equal(rows.length, 1, 'holds 只属于第一张单');
});

test('归还释放占用后，电池可以进入新套装', () => {
  const h = harness();
  const b1 = h.bat('B1'), m1 = h.mic('M1');
  const cl = h.makeLockedKit('角色甲', [{ kind: 'mic', id: m1 }, { kind: 'battery', id: b1 }]);
  h.svc.scanReturn(h.ids.tech, cl, 'mic', m1);
  h.svc.scanReturn(h.ids.tech, cl, 'battery', b1);
  h.svc.settleChecklist(h.ids.stage, cl, []);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM holds').get().n, 0);

  const m2 = h.mic('M2');
  const cl2 = h.makeLockedKit('角色乙', [{ kind: 'mic', id: m2 }, { kind: 'battery', id: b1 }]);
  assert.ok(cl2 > 0);
});

test('已隔离电池不能加入任何套装', () => {
  const h = harness();
  const b = h.bat('BX', 100, 70, 'isolated');
  const cl = h.svc.createChecklist(h.showId, 'r', h.ids.stage);
  assert.equal(e2code(() => h.svc.addKitItem(cl, 'battery', b)), 'battery_isolated');
});

// ========== 2. 充电回执乱序 ==========
test('乱序回执：仅 seq 更新的一帧生效，旧帧不回退电量', () => {
  const h = harness();
  const b = h.bat('B1', 30, 99);
  const s = h.slot('A1');
  h.svc.dockBattery(h.ids.tech, s, b); // dock 后 last_seq=1

  h.svc.receiveReceipt(s, { seq: 2, battery_id: b, result: 'charging', charge_pct: 45, health_pct: 99 });
  h.svc.receiveReceipt(s, { seq: 5, battery_id: b, result: 'charging', charge_pct: 80, health_pct: 99 });
  // 迟到的 seq=3/4 必须丢弃
  const stale = h.svc.receiveReceipt(s, { seq: 3, battery_id: b, result: 'charging', charge_pct: 50, health_pct: 99 });
  assert.equal(stale.applied, false);
  const stale2 = h.svc.receiveReceipt(s, { seq: 5, battery_id: b, result: 'charging', charge_pct: 10, health_pct: 99 });
  assert.equal(stale2.applied, false, '相同 seq 也不重复应用');

  const got = h.db.prepare('SELECT charge_pct FROM batteries WHERE id=?').get(b);
  assert.equal(got.charge_pct, 80);
  const slotRow = h.db.prepare('SELECT last_seq, state FROM slots WHERE id=?').get(s);
  assert.equal(slotRow.last_seq, 5);
  const dropped = h.db.prepare('SELECT COUNT(*) n FROM receipt_events WHERE applied=0').get().n;
  assert.equal(dropped, 2, '两帧旧回执留痕但未应用');
});

test('适配器模拟硬件乱序到达（新帧先到，旧帧后到）结果一致', () => {
  const h = harness();
  const adapter = createChargerAdapter(h.svc, { random: () => 0.9 });
  const b = h.bat('B1', 30, 99);
  const s = h.slot('A1');
  h.svc.dockBattery(h.ids.tech, s, b);
  const slotRow = () => h.db.prepare('SELECT * FROM slots WHERE id=?').get(s);
  const r = adapter.emitOutOfOrder(slotRow(),
    { result: 'charging', charge_pct: 88, health_pct: 99 },
    { result: 'charging', charge_pct: 35, health_pct: 99 });
  assert.equal(r.applied_newer.applied, true);
  assert.equal(r.applied_older.applied, false);
  assert.equal(h.db.prepare('SELECT charge_pct FROM batteries WHERE id=?').get(b).charge_pct, 88);
});

test('充电失败与接触不良进入故障队列', () => {
  const h = harness();
  const b = h.bat('B1', 20, 99);
  const s = h.slot('A1');
  h.svc.dockBattery(h.ids.tech, s, b);
  h.svc.receiveReceipt(s, { seq: 2, battery_id: b, result: 'charge_failed' });
  h.svc.receiveReceipt(s, { seq: 3, battery_id: b, result: 'contact_fault' });
  const types = h.db.prepare("SELECT type FROM faults WHERE status='open' ORDER BY id").all().map(r => r.type);
  assert.ok(types.includes('charge_failed'));
  assert.ok(types.includes('contact_fault'));
  assert.equal(h.db.prepare("SELECT state FROM slots WHERE id=?").get(s).state, 'contact_fault');
});

test('充满回执使循环次数 +1', () => {
  const h = harness();
  const b = h.bat('B1', 60, 99);
  const s = h.slot();
  h.svc.dockBattery(h.ids.tech, s, b);
  h.svc.receiveReceipt(s, { seq: 2, battery_id: b, result: 'ready', charge_pct: 100, health_pct: 99 });
  assert.equal(h.db.prepare('SELECT cycles, charge_pct FROM batteries WHERE id=?').get(b).cycles, 1);
  // 再来 ready 帧不应重复计数
  h.svc.receiveReceipt(s, { seq: 3, battery_id: b, result: 'ready', charge_pct: 100, health_pct: 99 });
  assert.equal(h.db.prepare('SELECT cycles FROM batteries WHERE id=?').get(b).cycles, 1);
});

// ========== 3. 低电量 / 健康度自动隔离与复核 ==========
test('健康度低于阈值的回执触发自动隔离', () => {
  const h = harness();
  const b = h.bat('B1', 60, 82);
  const s = h.slot();
  h.svc.dockBattery(h.ids.tech, s, b);
  h.svc.receiveReceipt(s, { seq: 2, battery_id: b, result: 'charging', charge_pct: 70, health_pct: 78 });
  const row = h.db.prepare('SELECT * FROM batteries WHERE id=?').get(b);
  assert.equal(row.status, 'isolated');
  assert.match(row.isolated_reason, /78/);
  const f = h.db.prepare("SELECT * FROM faults WHERE type='health' AND ref_id=?").get(b);
  assert.ok(f);
  assert.equal(f.severity, 'block');
});

test('隔离解除双人流程：设备员申请 → 经理复核；健康未达标时禁止批准', () => {
  const h = harness();
  const b = h.bat('B1', 100, 72, 'isolated');
  h.db.prepare("UPDATE batteries SET isolated_reason='健康度 72%' WHERE id=?").run(b);

  // 经理不能直接批准（没有待处理申请）
  assert.equal(e2code(() => h.svc.reviewRelease(h.ids.manager, b, true, 'x')), 'conflict');
  // 设备员发起申请（真实流程中隔离时必伴随 health 故障）
  h.svc.openFault('health', { severity: 'block', ref_kind: 'battery', ref_id: b, detail: '健康度 72%' });
  h.svc.requestRelease(h.ids.tech, b);
  // 调音师不能复核
  assert.equal(e2code(() => h.svc.reviewRelease(h.ids.audio, b, true, 'x')), 'forbidden');
  // 健康度仍 72 < 80：经理批准被系统驳回
  assert.equal(e2code(() => h.svc.reviewRelease(h.ids.manager, b, true, '放行')), 'review_blocked');
  assert.equal(h.db.prepare('SELECT status FROM batteries WHERE id=?').get(b).status, 'isolated');

  // 假设复检后健康度恢复/修正到 84，经理批准
  h.db.prepare('UPDATE batteries SET health_pct=84 WHERE id=?').run(b);
  h.svc.reviewRelease(h.ids.manager, b, true, '复测 84%，准予解除');
  const row = h.db.prepare('SELECT * FROM batteries WHERE id=?').get(b);
  assert.equal(row.status, 'active');
  assert.equal(row.review_status, 'approved');
  assert.equal(h.db.prepare("SELECT status FROM faults WHERE type='health' AND ref_id=?").get(b).status, 'resolved');
});

test('经理可驳回解除申请，电池维持隔离', () => {
  const h = harness();
  const b = h.bat('B1', 100, 60, 'isolated');
  h.svc.requestRelease(h.ids.tech, b);
  h.svc.reviewRelease(h.ids.manager, b, false, '建议报废');
  const row = h.db.prepare('SELECT * FROM batteries WHERE id=?').get(b);
  assert.equal(row.status, 'isolated');
  assert.equal(row.review_status, 'rejected');
});

test('演出中低电量电池产生低电量故障（任务层）', async () => {
  const { createScheduler } = require('../src/tasks');
  const h = harness();
  const adapter = createChargerAdapter(h.svc);
  const sched = createScheduler(h.svc, adapter, { intervalMs: 999999 });
  const b = h.bat('BLIVE', 30, 99);
  const m = h.mic('ML');
  h.db.prepare("UPDATE shows SET status='live' WHERE id=?").run(h.showId);
  h.makeLockedKit('在用角色', [{ kind: 'mic', id: m }, { kind: 'battery', id: b }]);
  // 每次 tick 放电 6~10%，若干次后必低于 20
  for (let i = 0; i < 6; i++) sched.tick();
  const f = h.db.prepare("SELECT * FROM faults WHERE type='low_battery' AND ref_id=?").get(b);
  assert.ok(f, '应产生低电量告警');
  assert.ok(h.db.prepare('SELECT charge_pct FROM batteries WHERE id=?').get(b).charge_pct <= 20);
});

// ========== 4. 漏件处理与迟到回传 ==========
test('缺件未登记例外时结算被拦截并产生漏件故障', () => {
  const h = harness();
  const m = h.mic('M1'), p = h.pack('P1'), b = h.bat('B1');
  const cl = h.makeLockedKit('角色甲', [
    { kind: 'mic', id: m }, { kind: 'pack', id: p }, { kind: 'battery', id: b }]);
  h.svc.scanReturn(h.ids.tech, cl, 'mic', m); // 只还麦克风
  const err = (() => { try { h.svc.settleChecklist(h.ids.stage, cl, []); return null; } catch (e) { return e; } })();
  assert.equal(err.code, 'missing_items');
  assert.equal(err.missing.length, 2);
  const missFaults = h.db.prepare("SELECT COUNT(*) n FROM faults WHERE type='missing_return' AND show_id=?").get(h.showId).n;
  assert.equal(missFaults, 2);
  // 结算未生效：仍是 locked、占用仍在
  assert.equal(h.db.prepare('SELECT status FROM checklists WHERE id=?').get(cl).status, 'locked');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM holds WHERE checklist_id=?').get(cl).n, 3);
});

test('缺件逐条登记例外（丢失）后可结算，设备占用释放', () => {
  const h = harness();
  const m = h.mic('M1'), p = h.pack('P1'), b = h.bat('B1');
  const cl = h.makeLockedKit('角色甲', [
    { kind: 'mic', id: m }, { kind: 'pack', id: p }, { kind: 'battery', id: b }]);
  h.svc.scanReturn(h.ids.tech, cl, 'mic', m);
  const r = h.svc.settleChecklist(h.ids.stage, cl, [
    { kind: 'pack', ref_id: p, reason: '随服装袋带走' },
    { kind: 'battery', ref_id: b, reason: '下落不明' },
  ]);
  assert.deepEqual({ returned: r.returned, lost: r.lost }, { returned: 1, lost: 2 });
  assert.equal(h.db.prepare('SELECT status FROM checklists WHERE id=?').get(cl).status, 'checked_in');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM holds').get().n, 0);
  const lost = h.db.prepare("SELECT ref_kind FROM faults WHERE type='lost' ORDER BY id").all().map(x => x.ref_kind);
  assert.deepEqual(lost.sort(), ['battery', 'pack']);
});

test('清点完成后的迟到回传只挂起，不覆盖清点结果', () => {
  const h = harness();
  const m = h.mic('M1'), p = h.pack('P1');
  const cl = h.makeLockedKit('角色甲', [{ kind: 'mic', id: m }, { kind: 'pack', id: p }]);
  h.svc.scanReturn(h.ids.tech, cl, 'mic', m);
  h.svc.settleChecklist(h.ids.stage, cl, [{ kind: 'pack', ref_id: p, reason: '暂记丢失' }]);

  // 此后腰包“找回来”并扫到回传
  const r = h.svc.scanReturn(h.ids.tech, cl, 'pack', p, '服装袋里找到了');
  assert.equal(r.applied, false);
  const item = h.db.prepare("SELECT * FROM kit_items WHERE kind='pack' AND ref_id=?").get(p);
  assert.equal(item.returned, 0, '已完成清点的归还状态不得被覆盖');
  const scan = h.db.prepare('SELECT * FROM return_scans WHERE kind=? AND ref_id=? ORDER BY id DESC').get('pack', p);
  assert.equal(scan.applied, 0);
  assert.equal(h.db.prepare("SELECT status FROM checklists WHERE id=?").get(cl).status, 'checked_in');
  assert.ok(h.db.prepare("SELECT COUNT(*) n FROM faults WHERE type='late_return' AND ref_id=?").get(p).n >= 1);
});

test('不属于套装的设备扫码归还被拒绝', () => {
  const h = harness();
  const m1 = h.mic('M1'), m2 = h.mic('M2');
  const cl = h.makeLockedKit('角色甲', [{ kind: 'mic', id: m1 }]);
  assert.equal(e2code(() => h.svc.scanReturn(h.ids.tech, cl, 'mic', m2)), 'not_in_kit');
});

// ========== 5. 岗位权限 ==========
test('岗位权限矩阵', () => {
  const h = harness();
  const b = h.bat('B1'), m = h.mic('M1'), s = h.slot();

  // 调音师专属：改频
  h.svc.setMicFrequency(h.ids.audio, m, 555);
  assert.equal(e2code(() => h.svc.setMicFrequency(h.ids.tech, m, 556)), 'forbidden');
  assert.equal(e2code(() => h.svc.setMicFrequency(h.ids.stage, m, 556)), 'forbidden');

  // 设备员专属：充电柜操作
  h.svc.dockBattery(h.ids.tech, s, b);
  assert.equal(e2code(() => h.svc.dockBattery(h.ids.audio, s, b)), 'forbidden');
  assert.equal(e2code(() => h.svc.undockBattery(h.ids.manager, s)), 'forbidden');
  // 设备员发起隔离申请
  h.db.prepare("UPDATE batteries SET status='isolated', review_status='none' WHERE id=?").run(b);
  h.svc.requestRelease(h.ids.tech, b);
  assert.equal(e2code(() => h.svc.requestRelease(h.ids.stage, b)), 'forbidden');
  // 经理专属：复核
  h.db.prepare('UPDATE batteries SET health_pct=90 WHERE id=?').run(b);
  h.svc.reviewRelease(h.ids.manager, b, true, 'ok');
  assert.equal(e2code(() => h.svc.reviewRelease(h.ids.tech, h.bat('B2', 1, 90, 'isolated'), true)), 'forbidden');

  // 舞台主管专属：结算
  const m2 = h.mic('M2');
  const cl = h.makeLockedKit('角色乙', [{ kind: 'mic', id: m2 }]);
  h.svc.scanReturn(h.ids.tech, cl, 'mic', m2);
  h.svc.settleChecklist(h.ids.stage, cl, []);
  const cl2 = h.makeLockedKit('角色丙', [{ kind: 'mic', id: h.mic('M3') }]);
  assert.equal(e2code(() => h.svc.settleChecklist(h.ids.manager, cl2, [])), 'forbidden',
    '经理不能替舞台主管结算（职责分离）');
});

test('锁单权限：舞台主管与经理均可；设备员/调音师不可', () => {
  const h = harness();
  const mk = () => {
    const cl = h.svc.createChecklist(h.showId, 'r', null);
    h.svc.addKitItem(cl, 'mic', h.mic('M' + Math.random().toString(36).slice(2, 6)));
    return cl;
  };
  for (const [who, allowed] of [['stage', true], ['manager', true], ['tech', false], ['audio', false]]) {
    const cl = mk();
    const code = e2code(() => h.svc.lockChecklist(h.ids[who], cl));
    assert.equal(code, allowed ? undefined : 'forbidden', `${who} lock -> ${code}`);
  }
});

test('撞频改频自动产生错频故障，改到空闲频率后自动销案', () => {
  const h = harness();
  const m1id = h.mic('M1'), m2id = h.mic('M2');
  h.svc.setMicFrequency(h.ids.audio, m1id, 614.2);
  const r = h.svc.setMicFrequency(h.ids.audio, m2id, 614.2);
  assert.equal(r.clash, true);
  assert.equal(h.db.prepare('SELECT status FROM microphones WHERE id=?').get(m2id).status, 'fault');
  assert.ok(h.db.prepare("SELECT COUNT(*) n FROM faults WHERE type='wrong_freq' AND ref_id=?").get(m2id).n >= 1);
  h.svc.setMicFrequency(h.ids.audio, m2id, 630.0);
  assert.equal(h.db.prepare('SELECT status FROM microphones WHERE id=?').get(m2id).status, 'ok');
  const openFaults = h.db.prepare("SELECT COUNT(*) n FROM faults WHERE type='wrong_freq' AND ref_id=? AND status IN ('open','pending_review')").get(m2id).n;
  assert.equal(openFaults, 0);
});

// ---------- 工具 ----------
function e2code(fn) {
  try { fn(); return undefined; } catch (e) { return e.code; }
}
