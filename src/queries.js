'use strict';
// 只读查询模型：为前端聚合各页面所需数据。
function buildState(db) {
  const staff = db.prepare('SELECT id, name, role FROM staff WHERE archived=0 ORDER BY id').all();
  const shows = db.prepare('SELECT * FROM shows ORDER BY start_at').all();

  const checklistRows = db.prepare(`
    SELECT c.*, s.name show_name, s.venue, s.start_at, s.status show_status,
           st.name assignee_name,
           (SELECT COUNT(*) FROM kit_items k WHERE k.checklist_id=c.id) item_count,
           (SELECT COUNT(*) FROM kit_items k WHERE k.checklist_id=c.id AND k.returned=1) returned_count
    FROM checklists c JOIN shows s ON s.id=c.show_id
    LEFT JOIN staff st ON st.id=c.assignee_id
    ORDER BY s.start_at, c.id`).all();

  const items = db.prepare(`
    SELECT k.*,
      CASE k.kind WHEN 'mic' THEN (SELECT code FROM microphones WHERE id=k.ref_id)
                  WHEN 'pack' THEN (SELECT code FROM beltpacks WHERE id=k.ref_id)
                  WHEN 'battery' THEN (SELECT code FROM batteries WHERE id=k.ref_id) END AS dev_code,
      CASE k.kind WHEN 'mic' THEN (SELECT status FROM microphones WHERE id=k.ref_id)
                  WHEN 'pack' THEN (SELECT status FROM beltpacks WHERE id=k.ref_id)
                  WHEN 'battery' THEN (SELECT status FROM batteries WHERE id=k.ref_id) END AS dev_status,
      (SELECT charge_pct FROM batteries WHERE id=k.ref_id AND k.kind='battery') AS charge_pct,
      (SELECT health_pct FROM batteries WHERE id=k.ref_id AND k.kind='battery') AS health_pct,
      (SELECT freq_mhz FROM microphones WHERE id=k.ref_id AND k.kind='mic') AS freq_mhz,
      EXISTS(SELECT 1 FROM holds h WHERE h.kind=k.kind AND h.ref_id=k.ref_id) AS on_hold
    FROM kit_items k ORDER BY k.id`).all();

  const byChecklist = new Map();
  for (const it of items) {
    if (!byChecklist.has(it.checklist_id)) byChecklist.set(it.checklist_id, []);
    byChecklist.get(it.checklist_id).push(it);
  }
  const checklists = checklistRows.map(c => ({ ...c, items: byChecklist.get(c.id) || [] }));

  const microphones = db.prepare('SELECT * FROM microphones ORDER BY code').all();
  const beltpacks = db.prepare('SELECT * FROM beltpacks ORDER BY code').all();
  const batteries = db.prepare('SELECT * FROM batteries ORDER BY code').all();

  const cabinets = db.prepare('SELECT * FROM cabinets ORDER BY id').all();
  const slots = db.prepare(`
    SELECT s.*, b.code battery_code, b.charge_pct, b.health_pct, b.cycles, b.status battery_status
    FROM slots s LEFT JOIN batteries b ON b.id=s.battery_id
    ORDER BY s.cabinet_id, s.position`).all();

  const faults = db.prepare(`
    SELECT f.*, st.name resolved_by_name
    FROM faults f LEFT JOIN staff st ON st.id=f.resolved_by
    WHERE f.status IN ('open','pending_review') ORDER BY
      CASE f.severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, f.id`).all();
  const recentFaults = db.prepare('SELECT COUNT(*) n FROM faults').get().n;

  const lateScans = db.prepare(`
    SELECT r.*, c.role_name, s.name show_name
    FROM return_scans r JOIN checklists c ON c.id=r.checklist_id
    JOIN shows s ON s.id=c.show_id
    WHERE r.applied=0 ORDER BY r.id DESC LIMIT 20`).all();

  const strayReceipts = db.prepare(`
    SELECT e.*, s.position, c.name cabinet_name
    FROM receipt_events e JOIN slots s ON s.id=e.slot_id JOIN cabinets c ON c.id=s.cabinet_id
    WHERE e.applied=0 ORDER BY e.id DESC LIMIT 20`).all();

  const audit = db.prepare(`
    SELECT a.*, st.name actor_name FROM audit_log a LEFT JOIN staff st ON st.id=a.actor_id
    ORDER BY a.id DESC LIMIT 30`).all();

  // 设备占用映射（给"添加设备"选择器显示是否在库）
  const holds = db.prepare('SELECT kind, ref_id, checklist_id FROM holds').all();

  return {
    at: new Date().toISOString(),
    constants: { HEALTH_THRESHOLD: 80, LOW_BATTERY: 20 },
    staff, shows, checklists, microphones, beltpacks, batteries,
    cabinets, slots, faults, lateScans, strayReceipts, audit, holds,
    fault_total: recentFaults,
  };
}

module.exports = { buildState };
