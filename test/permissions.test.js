'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const core = require('../src/core');

// 5. 岗位权限：舞台监督 / 音响师 / 库房管理员 / 演员
test('权限矩阵：各岗位动作边界', () => {
  // 能
  assert.ok(core.can('stage_manager', 'checklist:lock'));
  assert.ok(core.can('stage_manager', 'checklist:issue'));
  assert.ok(core.can('audio_engineer', 'freq:fix'));
  assert.ok(core.can('warehouse', 'charger:operate'));
  assert.ok(core.can('warehouse', 'quarantine:review'));
  assert.ok(core.can('warehouse', 'checklist:settle'));
  // 不能
  assert.ok(!core.can('stage_manager', 'charger:operate'));
  assert.ok(!core.can('audio_engineer', 'charger:operate'));
  assert.ok(!core.can('audio_engineer', 'checklist:lock'));
  assert.ok(!core.can('warehouse', 'checklist:lock'));
  assert.ok(!core.can('warehouse', 'freq:fix'));
  assert.ok(!core.can('performer', 'checklist:write'));
  assert.ok(!core.can('performer', 'charger:operate'));
});

test('权限：舞台监督不能操作充电柜；音响师不能锁定/结算清单', () => {
  const { db, staff } = setup();
  assert.throws(() => core.dockBattery(db, staff.sm, 'BAT-01', 'CAB-1', 1), /无权/);
  const cl = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl.id, { role_name: '甲', spare_battery_id: 1 });
  assert.throws(() => core.lockChecklist(db, staff.ae, cl.id), /无权/);
});

test('权限：音响师可建套装/查错频/校正频点，但不能完成清点或处理故障', () => {
  const { db, staff } = setup();
  const cl = core.createChecklist(db, staff.sm, 1);
  assert.doesNotThrow(() => core.addItem(db, staff.ae, cl.id, { role_name: '甲', microphone_id: 1 }));
  assert.throws(() => core.settleChecklist(db, staff.ae, cl.id), /无权/);
  assert.throws(() => core.resolveFault(db, staff.ae, 1, 'x'), /无权/);
});

test('权限：只有库房管理员能入槽/弹出、复核隔离、完成清点', () => {
  const { db, staff } = setup();
  core.dockBattery(db, staff.wh, 'BAT-01', 'CAB-1', 1);
  assert.doesNotThrow(() => core.ejectBattery(db, staff.wh, 'CAB-1', 1));

  core.scanHealth(db);
  const id = db.prepare("SELECT id FROM batteries WHERE code='BAT-03'").get().id;
  // 音响师连申请解除都不行
  assert.throws(() => core.requestRelease(db, staff.ae, id, 'x'), /无权/);
  // 舞台监督不能复核
  core.requestRelease(db, staff.wh, id, '申请');
  assert.throws(() => core.reviewRelease(db, staff.sm, id, 'approve', '降级使用'), /无权/);
});

test('权限：演员几乎只读，不能创建清单/扫码归还', () => {
  const { db, staff } = setup();
  const performer = { id: 9, name: '顾长笙', role: 'performer' };
  assert.throws(() => core.createChecklist(db, performer, 1), /无权/);
  const cl = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl.id, { role_name: '甲', spare_battery_id: 1 });
  core.lockChecklist(db, staff.sm, cl.id);
  core.issueChecklist(db, staff.sm, cl.id);
  assert.throws(() => core.scanReturn(db, performer, cl.id, 'BAT-01'), /无权/);
});

test('权限：未登录（null 角色）任何写操作都被拒绝', () => {
  const { db, staff } = setup();
  const ghost = { id: null, name: '未登录', role: null };
  assert.throws(() => core.dockBattery(db, ghost, 'BAT-01', 'CAB-1', 1), /无权/);
  assert.throws(() => core.createChecklist(db, ghost, 1), /无权/);
});

test('流程：锁定后不可改套装；非 issued 不能清点；非 locked 不能发出', () => {
  const { db, staff } = setup();
  const cl = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl.id, { role_name: '甲', microphone_id: 1, beltpack_id: 1, spare_battery_id: 1 });
  // 草稿不能直接清点
  assert.throws(() => core.settleChecklist(db, staff.wh, cl.id), /演出进行中/);
  core.lockChecklist(db, staff.sm, cl.id);
  // 锁定后不能再加件/删件
  assert.throws(() => core.addItem(db, staff.ae, cl.id, { role_name: '乙', microphone_id: 2 }), /锁定/);
  // 锁定后不能重复锁
  assert.throws(() => core.lockChecklist(db, staff.sm, cl.id), /草稿/);
  core.issueChecklist(db, staff.sm, cl.id);
  // 发出后不能再发
  assert.throws(() => core.issueChecklist(db, staff.sm, cl.id), /已锁定/);
  // 已结算不能重复清点
  core.scanReturn(db, staff.wh, cl.id, 'MIC-01');
  core.scanReturn(db, staff.wh, cl.id, 'BP-01');
  core.scanReturn(db, staff.wh, cl.id, 'BAT-01');
  core.settleChecklist(db, staff.wh, cl.id);
  assert.throws(() => core.settleChecklist(db, staff.wh, cl.id), /演出进行中/);
});
