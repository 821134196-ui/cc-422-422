'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const core = require('../src/core');
const { ChargerAdapter } = require('../src/adapter');

// 2. 充电回执乱序：旧 seq 不得覆盖较新状态
test('回执乱序：seq 倒序到达仍按序号应用，旧包被丢弃不覆盖电量', () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  core.dockBattery(db, staff.wh, 'BAT-01', 'CAB-1', 1);

  // 正常序：plugged(1) → progress 25(2) → progress 75(4)
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 1, event: 'plugged', charge_pct: 5 });
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 2, event: 'progress', charge_pct: 25 });
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 4, event: 'progress', charge_pct: 75 });
  let r = core.applyReceipts(db);
  assert.equal(r.applied.length, 3);

  // 乱序旧包 seq=3（电量 50）迟到：必须丢弃，电量保持 75
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 3, event: 'progress', charge_pct: 50 });
  r = core.applyReceipts(db);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].seq, 3);
  assert.equal(db.prepare('SELECT charge_pct FROM batteries WHERE code=?').get('BAT-01').charge_pct, 75);

  // 回执流里 seq=3 标记为 applied=2
  assert.equal(db.prepare('SELECT applied FROM slot_receipts WHERE slot_code=? AND seq=3').get('CAB-1:1').applied, 2);
});

test('回执乱序：整批倒序投递，统一处理时按 seq 排序，最终结果与顺序一致', () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  core.dockBattery(db, staff.wh, 'BAT-02', 'CAB-1', 2);
  const receipts = adapter.planCharge('CAB-1:2', 'BAT-02', { startCharge: 10 });
  adapter.deliverBatch(receipts, { shuffle: true }); // 倒序发送
  const r = core.applyReceipts(db);                  // 入库后统一按 seq 排序处理
  const bat = db.prepare('SELECT * FROM batteries WHERE code=?').get('BAT-02');
  assert.equal(bat.charge_pct, 100);
  assert.equal(bat.state, 'available'); // full 后会话结束、电池回库
  assert.equal(bat.cycles, 6);           // 充满循环 +1
  assert.ok(r.applied.some((x) => x.event === 'full'));
  assert.equal(r.dropped.length, 0);
});

test('回执乱序（真实跨拍）：先应用高 seq，后到的低 seq 被丢弃', async () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  core.dockBattery(db, staff.wh, 'BAT-01', 'CAB-1', 1);
  // 第一拍只到 seq=4
  adapter.deliverBatch([
    { slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 1, event: 'plugged', charge_pct: 5 },
    { slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 4, event: 'progress', charge_pct: 95 },
  ]);
  core.applyReceipts(db);
  assert.equal(db.prepare('SELECT charge_pct FROM batteries WHERE code=?').get('BAT-01').charge_pct, 95);
  // 第二拍网络重排，seq=2/3 才到
  adapter.deliverBatch([
    { slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 2, event: 'progress', charge_pct: 25 },
    { slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 3, event: 'progress', charge_pct: 50 },
  ]);
  const r = core.applyReceipts(db);
  assert.equal(r.dropped.length, 2);
  assert.equal(db.prepare('SELECT charge_pct FROM batteries WHERE code=?').get('BAT-01').charge_pct, 95);
});

test('回执：充电失败与接触不良生成对应故障并结束会话，电池回库待处理', () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  core.dockBattery(db, staff.wh, 'BAT-01', 'CAB-1', 1);
  adapter.simulateCharge('CAB-1:1', 'BAT-01', { fail: true });
  let faults = core.listFaults(db, 'all').filter((f) => f.kind === 'charge_failed');
  assert.equal(faults.length, 1);
  assert.equal(db.prepare("SELECT state FROM batteries WHERE code='BAT-01'").get().state, 'available');

  core.dockBattery(db, staff.wh, 'BAT-02', 'CAB-1', 2);
  adapter.simulateCharge('CAB-1:2', 'BAT-02', { contactBadAt: 30 });
  faults = core.listFaults(db, 'all').filter((f) => f.kind === 'contact_bad');
  assert.equal(faults.length, 1);
});

test('迟到回传：会话弹出结束后再到的回执不会复活会话，仅留档/告警', () => {
  const { db, staff } = setup();
  const adapter = new ChargerAdapter(db);
  core.dockBattery(db, staff.wh, 'BAT-01', 'CAB-1', 1);
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 1, event: 'plugged', charge_pct: 5 });
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 2, event: 'progress', charge_pct: 30 });
  core.applyReceipts(db);
  core.ejectBattery(db, staff.wh, 'CAB-1', 1);
  assert.equal(db.prepare("SELECT state FROM batteries WHERE code='BAT-01'").get().state, 'available');

  // 迟到的 full：会话已不存在
  adapter.ingest({ slot_code: 'CAB-1:1', battery_code: 'BAT-01', seq: 3, event: 'full', charge_pct: 100 });
  core.applyReceipts(db);
  assert.equal(db.prepare("SELECT charge_pct FROM batteries WHERE code='BAT-01'").get().charge_pct, 30);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slot_sessions WHERE ended_at IS NULL').get().n, 0);
});
