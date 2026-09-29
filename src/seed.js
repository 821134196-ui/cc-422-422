'use strict';
// 演示数据 + 演出前后周转样例（单命令：npm start 时自动播种）
const path = require('node:path');
const { openDb } = require('./db');
const core = require('./core');
const { ChargerAdapter } = require('./adapter');

function offsetH(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString();
}

function seed(db, { simulate = true } = {}) {
  db.exec(`
    DELETE FROM return_scans;
    DELETE FROM equipment_locks;
    DELETE FROM checklist_items;
    DELETE FROM checklists;
    DELETE FROM faults;
    DELETE FROM slot_receipts;
    DELETE FROM slot_sessions;
    DELETE FROM slots;
    DELETE FROM chargers;
    DELETE FROM freq_plan;
    DELETE FROM batteries;
    DELETE FROM beltpacks;
    DELETE FROM microphones;
    DELETE FROM shows;
    DELETE FROM staff;
  `);

  const insStaff = db.prepare('INSERT INTO staff (name, role, title) VALUES (?,?,?)');
  [
    ['周婉清', 'stage_manager', '舞台监督'],
    ['陈牧野', 'audio_engineer', '音响师'],
    ['何砚舟', 'warehouse', '库房管理员'],
    ['林知夏', 'warehouse', '库房管理员（复核人）'],
    ['顾长笙', 'performer', '主演'],
  ].forEach((s) => insStaff.run(...s));
  const staff = Object.fromEntries(core.listStaff(db).map((s) => [s.name, s]));

  const insShow = db.prepare('INSERT INTO shows (name, venue, start_at, end_at, status) VALUES (?,?,?,?,?)');
  [
    ['《夜莺与玫瑰》', '大剧场', offsetH(26), offsetH(29), 'scheduled'],
    ['周末脱口秀专场·第 12 期', '小剧场', offsetH(-2), offsetH(1), 'in_progress'],
    ['儿童剧《月亮船》', '中剧场', offsetH(-30), offsetH(-27), 'settled'],
    ['爵士之夜 Live', '音乐厅', offsetH(50), offsetH(53), 'scheduled'],
    ['新年合唱音乐会', '大剧场', offsetH(74), offsetH(77), 'scheduled'],
  ].forEach((s) => insShow.run(...s));
  const shows = core.listShows(db);
  const showByName = Object.fromEntries(shows.map((s) => [s.name, s]));

  const insMic = db.prepare('INSERT INTO microphones (code, model, band, freq_mhz, kind) VALUES (?,?,?,?,?)');
  [
    ['MIC-HH-01', 'Shure AD2', 'UHF-A', 520.125, 'handheld'],
    ['MIC-HH-02', 'Shure AD2', 'UHF-A', 524.875, 'handheld'],
    ['MIC-HS-01', 'Sennheiser HSP4', 'UHF-B', 610.5, 'headset'],
    ['MIC-HS-02', 'Sennheiser HSP4', 'UHF-B', 614.25, 'headset'],
    ['MIC-HH-03', 'Audio-Technica ATW', 'UHF-C', 720.0, 'handheld'],
    ['MIC-HS-03', 'DPA 4288', 'UHF-B', 618.75, 'headset'],
  ].forEach((m) => insMic.run(...m));

  const insBp = db.prepare('INSERT INTO beltpacks (code, model, band) VALUES (?,?,?)');
  [
    ['BP-101', 'Shure AD1', 'UHF-A'],
    ['BP-102', 'Shure AD1', 'UHF-A'],
    ['BP-201', 'Sennheiser SK 5212', 'UHF-B'],
    ['BP-202', 'Sennheiser SK 5212', 'UHF-B'],
    ['BP-301', 'Audio-Technica ATW-T32', 'UHF-C'],
  ].forEach((p) => insBp.run(...p));

  // 电池：型号 / 循环次数 / 当前电量 / 健康状态
  const insBat = db.prepare(`INSERT INTO batteries (code, model, cycles, charge_pct, health_pct, state, updated_at)
                             VALUES (?,?,?,?,?, 'available', ?)`);
  const ts = new Date().toISOString();
  [
    ['BAT-01', 'RB-PRO 98', 12, 8, 96],
    ['BAT-02', 'RB-PRO 98', 30, 100, 93],
    ['BAT-03', 'RB-PRO 98', 45, 100, 88],
    ['BAT-04', 'RB-LITE 90', 60, 64, 85],
    ['BAT-05', 'RB-LITE 90', 140, 40, 78],  // 健康度 78 < 80 → 自动隔离
    ['BAT-06', 'RB-PRO 98', 8, 10, 99],
    ['BAT-07', 'RB-LITE 90', 22, 100, 94],
    ['BAT-08', 'RB-PRO 98', 55, 100, 87],
    ['BAT-09', 'RB-LITE 90', 90, 100, 82],
    ['BAT-10', 'RB-PRO 98', 3, 100, 100],
    ['BAT-11', 'RB-LITE 90', 18, 12, 91],  // 在库低电量 → 低电量提醒
  ].forEach((b) => insBat.run(...b, ts));

  const insCab = db.prepare('INSERT INTO chargers (code, name) VALUES (?,?)');
  insCab.run('CAB-1', '一号充电柜（主控台旁）');
  insCab.run('CAB-2', '二号充电柜（库房）');
  const cabId = Object.fromEntries(db.prepare('SELECT id, code FROM chargers').all().map((c) => [c.code, c.id]));
  const insSlot = db.prepare('INSERT INTO slots (charger_id, position) VALUES (?,?)');
  for (let i = 1; i <= 8; i++) insSlot.run(cabId['CAB-1'], i);
  for (let i = 1; i <= 6; i++) insSlot.run(cabId['CAB-2'], i);

  const insPlan = db.prepare('INSERT INTO freq_plan (show_id, band, freq_mhz) VALUES (?,?,?)');
  for (const sh of shows) {
    insPlan.run(sh.id, 'UHF-A', 520.125);
    insPlan.run(sh.id, 'UHF-B', 610.5);
    insPlan.run(sh.id, 'UHF-C', 720.0);
  }

  const adapter = new ChargerAdapter(db);
  const bat = Object.fromEntries(core.listBatteries(db).map((b) => [b.code, b]));
  const mic = Object.fromEntries(core.listMicrophones(db).map((m) => [m.code, m]));
  const bp = Object.fromEntries(core.listBeltpacks(db).map((p) => [p.code, p]));

  // ============ 演出前：《夜莺与玫瑰》套装已锁定并发出 ============
  const upcoming = showByName['《夜莺与玫瑰》'];
  const cl1 = core.createChecklist(db, staff['周婉清'], upcoming.id);
  core.addItem(db, staff['陈牧野'], cl1.id, {
    role_name: '女主唱 玫瑰', assignee_name: '顾长笙',
    microphone_id: mic['MIC-HH-01'].id, beltpack_id: bp['BP-101'].id, spare_battery_id: bat['BAT-02'].id,
  });
  core.addItem(db, staff['陈牧野'], cl1.id, {
    role_name: '夜莺（头戴）', assignee_name: '苏临',
    microphone_id: mic['MIC-HS-01'].id, beltpack_id: bp['BP-201'].id, spare_battery_id: bat['BAT-03'].id,
  });
  core.addItem(db, staff['陈牧野'], cl1.id, {
    role_name: '主持 A', assignee_name: '江晚',
    microphone_id: mic['MIC-HH-02'].id, beltpack_id: bp['BP-102'].id, spare_battery_id: bat['BAT-08'].id,
  });
  core.lockChecklist(db, staff['周婉清'], cl1.id);
  core.issueChecklist(db, staff['周婉清'], cl1.id);

  // BAT-01 入 CAB-1:1，充电回执乱序到达（seq 倒序发送，应用层保序）
  core.dockBattery(db, staff['何砚舟'], 'BAT-01', 'CAB-1', 1);
  if (simulate) adapter.simulateCharge('CAB-1:1', 'BAT-01', { startCharge: 8, shuffle: true });

  // BAT-04 入 CAB-1:2，充电失败
  core.dockBattery(db, staff['何砚舟'], 'BAT-04', 'CAB-1', 2);
  if (simulate) adapter.simulateCharge('CAB-1:2', 'BAT-04', { fail: true });

  // BAT-09 入 CAB-2:1，接触不良
  core.dockBattery(db, staff['何砚舟'], 'BAT-09', 'CAB-2', 1);
  if (simulate) adapter.simulateCharge('CAB-2:1', 'BAT-09', { contactBadAt: 30 });

  // BAT-06 在 CAB-1:3 充电中（只发前两条进度，由进程任务继续推进）
  core.dockBattery(db, staff['何砚舟'], 'BAT-06', 'CAB-1', 3);
  if (simulate) {
    adapter.deliverBatch([
      { slot_code: 'CAB-1:3', battery_code: 'BAT-06', seq: 1, event: 'plugged', charge_pct: 10 },
      { slot_code: 'CAB-1:3', battery_code: 'BAT-06', seq: 2, event: 'progress', charge_pct: 25 },
    ]);
    core.applyReceipts(db);
  }

  // 健康度自动隔离（BAT-05）+ 在库低电量提醒（BAT-11）
  core.scanHealth(db);
  core.scanLowBattery(db);

  // ============ 演出中：脱口秀专场，已发出，归还检测中 + 错频 ============
  const live = showByName['周末脱口秀专场·第 12 期'];
  const cl2 = core.createChecklist(db, staff['周婉清'], live.id);
  db.prepare('UPDATE microphones SET freq_mhz=? WHERE code=?').run(731.8, 'MIC-HH-03'); // 拨错频点
  core.addItem(db, staff['陈牧野'], cl2.id, {
    role_name: '脱口秀演员 A', assignee_name: '马科',
    microphone_id: mic['MIC-HH-03'].id, beltpack_id: bp['BP-301'].id, spare_battery_id: bat['BAT-10'].id,
  });
  core.addItem(db, staff['陈牧野'], cl2.id, {
    role_name: '助演 B', assignee_name: '丁一',
    microphone_id: mic['MIC-HS-02'].id, beltpack_id: bp['BP-202'].id, spare_battery_id: bat['BAT-07'].id,
  });
  core.lockChecklist(db, staff['周婉清'], cl2.id);
  core.issueChecklist(db, staff['周婉清'], cl2.id);
  core.checkFrequencies(db, staff['陈牧野'], live.id); // → 错频故障
  core.scanReturn(db, staff['何砚舟'], cl2.id, 'MIC-HH-03'); // 演员 A 麦克风已还，其余未还

  // ============ 演出后：儿童剧已完成清点，含 1 件漏件 + 迟到回传拒收 ============
  const past = showByName['儿童剧《月亮船》'];
  const cl3 = core.createChecklist(db, staff['周婉清'], past.id);
  core.addItem(db, staff['陈牧野'], cl3.id, {
    role_name: '小水手（头戴）', assignee_name: '许白',
    microphone_id: mic['MIC-HS-03'].id, beltpack_id: null, spare_battery_id: bat['BAT-04'].id,
  });
  core.lockChecklist(db, staff['周婉清'], cl3.id);
  core.issueChecklist(db, staff['周婉清'], cl3.id);
  core.scanReturn(db, staff['何砚舟'], cl3.id, 'MIC-HS-03');   // 麦克风已还
  const settle = core.settleChecklist(db, staff['何砚舟'], cl3.id); // 备用电池未还 → 漏件故障
  const late = core.scanReturn(db, staff['何砚舟'], cl3.id, 'BAT-04'); // 结算后迟到回传 → 拒收不覆盖

  return { staff, shows, cl1: cl1.id, cl2: cl2.id, cl3: cl3.id, settle, late };
}

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
  const db = openDb(file);
  const r = seed(db);
  console.log('✅ 演示数据已播种 ->', file);
  console.log('   场次 5 / 麦克风 6 / 腰包 5 / 电池 11 / 充电柜 2（14 槽）');
  console.log('   演出前《夜莺与玫瑰》已锁定发出；脱口秀归还中（错频+部分归还）；儿童剧已清点（漏件 1，迟到回传拒收 =', r.late.late, ')');
  console.log('   故障队列：低电量 / 充电失败 / 接触不良 / 健康隔离 / 错频 / 漏件');
  db.close();
}

module.exports = { seed };
