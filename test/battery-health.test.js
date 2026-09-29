'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const core = require('../src/core');
const { ChargerAdapter } = require('../src/adapter');

// 3. 低电量处理
test('低电量：归还低电量电池与在库低电量巡检均生成低电量故障', () => {
  const { db, staff } = setup();
  db.prepare("UPDATE batteries SET charge_pct=10 WHERE id=1").run();

  const cl = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl.id, { role_name: '甲', spare_battery_id: 1 });
  core.lockChecklist(db, staff.sm, cl.id);
  core.issueChecklist(db, staff.sm, cl.id);

  const r = core.scanReturn(db, staff.wh, cl.id, 'BAT-01');
  assert.ok(r.ok);
  const faults = core.listFaults(db, 'all').filter((f) => f.kind === 'low_battery');
  assert.equal(faults.length, 1);

  // 巡检不重复建单
  core.scanLowBattery(db);
  assert.equal(core.listFaults(db, 'all').filter((f) => f.kind === 'low_battery').length, 1);
});

test('低电量：低于阈值的在库电池入故障，解决后可正常入槽充电', () => {
  const { db, staff } = setup();
  db.prepare("UPDATE batteries SET charge_pct=15 WHERE code='BAT-02'").run();
  const r = core.scanLowBattery(db);
  assert.equal(r.faults_created, 1);
  // 低电量不影响入槽
  assert.doesNotThrow(() => core.dockBattery(db, staff.wh, 'BAT-02', 'CAB-1', 2));
});

// 3b. 健康度低于阈值自动隔离 + 人工解除两步复核
test('健康隔离：SOH<80 自动隔离，产生故障，隔离电池禁止入槽/入套装', () => {
  const { db, staff } = setup();
  const n = core.scanHealth(db);
  assert.equal(n, 1); // BAT-03 SOH=70
  const b = db.prepare("SELECT * FROM batteries WHERE code='BAT-03'").get();
  assert.equal(b.state, 'quarantined');
  assert.equal(b.review_status, 'auto');
  assert.ok(core.listFaults(db, 'all').some((f) => f.kind === 'health_quarantine' && f.ref_id === b.id));

  assert.throws(() => core.dockBattery(db, staff.wh, 'BAT-03', 'CAB-1', 1), /隔离/);
  const cl = core.createChecklist(db, staff.sm, 1);
  assert.throws(() => core.addItem(db, staff.ae, cl.id, { role_name: 'r', spare_battery_id: b.id }), /隔离/);
});

test('健康隔离：充满后 SOH 跌破阈值也会自动隔离', () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  // RB-LITE 每循环 -0.5%；造一块循环 41 / SOH 81 的电池，充满后 42 次 → 79% < 80
  db.prepare("UPDATE batteries SET model='RB-LITE 90', cycles=41, health_pct=81 WHERE code='BAT-02'").run();
  core.dockBattery(db, staff.wh, 'BAT-02', 'CAB-1', 2);
  adapter.simulateCharge('CAB-1:2', 'BAT-02', { startCharge: 10 });
  const b = db.prepare("SELECT * FROM batteries WHERE code='BAT-02'").get();
  assert.equal(b.cycles, 42);
  assert.equal(b.health_pct, 79);
  assert.equal(b.state, 'quarantined');
  assert.equal(b.review_status, 'auto');
  assert.ok(core.listFaults(db, 'all').some((f) => f.kind === 'health_quarantine' && f.ref_id === b.id));
});

test('健康隔离复核：申请人不能复核自己；健康不达标须“降级使用”；双人复核后解除', () => {
  const { db, staff } = setup();
  core.scanHealth(db);
  const id = db.prepare("SELECT id FROM batteries WHERE code='BAT-03'").get().id;

  // 第一步：申请解除
  core.requestRelease(db, staff.wh, id, '复测正常');
  assert.equal(db.prepare('SELECT review_status FROM batteries WHERE id=?').get(id).review_status, 'pending_release');

  // 同一人复核 → 拒绝
  assert.throws(() => core.reviewRelease(db, staff.wh, id, 'approve', 'ok'), /同一人|另一位/);

  // 第二位库房管理员复核，但健康度仍 70 < 80 且无“降级使用” → 拒绝放行
  assert.throws(() => core.reviewRelease(db, staff.wh2, id, 'approve', '看起来还行'), /降级使用/);

  // 带“降级使用”确认 → 通过，电池回在库，隔离故障关闭
  core.reviewRelease(db, staff.wh2, id, 'approve', '降级使用，限配角岗位');
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(id);
  assert.equal(b.state, 'available');
  assert.equal(b.review_status, 'released');
  assert.equal(core.listFaults(db, 'open').filter((f) => f.kind === 'health_quarantine').length, 0);
});

test('健康隔离复核：驳回保持隔离状态', () => {
  const { db, staff } = setup();
  core.scanHealth(db);
  const id = db.prepare("SELECT id FROM batteries WHERE code='BAT-03'").get().id;
  core.requestRelease(db, staff.wh, id, '申请');
  core.reviewRelease(db, staff.wh2, id, 'reject', '实测掉压严重');
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(id);
  assert.equal(b.state, 'quarantined');
  assert.equal(b.review_status, 'rejected');
});
