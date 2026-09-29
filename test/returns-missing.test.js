'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const core = require('../src/core');

function issuedKit(db, staff, showId = 1) {
  const cl = core.createChecklist(db, staff.sm, showId);
  core.addItem(db, staff.ae, cl.id, {
    role_name: '主演', microphone_id: 1, beltpack_id: 1, spare_battery_id: 1,
  });
  core.addItem(db, staff.ae, cl.id, {
    role_name: '助演', microphone_id: 2, beltpack_id: 2, spare_battery_id: 2,
  });
  core.lockChecklist(db, staff.sm, cl.id);
  core.issueChecklist(db, staff.sm, cl.id);
  return cl;
}

// 4. 漏件处理
test('漏件：清点时未归还的麦/腰包/电池逐件生成 missing_return 故障', () => {
  const { db, staff } = setup();
  const cl = issuedKit(db, staff);
  // 只还主演的麦克风和电池，腰包没还；助演整组未还
  core.scanReturn(db, staff.wh, cl.id, 'MIC-01');
  core.scanReturn(db, staff.wh, cl.id, 'BAT-01');

  const r = core.settleChecklist(db, staff.wh, cl.id);
  assert.equal(r.missing_count, 4); // BP-01 + MIC-02/BP-02/BAT-02
  assert.equal(core.getChecklist(db, cl.id).state, 'settled');
  const faults = core.listFaults(db, 'all').filter((f) => f.kind === 'missing_return');
  assert.equal(faults.length, 4);
});

test('漏件：完成清点后迟到的回传只记录不覆盖，缺件保持缺件', () => {
  const { db, staff } = setup();
  const cl = issuedKit(db, staff);
  // 一件不还直接清点
  const r = core.settleChecklist(db, staff.wh, cl.id);
  assert.equal(r.missing_count, 6);

  // 迟到回传：三件设备分别扫描
  for (const code of ['MIC-01', 'BP-01', 'BAT-01']) {
    const res = core.scanReturn(db, staff.wh, cl.id, code);
    assert.equal(res.late, true);
    assert.equal(res.ok, false);
  }
  const hyd = core.getChecklist(db, cl.id);
  assert.ok(hyd.items.every((i) => !i.returned_mic && !i.returned_bp && !i.returned_battery));
  const scans = db.prepare('SELECT accepted, COUNT(*) AS n FROM return_scans GROUP BY accepted').all();
  assert.deepEqual(scans.map((s) => [s.accepted, s.n]).sort(), [[0, 3]]);
  // 设备状态未被迟到扫描改写回在库
  assert.equal(db.prepare("SELECT state FROM microphones WHERE code='MIC-01'").get().state, 'checked_out');
});

test('漏件：全部归齐后清点无漏件；重复扫描幂等', () => {
  const { db, staff } = setup();
  const cl = issuedKit(db, staff);
  for (const code of ['MIC-01', 'BP-01', 'BAT-01', 'MIC-02', 'BP-02', 'BAT-02']) {
    core.scanReturn(db, staff.wh, cl.id, code);
  }
  const dup = core.scanReturn(db, staff.wh, cl.id, 'MIC-01');
  assert.equal(dup.duplicate, true);
  const r = core.settleChecklist(db, staff.wh, cl.id);
  assert.equal(r.missing_count, 0);
});

test('漏件：扫描不属于本套装的设备被拒（防错拿）', () => {
  const { db, staff } = setup();
  const cl = issuedKit(db, staff);
  assert.throws(() => core.scanReturn(db, staff.wh, cl.id, 'MIC-03'), /不属于本套装/);
});

test('漏件：确认丢失把设备置为 lost 并关闭故障；之后不能再排期', () => {
  const { db, staff } = setup();
  const cl = issuedKit(db, staff);
  core.settleChecklist(db, staff.wh, cl.id);
  const fault = core.listFaults(db, 'open').find((f) => f.kind === 'missing_return' && f.ref_type === 'microphone');
  core.markLost(db, staff.wh, fault.id);
  assert.equal(db.prepare("SELECT state FROM microphones WHERE id=?").get(fault.ref_id).state, 'lost');
  assert.equal(db.prepare('SELECT status FROM faults WHERE id=?').get(fault.id).status, 'resolved');

  // 丢失设备不能进入新套装
  const cl2 = core.createChecklist(db, staff.sm, 2);
  assert.throws(() => core.addItem(db, staff.ae, cl2.id, { role_name: 'x', microphone_id: fault.ref_id }), /不能重复排期/);
});

test('错频：超出协调窗口报错并可校正关闭，窗口内的协调频点不误报', () => {
  const { db, staff } = setup();
  const cl = core.createChecklist(db, staff.sm, 1);
  core.addItem(db, staff.ae, cl.id, { role_name: '甲', microphone_id: 3 }); // MIC-03 UHF-C 720
  core.lockChecklist(db, staff.sm, cl.id);
  core.issueChecklist(db, staff.sm, cl.id);

  // 拨到 731.8（偏离 11.8）→ 错频
  db.prepare('UPDATE microphones SET freq_mhz=731.8 WHERE id=3').run();
  let r = core.checkFrequencies(db, staff.ae, 1);
  assert.equal(r.mismatches.length, 1);
  // 校正后不再报
  core.fixFrequency(db, staff.ae, 3, 720);
  r = core.checkFrequencies(db, staff.ae, 1);
  assert.equal(r.mismatches.length, 0);
  assert.equal(core.listFaults(db, 'open').filter((f) => f.kind === 'wrong_freq').length, 0);

  // 窗口内（±4MHz）视为协调频点
  db.prepare('UPDATE microphones SET freq_mhz=722.5 WHERE id=3').run();
  r = core.checkFrequencies(db, staff.ae, 1);
  assert.equal(r.mismatches.length, 0);
});
