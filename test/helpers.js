'use strict';
// 测试公共夹具：内存库 + 精简演示数据
const { openDb } = require('../src/db');
const core = require('../src/core');

function setup() {
  const db = openDb(':memory:');
  const ins = (sql, ...v) => db.prepare(sql).run(...v);

  ins("INSERT INTO staff (id,name,role,title) VALUES (1,'周婉清','stage_manager','舞台监督')");
  ins("INSERT INTO staff (id,name,role,title) VALUES (2,'陈牧野','audio_engineer','音响师')");
  ins("INSERT INTO staff (id,name,role,title) VALUES (3,'何砚舟','warehouse','库房管理员')");
  ins("INSERT INTO staff (id,name,role,title) VALUES (4,'林知夏','warehouse','库房管理员')");
  const staff = {
    sm: db.prepare('SELECT * FROM staff WHERE id=1').get(),
    ae: db.prepare('SELECT * FROM staff WHERE id=2').get(),
    wh: db.prepare('SELECT * FROM staff WHERE id=3').get(),
    wh2: db.prepare('SELECT * FROM staff WHERE id=4').get(),
  };

  const mkShow = (id, name, h = 24) => ins(
    "INSERT INTO shows (id,name,venue,start_at,end_at,status) VALUES (?,?,?,?,?, 'scheduled')",
    id, name, '大剧场', new Date(Date.now() + h * 36e5).toISOString(), new Date(Date.now() + (h + 3) * 36e5).toISOString());
  mkShow(1, '测试演出甲', 24);
  mkShow(2, '测试演出乙', 48);

  const mkMic = (id, code, band = 'UHF-A', freq = 520.125) =>
    ins("INSERT INTO microphones (id,code,model,band,freq_mhz,kind) VALUES (?,?,?,?,?,'handheld')", id, code, 'M-Model', band, freq);
  const mkBp = (id, code, band = 'UHF-A') =>
    ins("INSERT INTO beltpacks (id,code,model,band) VALUES (?,?,?,?)", id, code, 'BP-Model', band);
  const mkBat = (id, code, charge = 100, health = 100, cycles = 5) =>
    ins("INSERT INTO batteries (id,code,model,cycles,charge_pct,health_pct,state,updated_at) VALUES (?,?,?,?,?,?,'available',?)",
      id, code, 'RB-PRO 98', cycles, charge, health, new Date().toISOString());

  mkMic(1, 'MIC-01'); mkMic(2, 'MIC-02'); mkMic(3, 'MIC-03', 'UHF-C', 720);
  mkBp(1, 'BP-01'); mkBp(2, 'BP-02');
  mkBat(1, 'BAT-01'); mkBat(2, 'BAT-02'); mkBat(3, 'BAT-03', 100, 70, 150); // BAT-03 低健康
  ins("INSERT INTO chargers (id,code,name) VALUES (1,'CAB-1','测试柜')");
  for (let p = 1; p <= 4; p++) ins('INSERT INTO slots (id,charger_id,position) VALUES (?,?,?)', p, 1, p);
  ins('INSERT INTO freq_plan (show_id,band,freq_mhz) VALUES (?,?,?)', 1, 'UHF-A', 520.125);
  ins('INSERT INTO freq_plan (show_id,band,freq_mhz) VALUES (?,?,?)', 1, 'UHF-C', 720);
  ins('INSERT INTO freq_plan (show_id,band,freq_mhz) VALUES (?,?,?)', 2, 'UHF-A', 520.125);
  ins('INSERT INTO freq_plan (show_id,band,freq_mhz) VALUES (?,?,?)', 2, 'UHF-C', 720);

  return { db, staff };
}

module.exports = { setup };
