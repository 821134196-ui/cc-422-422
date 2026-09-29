'use strict';
// 演示数据：演出名称、人员资料、设备库存、三场前后周转样例。
const { openDb, ROLES, HEALTH_THRESHOLD } = require('./db');
const { createServices } = require('./domain');

const SEED_TS = '2026-09-29T11:30:00.000Z';

function seed(db) {
  db.exec(`
    DELETE FROM audit_log; DELETE FROM faults; DELETE FROM return_scans; DELETE FROM receipt_events;
    DELETE FROM holds; DELETE FROM kit_items; DELETE FROM checklists;
    DELETE FROM slots; DELETE FROM cabinets;
    DELETE FROM batteries; DELETE FROM beltpacks; DELETE FROM microphones;
    DELETE FROM shows; DELETE FROM staff;
  `);

  const svc = createServices(db, () => SEED_TS);
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  // ---------- 人员（演示资料） ----------
  const staff = {};
  for (const [key, name, role] of [
    ['manager', '周砚秋', ROLES.MANAGER],
    ['stage', '韩听澜', ROLES.STAGE],
    ['audio', '沈既明', ROLES.AUDIO],
    ['tech', '陆知遥', ROLES.TECH],
  ]) {
    staff[key] = ins('INSERT INTO staff(name, role, pin) VALUES(?,?,?)', name, role, '0000');
  }

  // ---------- 演出场次 ----------
  const show = (name, venue, start, end, status, notes = '') =>
    ins('INSERT INTO shows(name, venue, start_at, end_at, status, notes) VALUES(?,?,?,?,?,?)',
      name, venue, start, end, status, notes);

  const sTonight = show('夜莺与玫瑰·原创音乐剧', '一号大剧场',
    '2026-09-29T19:30', '2026-09-29T21:45', 'scheduled', '今晚 19:30，三张角色领用单');
  const sLive = show('声临阿莱城·沉浸声音剧场', '二号黑匣子',
    '2026-09-29T14:00', '2026-09-29T17:00', 'live', '正在演出，电池实时放电');
  const sPast = show('仲夏夜合唱节闭幕场', '一号大剧场',
    '2026-09-28T19:30', '2026-09-28T21:30', 'closed', '已结清：1 件腰包丢失、1 条迟到回传');
  show('国庆交响合唱音乐会', '一号大剧场', '2026-10-01T19:00', '2026-10-01T21:30', 'scheduled', '');
  show('儿童剧·小狐狸的秋天', '三号亲子厅', '2026-10-03T10:30', '2026-10-03T11:40', 'scheduled', '');
  show('爵士午夜场·Blue Keys', '二号黑匣子', '2026-10-06T21:00', '2026-10-06T23:00', 'scheduled', '');

  // ---------- 麦克风 / 腰包 ----------
  const mic = (code, model, band, freq, status = 'ok', note = '') =>
    ins('INSERT INTO microphones(code, model, band, freq_mhz, status, note) VALUES(?,?,?,?,?,?)',
      code, model, band, freq, status, note);
  const pack = (code, model, status = 'ok', note = '') =>
    ins('INSERT INTO beltpacks(code, model, status, note) VALUES(?,?,?,?)', code, model, status, note);

  const mics = {
    MH01: mic('MH-01', 'Sennheiser EW-DP 手持', 'UHF-R1', 520.125),
    MH02: mic('MH-02', 'Sennheiser EW-DP 手持', 'UHF-R1', 526.875),
    MH03: mic('MH-03', 'Shure Axient 手持', 'UHF-R2', 614.200),
    MH04: mic('MH-04', 'Shure Axient 手持', 'UHF-R2', 620.550),
    MH05: mic('MH-05', 'Shure SM35 头戴', 'UHF-R1', 530.400),
    MH06: mic('MH-06', 'Shure SM35 头戴', 'UHF-R1', 536.900),
    MH07: mic('MH-07', 'DPA 4088 头戴', 'UHF-R2', 614.200, 'fault', '彩排时被调到与 MH-03 撞频'),
    MH08: mic('MH-08', 'Countryman B6 领夹', 'UHF-R2', 626.100),
    MH09: mic('MH-09', 'Sennheiser EW-DP 手持', 'UHF-R1', 542.300),
  };
  const packs = {
    BP01: pack('BP-01', 'Shure PSM300 腰包'),
    BP02: pack('BP-02', 'Shure PSM300 腰包'),
    BP03: pack('BP-03', 'Sennheiser EW-D 腰包'),
    BP04: pack('BP-04', 'Sennheiser EW-D 腰包'),
    BP05: pack('BP-05', 'Sennheiser EW-D 腰包', 'fault', '电池仓卡扣断裂待修'),
    BP06: pack('BP-06', 'Shure PSM300 腰包'),
  };

  // ---------- 电池 ----------
  const battery = (code, model, cycles, charge, health, status = 'active', extra = {}) =>
    ins(`INSERT INTO batteries(code, model, cycles, charge_pct, health_pct, status,
          isolated_reason, isolated_at, review_status, review_requested_by, review_requested_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      code, model, cycles, charge, health, status,
      extra.reason || '', extra.at || null,
      extra.review || 'none', extra.reqBy || null, extra.reqAt || null);

  const bats = {
    BT01: battery('BT-01', 'Sony NP-BX1 锂电', 128, 96, 94),
    BT02: battery('BT-02', 'Sony NP-BX1 锂电', 142, 88, 91),
    BT03: battery('BT-03', 'Panasonic BCR-30', 76, 92, 97),
    BT04: battery('BT-04', 'Panasonic BCR-30', 210, 58, 86),
    BT05: battery('BT-05', 'Sony NP-BX1 锂电', 98, 100, 95),
    BT06: battery('BT-06', 'Sony NP-BX1 锂电', 305, 100, 82),
    BT07: battery('BT-07', 'Eneloop 5号×2', 420, 70, 89),
    BT08: battery('BT-08', 'Eneloop 5号×2', 388, 45, 88),
    BT09: battery('BT-09', 'Panasonic BCR-30', 156, 33, 93),
    BT10: battery('BT-10', 'Sony NP-BX1 锂电', 64, 100, 99),
    // 健康度低于阈值 → 自动隔离；设备员已申请解除，待经理复核
    BT11: battery('BT-11', 'Eneloop 5号×2', 512, 100, HEALTH_THRESHOLD - 4, 'isolated', {
      reason: '充电回执健康度 76%，低于阈值 80%', at: '2026-09-28T21:50:00.000Z',
      review: 'pending', reqBy: staff.tech, reqAt: '2026-09-29T09:15:00.000Z' }),
    // 刚被自动隔离，尚未申请
    BT12: battery('BT-12', 'Panasonic BCR-30', 467, 100, HEALTH_THRESHOLD - 8, 'isolated', {
      reason: '充电回执健康度 72%，低于阈值 80%', at: '2026-09-29T10:40:00.000Z' }),
    BT13: battery('BT-13', 'Sony NP-BX1 锂电', 188, 14, 90),
    BT14: battery('BT-14', 'Eneloop 5号×2', 240, 62, 92),
    BT15: battery('BT-15', 'Panasonic BCR-30', 45, 100, 98),
    BT16: battery('BT-16', 'Sony NP-BX1 锂电', 330, 27, 79), // 健康度临界，下次充电将触发隔离
  };

  // ---------- 充电柜 ----------
  const cab1 = ins('INSERT INTO cabinets(name) VALUES(?)', 'A 柜 · 舞台下场门');
  const cab2 = ins('INSERT INTO cabinets(name) VALUES(?)', 'B 柜 · 设备间');
  const slot = (cab, pos) => ins('INSERT INTO slots(cabinet_id, position) VALUES(?,?)', cab, pos);
  const A = {}, B = {};
  for (let i = 1; i <= 8; i++) { A[i] = slot(cab1, `A${i}`); B[i] = slot(cab2, `B${i}`); }

  // 放入电池并通过回执建立槽位状态（seq 从 dock 之后递增）
  const dock = (slotId, batId) => svc.dockBattery(staff.tech, slotId, batId);
  const rx = (slotId, seq, result, charge = null, health = null) =>
    svc.receiveReceipt(slotId, { seq, battery_id: db.prepare('SELECT battery_id FROM slots WHERE id=?').get(slotId).battery_id,
      result, charge_pct: charge, health_pct: health });

  dock(A[1], bats.BT13); rx(A[1], 2, 'charging', 14, 90); rx(A[1], 3, 'charging', 18, 90);       // 低电量充电中
  dock(A[2], bats.BT08); rx(A[2], 2, 'charging', 45, 88); rx(A[2], 3, 'charging', 61, 88);
  dock(A[3], bats.BT04); rx(A[3], 2, 'contact_fault');                                            // 接触不良
  dock(A[4], bats.BT07); rx(A[4], 2, 'charging', 70, 89); rx(A[4], 3, 'ready', 100, 89);
  dock(A[5], bats.BT16); rx(A[5], 2, 'charging', 27, 79); rx(A[5], 3, 'charge_failed');          // 充电失败 + 健康临界
  // A6 空槽；A7/A8 待用
  dock(B[1], bats.BT09); rx(B[1], 2, 'charging', 33, 93); rx(B[1], 3, 'charging', 49, 93);
  dock(B[2], bats.BT14); rx(B[2], 2, 'charging', 62, 92); rx(B[2], 3, 'ready', 100, 92);
  // B3-B8 空槽

  // ---------- 领用单：今晚场（两张已锁定 + 一张草稿） ----------
  const mkKit = (showId, roleName) => svc.createChecklist(showId, roleName, staff.stage);
  const add = (cl, kind, id, spare = 0) => svc.addKitItem(cl, kind, id, spare);

  const cHost = mkKit(sTonight, '主持人·苏曼');
  add(cHost, 'mic', mics.MH01); add(cHost, 'battery', bats.BT01); add(cHost, 'battery', bats.BT02, 1);
  svc.lockChecklist(staff.stage, cHost);

  const cLead = mkKit(sTonight, '女主角·薇拉');
  add(cLead, 'mic', mics.MH05); add(cLead, 'pack', packs.BP01);
  add(cLead, 'battery', bats.BT03); add(cLead, 'battery', bats.BT05, 1);
  svc.lockChecklist(staff.stage, cLead);

  const cDraft = mkKit(sTonight, '男高音·阿尔芒'); // 草稿：未锁定，套装还缺备用电池
  add(cDraft, 'mic', mics.MH06); add(cDraft, 'pack', packs.BP03); add(cDraft, 'battery', bats.BT10);

  // ---------- 正在演出：放电中 ----------
  const cLive = svc.createChecklist(sLive, '讲述者·江岚', staff.stage);
  svc.addKitItem(cLive, 'mic', mics.MH02);
  svc.addKitItem(cLive, 'battery', bats.BT06);
  svc.addKitItem(cLive, 'battery', bats.BT15, 1);
  svc.lockChecklist(staff.stage, cLive);

  // ---------- 昨晚已结清场：漏件 + 迟到回传 ----------
  // 历史场次：套装锁定时电池尚健康（归还后充电才被隔离），直接以锁定态还原。
  const cPast = ins(
    `INSERT INTO checklists(show_id, role_name, assignee_id, status, locked_at)
     VALUES(?,?,?, 'locked', ?)`, sPast, '合唱指挥助理', staff.stage, '2026-09-28T19:00:00.000Z');
  const pastKit = (kind, refId) =>
    ins('INSERT INTO kit_items(checklist_id, kind, ref_id) VALUES(?,?,?)', cPast, kind, refId);
  pastKit('mic', mics.MH08);
  const pastPackItem = pastKit('pack', packs.BP04);
  pastKit('battery', bats.BT11);
  // 麦克风与电池已扫码归还，腰包未归还
  svc.scanReturn(staff.tech, cPast, 'mic', mics.MH08);
  svc.scanReturn(staff.tech, cPast, 'battery', bats.BT11);
  // 结算时舞台主管对腰包登记例外（按丢失处理）
  svc.settleChecklist(staff.stage, cPast, [{ kind: 'pack', ref_id: packs.BP04, reason: '演员误放入服装袋，随巡演车离馆' }]);
  // 清点完成后设备间才扫到腰包“回传”——迟到回传不得覆盖已完成清点
  db.prepare(`INSERT INTO return_scans(checklist_id, kind, ref_id, scanned_at, applied, note)
              VALUES(?,?,?,?,0,?)`)
    .run(cPast, 'pack', packs.BP04, '2026-09-28T22:40:00.000Z', '清点完成后的迟到回传，不覆盖已完成清点');
  svc.openFault('late_return', { severity: 'info', ref_kind: 'pack', ref_id: packs.BP04, show_id: sPast,
    detail: '《仲夏夜合唱节闭幕场》清点后收到腰包 BP-04 回传，已挂起，未改动清点结果' });
  // 该场 BT-11 就是在归还后充电时健康度跌破阈值而隔离（已在电池数据中体现）
  svc.openFault('health', { severity: 'block', ref_kind: 'battery', ref_id: bats.BT11,
    detail: '电池 BT-11 健康度 76% 低于阈值 80%，已自动隔离：闭幕场归还后充电测得' });
  db.prepare("UPDATE faults SET status='pending_review' WHERE type='health' AND ref_id=?").run(bats.BT11);

  // 错频故障（MH-07 与 MH-03 撞频）
  svc.flagWrongFreq(staff.audio, mics.MH07, 'MH-07 彩排时被调到 614.200MHz，与 MH-03 撞频，出现串音');

  return { staff, shows: { tonight: sTonight, live: sLive, past: sPast },
           mics, packs, batteries: bats, cabinets: { A, B }, checklists: { cHost, cLead, cDraft, cLive, cPast } };
}

if (require.main === module) {
  const db = openDb(process.env.DB_FILE || 'data/turnover.db');
  const refs = seed(db);
  console.log('seeded:', JSON.stringify(refs, null, 0));
}

module.exports = { seed };
