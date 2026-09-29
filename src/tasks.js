'use strict';
// 进程内任务：充电推进模拟、电量计算、低电量/健康度巡检与提醒
const core = require('./core');
const { ChargerAdapter } = require('./adapter');

class TaskRunner {
  constructor(db, { intervalMs = 4000, log = console.log } = {}) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.log = log;
    this.adapter = new ChargerAdapter(db);
    this.timer = null;
    this.tickCount = 0;
    this.alerts = []; // 进程内提醒缓冲（页面顶部铃铛 /api/alerts 读取）
    this._alertedFaults = new Set(); // 每个开放故障只提醒一次
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.log('任务异常:', e.message); }
    }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pushAlert(text, level = 'warn') {
    this.alerts.unshift({ at: new Date().toISOString(), text, level });
    if (this.alerts.length > 50) this.alerts.length = 50;
  }
  drainAlerts() {
    const a = this.alerts.slice();
    this.alerts = [];
    return a;
  }

  // 充电推进：为每个充电中会话推进一档电量并生成回执（演示电量计算）
  progressCharging() {
    const sessions = this.db.prepare(`
      SELECT ss.*, c.code AS cab, sl.position, b.code AS bcode, b.charge_pct
        FROM slot_sessions ss
        JOIN slots sl ON sl.id = ss.slot_id
        JOIN chargers c ON c.id = sl.charger_id
        JOIN batteries b ON b.id = ss.battery_id
       WHERE ss.ended_at IS NULL AND ss.status='charging'`).all();
    for (const s of sessions) {
      const slotCode = `${s.cab}:${s.position}`;
      const nextSeq = (this.db.prepare(
        'SELECT COALESCE(MAX(seq),0)+1 AS n FROM slot_receipts WHERE slot_code=?').get(slotCode).n);
      let event = 'progress';
      let pct = Math.min(95, s.charge_pct + 25);
      if (s.charge_pct >= 95) { event = 'full'; pct = 100; }
      // 偶发接触不良（演示：起始电量极低且第一次推进时 5% 概率）——默认关闭，避免随机
      this.adapter.ingest({ slot_code: slotCode, battery_code: s.bcode, seq: nextSeq, event, charge_pct: pct });
    }
    return core.applyReceipts(this.db);
  }

  tick() {
    this.tickCount++;
    const charge = this.progressCharging();
    const low = core.scanLowBattery(this.db);
    const quarantined = core.scanHealth(this.db);

    const openFaults = this.db.prepare(`SELECT * FROM faults WHERE status='open' ORDER BY id`).all();
    for (const f of openFaults) {
      if (!this._alertedFaults.has(f.id)) {
        this._alertedFaults.add(f.id);
        this.pushAlert(`[故障] ${FAULT_LABEL[f.kind] || f.kind}：${f.detail}`);
      }
    }
    if (charge.dropped.length) {
      for (const d of charge.dropped) this.pushAlert(`收到乱序旧回执已丢弃：${d.slot} seq=${d.seq}`);
    }
    if (low.faults_created) this.pushAlert(`新增 ${low.faults_created} 块低电量电池提醒`);
    if (quarantined) this.pushAlert(`巡检自动隔离 ${quarantined} 块低健康度电池`, 'danger');
    return { tick: this.tickCount, charge, low, quarantined };
  }
}

const FAULT_LABEL = {
  low_battery: '低电量',
  charge_failed: '充电失败',
  contact_bad: '接触不良',
  lost: '丢失',
  wrong_freq: '错频',
  missing_return: '归还漏件',
  health_quarantine: '健康度隔离',
};

module.exports = { TaskRunner, FAULT_LABEL };
