'use strict';
// 进程内任务：充电推进、演出中放电、低电量提醒、场次开演前检查。
const { LOW_BATTERY } = require('./db');

function createScheduler(svc, adapter, opts = {}) {
  const intervalMs = opts.intervalMs ?? 4000;
  let timer = null;
  let tickCount = 0;
  const listeners = [];
  const onTick = (fn) => listeners.push(fn);

  function drainLiveShowBatteries() {
    // 正在演出场次：被锁定/在用套装里的电池按 tick 放电
    const rows = svc.db.prepare(`
      SELECT DISTINCT b.id, b.code, b.charge_pct, c.id checklist_id, s.id show_id, s.name show_name
      FROM batteries b
      JOIN holds h ON h.kind='battery' AND h.ref_id=b.id
      JOIN checklists c ON c.id=h.checklist_id
      JOIN shows s ON s.id=c.show_id AND s.status='live'
    `).all();
    const alerts = [];
    for (const b of rows) {
      const next = Math.max(1, b.charge_pct - (6 + (tickCount % 5)));
      svc.db.prepare('UPDATE batteries SET charge_pct=? WHERE id=?').run(next, b.id);
      if (next <= LOW_BATTERY) {
        svc.openFault('low_battery', {
          severity: 'warn', ref_kind: 'battery', ref_id: b.id, show_id: b.show_id,
          detail: `《${b.show_name}》使用中的电池 ${b.code} 电量 ${next}%，请更换备用电池`,
        });
        alerts.push({ battery: b.code, charge: next });
      }
    }
    return alerts;
  }

  function preflightReminders() {
    // 开演前 90 分钟内仍有草稿领用单（未锁定套装）-> 提醒
    const rows = svc.db.prepare(`
      SELECT s.id show_id, s.name, s.start_at, COUNT(c.id) drafts
      FROM shows s
      LEFT JOIN checklists c ON c.show_id=s.id AND c.status='draft'
      WHERE s.status='scheduled'
        AND julianday(s.start_at) - julianday(?) BETWEEN -0.01 AND 0.0625
      GROUP BY s.id
      HAVING drafts > 0
    `).all(svc.ts());
    for (const r of rows) {
      svc.openFault('preflight', {
        severity: 'info', ref_kind: 'show', ref_id: r.show_id, show_id: r.show_id,
        detail: `《${r.name}》临近开演，仍有 ${r.drafts} 张领用单未锁定`,
      });
    }
    return rows.length;
  }

  function tick() {
    tickCount += 1;
    const charging = adapter.tickAll();
    const low = drainLiveShowBatteries();
    const reminders = preflightReminders();
    const report = { tick: tickCount, at: svc.ts(), charging, low_battery: low, reminders };
    for (const fn of listeners) {
      try { fn(report); } catch { /* 监听器异常不影响调度 */ }
    }
    return report;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { tick, start, stop, onTick, get tickCount() { return tickCount; } };
}

module.exports = { createScheduler };
