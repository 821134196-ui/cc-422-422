'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const core = require('../src/core');

// 1. 套装唯一：同一设备不能同时出现在两个清单
test('套装唯一：同一电池/麦克风被两套未结清清单争用 → 第二套加件与锁定均失败', () => {
  const { db, staff } = setup();

  const cl1 = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl1.id, {
    role_name: '角色甲', microphone_id: 1, beltpack_id: 1, spare_battery_id: 1,
  });
  core.lockChecklist(db, staff.sm, cl1.id);

  const cl2 = core.createChecklist(db, staff.sm, 2);
  // 草稿加件时前置校验拦截
  assert.throws(() => core.addItem(db, staff.ae, cl2.id, {
    role_name: '角色乙', microphone_id: 1, beltpack_id: 2, spare_battery_id: 1,
  }), /占用|不能重复排期/);

  // 绕开前置，直接插第二套并锁定 → equipment_locks UNIQUE 最终防线
  db.prepare("INSERT INTO checklist_items (checklist_id,role_name,microphone_id,beltpack_id,spare_battery_id) VALUES (?,?,?,?,?)")
    .run(cl2.id, '角色乙', 2, 2, 1);
  assert.throws(() => core.lockChecklist(db, staff.sm, cl2.id), /唯一/);

  // 第一套照常可用，第二套仍处草稿
  assert.equal(db.prepare('SELECT state FROM checklists WHERE id=?').get(cl2.id).state, 'draft');
  assert.equal(core.getChecklist(db, cl1.id).state, 'locked');
});

test('套装唯一：清单结算释放锁后，设备可进入新套装（含状态校验）', () => {
  const { db, staff } = setup();
  const cl1 = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl1.id, { role_name: '甲', microphone_id: 1, beltpack_id: 1, spare_battery_id: 1 });
  core.lockChecklist(db, staff.sm, cl1.id);
  core.issueChecklist(db, staff.sm, cl1.id);
  core.scanReturn(db, staff.wh, cl1.id, 'MIC-01');
  core.scanReturn(db, staff.wh, cl1.id, 'BP-01');
  core.scanReturn(db, staff.wh, cl1.id, 'BAT-01');
  core.settleChecklist(db, staff.wh, cl1.id);

  const cl2 = core.createChecklist(db, staff.sm, 2);
  assert.doesNotThrow(() => core.addItem(db, staff.ae, cl2.id, {
    role_name: '乙', microphone_id: 1, beltpack_id: 1, spare_battery_id: 1,
  }));
});

test('套装唯一：隔离/充电中电池不能入套装，满电健康正常才可', () => {
  const { db, staff } = setup();
  const cl = core.createChecklist(db, staff.sm, 1);
  // BAT-03 健康度 70 < 80 → 自动隔离
  core.scanHealth(db);
  assert.equal(db.prepare("SELECT state FROM batteries WHERE id=3").get().state, 'quarantined');
  assert.throws(() => core.addItem(db, staff.ae, cl.id, { role_name: 'r', spare_battery_id: 3 }), /隔离/);
});
