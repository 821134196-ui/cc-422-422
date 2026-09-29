'use strict';
// 业务核心：纯数据操作 + 规则，不含 HTTP / 定时器
const { HEALTH_QUARANTINE_THRESHOLD, LOW_CHARGE_THRESHOLD } = require('./db');

const now = () => new Date().toISOString();
// 错频判定：同频段协调窗口（MHz），窗口内视为已协调，超出才算错频
const FREQ_TOLERANCE_MHZ = 4;

// ---------------------------------------------------------------------------
// 岗位权限矩阵
// warehouse 库房管理员 / audio_engineer 音响师 / stage_manager 舞台监督 / performer 演员
const PERMISSIONS = {
  warehouse: [
    'equipment:read', 'charger:operate', 'fault:resolve',
    'quarantine:request', 'quarantine:review', 'checklist:settle',
    'return:scan', 'checklist:read', 'show:read',
  ],
  audio_engineer: [
    'equipment:read', 'checklist:read', 'checklist:write',
    'freq:check', 'freq:fix', 'show:read', 'return:scan',
  ],
  stage_manager: [
    'equipment:read', 'show:read', 'show:create',
    'checklist:read', 'checklist:write', 'checklist:lock', 'checklist:issue',
    'return:scan',
  ],
  performer: ['equipment:read:self', 'checklist:read:self'],
};

function can(role, action) {
  return (PERMISSIONS[role] || []).includes(action);
}
function assertCan(role, action) {
  if (!can(role, action)) {
    const err = new Error(`岗位 ${role} 无权执行 ${action}`);
    err.code = 'FORBIDDEN';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 人员 / 场次
function listStaff(db) {
  return db.prepare('SELECT * FROM staff ORDER BY id').all();
}

function listShows(db) {
  return db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM checklists c WHERE c.show_id = s.id) AS has_checklist,
           (SELECT state FROM checklists c WHERE c.show_id = s.id)   AS checklist_state
      FROM shows s ORDER BY s.start_at`).all();
}

// ---------------------------------------------------------------------------
// 设备查询
function listBatteries(db) {
  return db.prepare('SELECT * FROM batteries ORDER BY code').all();
}
function listMicrophones(db) {
  return db.prepare('SELECT * FROM microphones ORDER BY code').all();
}
function listBeltpacks(db) {
  return db.prepare('SELECT * FROM beltpacks ORDER BY code').all();
}

function chargerGrid(db) {
  const chargers = db.prepare('SELECT * FROM chargers ORDER BY code').all();
  const slotStmt = db.prepare(`
    SELECT sl.id, sl.position, sl.charger_id,
           ss.id AS session_id, ss.status AS session_status, ss.started_at, ss.ended_at,
           b.id AS battery_id, b.code AS battery_code, b.charge_pct, b.health_pct, b.state AS battery_state,
           (SELECT MAX(seq) FROM slot_receipts r WHERE r.slot_code = (SELECT code FROM chargers WHERE id = sl.charger_id) || ':' || sl.position AND r.applied = 1) AS last_applied_seq
      FROM slots sl
      LEFT JOIN slot_sessions ss ON ss.id =
           (SELECT x.id FROM slot_sessions x WHERE x.slot_id = sl.id ORDER BY x.id DESC LIMIT 1)
      LEFT JOIN batteries b     ON b.id = ss.battery_id
     WHERE sl.charger_id = ? ORDER BY sl.position`);
  return chargers.map((c) => ({ ...c, slots: slotStmt.all(c.id) }));
}

// ---------------------------------------------------------------------------
// 充电槽操作（库房管理员）
function dockBattery(db, staff, batteryCode, chargerCode, position) {
  assertCan(staff.role, 'charger:operate');
  const battery = db.prepare('SELECT * FROM batteries WHERE code = ?').get(batteryCode);
  if (!battery) throw bizError(`电池 ${batteryCode} 不存在`);
  if (battery.state === 'quarantined') throw bizError('电池已隔离，禁止入槽');
  if (battery.state === 'charging') throw bizError('电池已在充电槽中');
  if (battery.state === 'assigned') throw bizError('电池在演出套装中，需先退回才能充电');

  const slot = db.prepare(`SELECT sl.* FROM slots sl JOIN chargers c ON c.id = sl.charger_id
                            WHERE c.code = ? AND sl.position = ?`).get(chargerCode, position);
  if (!slot) throw bizError('槽位不存在');
  const busy = db.prepare("SELECT id FROM slot_sessions WHERE slot_id = ? AND ended_at IS NULL").get(slot.id);
  if (busy) throw bizError('槽位被占用');

  const tx = db.exec.bind(db);
  db.exec('SAVEPOINT dock');
  try {
    db.prepare(`INSERT INTO slot_sessions (slot_id, battery_id, started_at, start_charge, status)
                VALUES (?,?,?,?,'charging')`).run(slot.id, battery.id, now(), battery.charge_pct);
    db.prepare("UPDATE batteries SET state='charging', updated_at=? WHERE id=?").run(now(), battery.id);
    db.exec('RELEASE SAVEPOINT dock');
  } catch (e) { db.exec('ROLLBACK TO SAVEPOINT dock'); throw e; }
  return { ok: true, battery: batteryCode, slot: `${chargerCode}:${position}` };
}

function ejectBattery(db, staff, chargerCode, position) {
  assertCan(staff.role, 'charger:operate');
  const row = db.prepare(`
    SELECT ss.*, b.code AS bcode FROM slot_sessions ss
      JOIN slots sl ON sl.id = ss.slot_id
      JOIN chargers c ON c.id = sl.charger_id
      JOIN batteries b ON b.id = ss.battery_id
     WHERE c.code = ? AND sl.position = ? AND ss.ended_at IS NULL`).get(chargerCode, position);
  if (!row) throw bizError('槽位无充电会话');
  closeSession(db, row, 'ejected', staff);
  return { ok: true };
}

function closeSession(db, session, endStatus, staff) {
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(session.battery_id);
  const nextBattery = endStatus === 'ejected'
    ? (b.state === 'quarantined' ? 'quarantined' : 'available')
    : ({ done: 'available', failed: 'available', contact_bad: 'available' })[endStatus] || 'available';
  db.prepare('UPDATE slot_sessions SET ended_at=?, end_charge=?, status=? WHERE id=?')
    .run(now(), b.charge_pct, endStatus, session.id);
  db.prepare('UPDATE batteries SET state=?, updated_at=? WHERE id=?')
    .run(nextBattery, now(), b.id);
}

// ---------------------------------------------------------------------------
// 充电回执：乱序/迟到处理
// 规则：每个槽位 seq 单调；seq <= 已应用最大序号 → 丢弃(applied=2)，绝不覆盖较新状态。
function receiveReceipt(db, receipt) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO slot_receipts
      (slot_code, battery_code, seq, event, charge_pct, payload_raw, received_at, applied)
      VALUES (?,?,?,?,?,?,?,0)`);
  const info = stmt.run(
    receipt.slot_code, receipt.battery_code, receipt.seq, receipt.event,
    receipt.charge_pct ?? null, JSON.stringify(receipt), now());
  return { inserted: info.changes > 0 };
}

function applyReceipts(db) {
  const pending = db.prepare(`SELECT * FROM slot_receipts WHERE applied = 0
                               ORDER BY slot_code, seq`).all();
  const applied = [];
  const dropped = [];
  for (const r of pending) {
    const last = db.prepare('SELECT MAX(seq) AS m FROM slot_receipts WHERE slot_code=? AND applied=1').get(r.slot_code).m;
    if (last != null && r.seq <= last) {
      db.prepare('UPDATE slot_receipts SET applied=2 WHERE id=?').run(r.id); // 乱序旧包
      dropped.push(r);
      continue;
    }
    applyOneReceipt(db, r);
    db.prepare('UPDATE slot_receipts SET applied=1 WHERE id=?').run(r.id);
    applied.push(r);
  }
  return { applied: applied.map(summary), dropped: dropped.map(summary) };
}
const summary = (r) => ({ slot: r.slot_code, seq: r.seq, event: r.event, charge_pct: r.charge_pct });

function activeSessionForSlot(db, slotCode) {
  return db.prepare(`
    SELECT ss.*, sl.id AS slot_id FROM slot_sessions ss
      JOIN slots sl ON sl.id = ss.slot_id
      JOIN chargers c ON c.id = sl.charger_id
     WHERE c.code || ':' || sl.position = ? AND ss.ended_at IS NULL`).get(slotCode);
}

function applyOneReceipt(db, r) {
  const session = activeSessionForSlot(db, r.slot_code);
  if (!session) {
    // 迟到回传：会话已结束（弹出/完成），回执仅留档，不复活会话
    raiseFault(db, {
      kind: 'contact_bad', refType: 'battery',
      refId: lookupBattery(db, r.battery_code)?.id || 0,
      detail: `槽位 ${r.slot_code} 会话已结束后收到回执 seq=${r.seq}（${r.event}），已忽略`,
    });
    return;
  }
  const battery = db.prepare('SELECT * FROM batteries WHERE id=?').get(session.battery_id);
  switch (r.event) {
    case 'plugged':
      break;
    case 'progress':
      if (Number.isInteger(r.charge_pct)) {
        db.prepare("UPDATE batteries SET charge_pct=?, state='charging', updated_at=? WHERE id=?")
          .run(clamp(r.charge_pct), now(), battery.id);
      }
      break;
    case 'full': {
      const cycles = battery.cycles + 1;
      const health = estimateHealth(battery.model, cycles);
      db.prepare('UPDATE batteries SET charge_pct=100, cycles=?, health_pct=?, updated_at=? WHERE id=?')
        .run(cycles, health, now(), battery.id);
      closeSession(db, session, 'done', null);
      if (health < HEALTH_QUARANTINE_THRESHOLD) {
        autoQuarantine(db, battery.id,
          `充满后健康度 ${health}% 低于阈值 ${HEALTH_QUARANTINE_THRESHOLD}%（循环 ${cycles} 次），自动隔离`);
      }
      break;
    }
    case 'failed':
      closeSession(db, session, 'failed', null);
      raiseFault(db, {
        kind: 'charge_failed', refType: 'battery', refId: battery.id,
        detail: `槽位 ${r.slot_code} 上报充电失败（seq=${r.seq}）`,
      });
      break;
    case 'contact_bad':
      closeSession(db, session, 'contact_bad', null);
      raiseFault(db, {
        kind: 'contact_bad', refType: 'battery', refId: battery.id,
        detail: `槽位 ${r.slot_code} 接触不良（seq=${r.seq}）`,
      });
      break;
  }
}

// 健康度模型：按循环次数衰减（演示）
function estimateHealth(model, cycles) {
  const rate = model.includes('PRO') ? 0.25 : 0.5; // PRO 型号衰减慢
  return Math.max(55, Math.round(100 - cycles * rate));
}
const clamp = (n) => Math.max(0, Math.min(100, n));
function lookupBattery(db, code) {
  return db.prepare('SELECT * FROM batteries WHERE code=?').get(code);
}

// ---------------------------------------------------------------------------
// 健康度隔离：自动隔离 + 人工解除复核（两步，需第二人）
function autoQuarantine(db, batteryId, detail) {
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
  if (!b || b.state === 'quarantined') return;
  db.prepare(`UPDATE batteries SET state='quarantined', review_status='auto', updated_at=? WHERE id=?`)
    .run(now(), batteryId);
  raiseFault(db, {
    kind: 'health_quarantine', refType: 'battery', refId: batteryId,
    detail,
  });
}

function scanHealth(db) {
  // 进程任务调用：巡检发现低健康度在库电池也自动隔离
  const bad = db.prepare(`SELECT * FROM batteries
      WHERE health_pct < ? AND state NOT IN ('quarantined','retired','lost','assigned')
        AND review_status != 'released'`).all(HEALTH_QUARANTINE_THRESHOLD);
  for (const b of bad) {
    const sess = db.prepare('SELECT id FROM slot_sessions WHERE battery_id=? AND ended_at IS NULL').get(b.id);
    if (sess) db.prepare("UPDATE slot_sessions SET ended_at=?, status='failed' WHERE id=?").run(now(), sess.id);
    autoQuarantine(db, b.id, `巡检：健康度 ${b.health_pct}% 低于阈值，自动隔离`);
  }
  return bad.length;
}

function requestRelease(db, staff, batteryId, note) {
  assertCan(staff.role, 'quarantine:request');
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
  if (!b) throw bizError('电池不存在');
  if (b.state !== 'quarantined') throw bizError('电池不在隔离状态');
  if (b.review_status === 'pending_release') throw bizError('已提交解除申请，等待复核');
  db.prepare(`UPDATE batteries SET review_status='pending_release', review_by=?, review_note=?, updated_at=? WHERE id=?`)
    .run(staff.id, note || '', now(), batteryId);
  return { ok: true, step: 'pending_release' };
}

function reviewRelease(db, staff, batteryId, decision, note) {
  assertCan(staff.role, 'quarantine:review');
  const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
  if (!b) throw bizError('电池不存在');
  if (b.review_status !== 'pending_release') throw bizError('无待复核的解除申请');
  if (b.review_by === staff.id) {
    throw forbiddenError('复核人不能与申请人为同一人，请由另一位库房管理员复核');
  }
  if (decision === 'approve') {
    if (b.health_pct < HEALTH_QUARANTINE_THRESHOLD && !(note && note.includes('降级使用'))) {
      throw bizError('健康度仍低于阈值：复核备注须包含“降级使用”确认才能放行');
    }
    db.prepare(`UPDATE batteries SET state='available', review_status='released', review_note=?, updated_at=? WHERE id=?`)
      .run(`[复核通过 ${staff.name}] ${note || ''}`.trim(), now(), batteryId);
    resolveFaultsFor(db, 'battery', batteryId, staff, `人工解除隔离：${note || '复核通过'}`);
  } else {
    db.prepare(`UPDATE batteries SET review_status='rejected', review_note=?, updated_at=? WHERE id=?`)
      .run(`[复核驳回 ${staff.name}] ${note || ''}`.trim(), now(), batteryId);
  }
  return { ok: true, decision };
}

// ---------------------------------------------------------------------------
// 领用清单 / 设备套装
function getChecklistByShow(db, showId) {
  const cl = db.prepare('SELECT * FROM checklists WHERE show_id=?').get(showId);
  if (!cl) return null;
  return hydrateChecklist(db, cl);
}
function getChecklist(db, id) {
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(id);
  return cl ? hydrateChecklist(db, cl) : null;
}
function listChecklists(db) {
  return db.prepare(`
    SELECT c.*, s.name AS show_name, s.venue, s.start_at
      FROM checklists c JOIN shows s ON s.id = c.show_id ORDER BY s.start_at`).all();
}
function hydrateChecklist(db, cl) {
  cl.items = db.prepare(`
    SELECT ci.*,
           m.code AS mic_code, m.model AS mic_model, m.kind AS mic_kind, m.band AS mic_band,
           m.freq_mhz AS mic_freq, m.state AS mic_state,
           p.code AS bp_code, p.model AS bp_model, p.state AS bp_state,
           b.code AS bat_code, b.model AS bat_model, b.charge_pct, b.health_pct, b.state AS bat_state
      FROM checklist_items ci
      LEFT JOIN microphones m ON m.id = ci.microphone_id
      LEFT JOIN beltpacks   p ON p.id = ci.beltpack_id
      LEFT JOIN batteries   b ON b.id = ci.spare_battery_id
     WHERE ci.checklist_id = ? ORDER BY ci.id`).all(cl.id);
  cl.show = db.prepare('SELECT * FROM shows WHERE id=?').get(cl.show_id);
  cl.complete = cl.items.length
    ? cl.items.every((i) => i.returned_mic && i.returned_bp && i.returned_battery)
    : false;
  return cl;
}

function createChecklist(db, staff, showId) {
  assertCan(staff.role, 'checklist:write');
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) throw bizError('场次不存在');
  const exists = db.prepare('SELECT id FROM checklists WHERE show_id=?').get(showId);
  if (exists) throw bizError('该场次已存在领用清单');
  const info = db.prepare('INSERT INTO checklists (show_id, created_by) VALUES (?,?)').run(showId, staff.id);
  return getChecklist(db, Number(info.lastInsertRowid));
}

function addItem(db, staff, checklistId, line) {
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
  if (!cl) throw bizError('清单不存在');
  assertCan(staff.role, 'checklist:write');
  if (cl.state !== 'draft') throw bizError('清单已锁定，不能改套装');
  // 设备可用性：同一电池不能同时出现在两个清单 —— equipment_locks 是最终防线
  const deviceChecks = [
    ['microphone', line.microphone_id, '麦克风'],
    ['beltpack', line.beltpack_id, '腰包'],
    ['battery', line.spare_battery_id, '备用电池'],
  ];
  for (const [type, id, label] of deviceChecks) {
    if (id == null) continue;
    if (type === 'battery') {
      const bat = db.prepare('SELECT * FROM batteries WHERE id=?').get(id);
      if (!bat) throw bizError(`${label}不存在`);
      if (bat.state !== 'available') {
        throw bizError(`${label} ${bat.code} 当前为「${stateText.battery[bat.state] || bat.state}」，只有在库电池能进入新套装`);
      }
    }
    if (type === 'microphone' || type === 'beltpack') {
      const row = db.prepare(`SELECT * FROM ${type === 'microphone' ? 'microphones' : 'beltpacks'} WHERE id=?`).get(id);
      if (row && row.state !== 'in_stock') {
        throw bizError(`${label} ${row.code} 当前为「${stateText.device[row.state] || row.state}」，不能重复排期`);
      }
    }
    const locked = db.prepare('SELECT 1 FROM equipment_locks WHERE device_type=? AND device_id=?').get(type, id);
    if (locked) throw bizError(`${label}已被其他演出套装占用（套装唯一约束）`);
  }
  const info = db.prepare(`INSERT INTO checklist_items
      (checklist_id, role_name, assignee_name, microphone_id, beltpack_id, spare_battery_id)
      VALUES (?,?,?,?,?,?)`)
    .run(checklistId, line.role_name, line.assignee_name || null,
      line.microphone_id ?? null, line.beltpack_id ?? null, line.spare_battery_id ?? null);
  return { ok: true, item_id: Number(info.lastInsertRowid) };
}

function removeItem(db, staff, itemId) {
  assertCan(staff.role, 'checklist:write');
  const item = db.prepare('SELECT * FROM checklist_items WHERE id=?').get(itemId);
  if (!item) throw bizError('清单项不存在');
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(item.checklist_id);
  if (cl.state !== 'draft') throw bizError('清单已锁定');
  db.prepare('DELETE FROM checklist_items WHERE id=?').run(itemId);
  return { ok: true };
}

// 领用后锁定套装：写 equipment_locks，设备状态 → checked_out / assigned
function lockChecklist(db, staff, checklistId) {
  assertCan(staff.role, 'checklist:lock');
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
  if (!cl) throw bizError('清单不存在');
  if (cl.state !== 'draft') throw bizError('只有草稿可以锁定');
  const items = db.prepare('SELECT * FROM checklist_items WHERE checklist_id=?').all(checklistId);
  if (items.length === 0) throw bizError('套装为空，不能领用');

  db.exec('SAVEPOINT lock');
  try {
    for (const it of items) {
      const rows = [
        ['microphone', it.microphone_id],
        ['beltpack', it.beltpack_id],
        ['battery', it.spare_battery_id],
      ];
      for (const [type, id] of rows) {
        if (id == null) continue;
        try {
          db.prepare('INSERT INTO equipment_locks (checklist_id, device_type, device_id) VALUES (?,?,?)')
            .run(checklistId, type, id);
        } catch (e) {
          throw bizError('套装中的设备已被其他清单占用，锁定中止（套装唯一）');
        }
      }
      if (it.microphone_id) db.prepare("UPDATE microphones SET state='checked_out' WHERE id=?").run(it.microphone_id);
      if (it.beltpack_id) db.prepare("UPDATE beltpacks SET state='checked_out' WHERE id=?").run(it.beltpack_id);
      if (it.spare_battery_id) db.prepare("UPDATE batteries SET state='assigned', updated_at=? WHERE id=?").run(now(), it.spare_battery_id);
    }
    db.prepare("UPDATE checklists SET state='locked', locked_at=? WHERE id=?").run(now(), checklistId);
    db.exec('RELEASE SAVEPOINT lock');
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT lock');
    throw e;
  }
  return getChecklist(db, checklistId);
}

function issueChecklist(db, staff, checklistId) {
  assertCan(staff.role, 'checklist:issue');
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
  if (!cl) throw bizError('清单不存在');
  if (cl.state !== 'locked') throw bizError('只有已锁定套装可以发出');
  db.prepare("UPDATE checklists SET state='issued', issued_at=? WHERE id=?").run(now(), checklistId);
  db.prepare("UPDATE shows SET status='in_progress' WHERE id=?").run(cl.show_id);
  return getChecklist(db, checklistId);
}

// ---------------------------------------------------------------------------
// 归还检测：扫描 + 清点
function scanReturn(db, staff, checklistId, deviceCode) {
  assertCan(staff.role, 'return:scan');
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
  if (!cl) throw bizError('清单不存在');
  if (cl.state === 'draft' || cl.state === 'locked') throw bizError('套装尚未发出，无需归还');

  const found = findDeviceInChecklist(db, cl.id, deviceCode);
  if (!found) throw bizError(`设备 ${deviceCode} 不属于本套装，请核对错频/错拿`);

  const already = db.prepare('SELECT 1 FROM return_scans WHERE checklist_id=? AND device_code=? AND accepted=1')
    .get(checklistId, deviceCode);
  if (already) return { ok: true, duplicate: true, found };

  // 关键规则：已完成清点后迟到的回传，只记录不覆盖
  if (cl.state === 'settled') {
    db.prepare(`INSERT INTO return_scans (checklist_id, device_type, device_code, scanned_at, accepted)
                VALUES (?,?,?,?,0)`).run(checklistId, found.type, deviceCode, now());
    return { ok: false, late: true, message: '清点已完成，迟到回传已记录但不覆盖清单' };
  }

  const col = { microphone: 'returned_mic', beltpack: 'returned_bp', battery: 'returned_battery' }[found.type];
  db.prepare(`UPDATE checklist_items SET ${col}=1 WHERE id=?`).run(found.id);
  db.prepare(`INSERT INTO return_scans (checklist_id, device_type, device_code, scanned_at, accepted)
              VALUES (?,?,?,?,1)`).run(checklistId, found.type, deviceCode, now());

  // 归还的设备释放
  if (found.type === 'microphone') db.prepare("UPDATE microphones SET state='in_stock' WHERE id=?").run(found.did);
  if (found.type === 'beltpack') db.prepare("UPDATE beltpacks SET state='in_stock' WHERE id=?").run(found.did);
  if (found.type === 'battery') {
    const bat = db.prepare('SELECT * FROM batteries WHERE id=?').get(found.did);
    db.prepare("UPDATE batteries SET state='available', updated_at=? WHERE id=?").run(now(), found.did);
    if (bat.charge_pct < LOW_CHARGE_THRESHOLD) {
      raiseFault(db, {
        kind: 'low_battery', refType: 'battery', refId: bat.id, showId: cl.show_id,
        detail: `归还电池 ${bat.code} 电量 ${bat.charge_pct}%，需立即充电`,
      });
    }
  }
  return { ok: true, found };
}

function findDeviceInChecklist(db, checklistId, code) {
  const item = db.prepare(`
    SELECT ci.*, 'microphone' AS type, m.id AS did FROM checklist_items ci
      JOIN microphones m ON m.id = ci.microphone_id
     WHERE ci.checklist_id=? AND m.code=?
    UNION ALL
    SELECT ci.*, 'beltpack' AS type, p.id AS did FROM checklist_items ci
      JOIN beltpacks p ON p.id = ci.beltpack_id
     WHERE ci.checklist_id=? AND p.code=?
    UNION ALL
    SELECT ci.*, 'battery' AS type, b.id AS did FROM checklist_items ci
      JOIN batteries b ON b.id = ci.spare_battery_id
     WHERE ci.checklist_id=? AND b.code=?`).all(checklistId, code, checklistId, code, checklistId, code)[0];
  return item || null;
}

// 完成清点：缺件生成漏件故障；之后迟到的扫描一律拒收
function settleChecklist(db, staff, checklistId, note) {
  assertCan(staff.role, 'checklist:settle');
  const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
  if (!cl) throw bizError('清单不存在');
  if (cl.state !== 'issued') throw bizError('只有演出进行中的清单可以完成清点');

  const items = db.prepare('SELECT * FROM checklist_items WHERE checklist_id=?').all(checklistId);
  const missing = [];
  db.exec('SAVEPOINT settle');
  try {
    for (const it of items) {
      const gaps = [
        ['microphone', it.microphone_id, it.returned_mic, '麦克风'],
        ['beltpack', it.beltpack_id, it.returned_bp, '腰包'],
        ['battery', it.spare_battery_id, it.returned_battery, '备用电池'],
      ];
      for (const [type, id, returned, label] of gaps) {
        if (id == null) continue;
        if (!returned) {
          missing.push({ type, id, label, role: it.role_name });
          raiseFault(db, {
            kind: 'missing_return', refType: type, refId: id, showId: cl.show_id,
            detail: `角色「${it.role_name}」归还漏件：${label} 未交回`,
          });
        }
      }
    }
    db.prepare("UPDATE checklists SET state='settled', settled_at=?, settle_note=? WHERE id=?")
      .run(now(), note || (missing.length ? `清点完成，${missing.length} 件漏件转故障队列` : '清点完成，全部归齐'), checklistId);
    db.prepare("UPDATE shows SET status='settled' WHERE id=?").run(cl.show_id);
    releaseLocks(db, checklistId);
    db.exec('RELEASE SAVEPOINT settle');
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT settle');
    throw e;
  }
  return { ok: true, missing_count: missing.length, missing };
}

function releaseLocks(db, checklistId) {
  // 锁全部释放；未归还设备状态保持 checked_out/assigned，由故障队列追讨
  db.prepare('DELETE FROM equipment_locks WHERE checklist_id=?').run(checklistId);
}

// 漏件追结：标记丢失
function markLost(db, staff, faultId) {
  assertCan(staff.role, 'fault:resolve');
  const f = db.prepare('SELECT * FROM faults WHERE id=?').get(faultId);
  if (!f || f.kind !== 'missing_return') throw bizError('故障不存在或非漏件类型');
  const codeRow = db.prepare(
    f.ref_type === 'battery' ? 'SELECT code FROM batteries WHERE id=?'
      : f.ref_type === 'microphone' ? 'SELECT code FROM microphones WHERE id=?'
        : 'SELECT code FROM beltpacks WHERE id=?').get(f.ref_id);
  if (f.ref_type === 'battery') db.prepare("UPDATE batteries SET state='lost', updated_at=? WHERE id=?").run(now(), f.ref_id);
  if (f.ref_type === 'microphone') db.prepare("UPDATE microphones SET state='lost' WHERE id=?").run(f.ref_id);
  if (f.ref_type === 'beltpack') db.prepare("UPDATE beltpacks SET state='lost' WHERE id=?").run(f.ref_id);
  resolveFault(db, staff, faultId, `设备 ${codeRow?.code || ''} 标记丢失，转采购/赔偿流程`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 错频核对：演出频点方案 vs 套装内麦克风实际频点
function listFreqPlan(db, showId) {
  return db.prepare('SELECT * FROM freq_plan WHERE show_id=? ORDER BY band').all(showId);
}
function checkFrequencies(db, staff, showId) {
  assertCan(staff.role, 'freq:check');
  const plan = listFreqPlan(db, showId);
  const cl = getChecklistByShow(db, showId);
  if (!cl) throw bizError('该场次还没有领用清单');
  const mismatches = [];
  for (const it of cl.items) {
    if (!it.microphone_id) continue;
    const want = plan.find((p) => p.band === it.mic_band);
    // 同频段允许 ±4MHz 协调窗口；超出窗口判错频
    if (want && Math.abs((it.mic_freq || 0) - want.freq_mhz) > FREQ_TOLERANCE_MHZ) {
      mismatches.push({ item: it.role_name, mic: it.mic_code, band: it.mic_band,
        expected: want.freq_mhz, actual: it.mic_freq });
      const exists = db.prepare(`SELECT 1 FROM faults WHERE kind='wrong_freq' AND ref_id=? AND status!='resolved'
                                  AND show_id=?`).get(it.microphone_id, showId);
      if (!exists) {
        raiseFault(db, {
          kind: 'wrong_freq', refType: 'microphone', refId: it.microphone_id, showId,
          detail: `${it.mic_code}（${it.role_name}）频点 ${it.mic_freq}MHz 与方案 ${want.freq_mhz}MHz 不符`,
        });
      }
    }
  }
  return { checked: cl.items.length, mismatches };
}
function fixFrequency(db, staff, microphoneId, freqMhz) {
  assertCan(staff.role, 'freq:fix');
  db.prepare('UPDATE microphones SET freq_mhz=? WHERE id=?').run(freqMhz, microphoneId);
  resolveFaultsFor(db, 'microphone', microphoneId, staff, `频点校正为 ${freqMhz}MHz`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 低电量巡检
function scanLowBattery(db) {
  const rows = db.prepare(`SELECT * FROM batteries
     WHERE charge_pct < ? AND state IN ('available')`).all(LOW_CHARGE_THRESHOLD);
  let created = 0;
  for (const b of rows) {
    const exists = db.prepare(`SELECT 1 FROM faults WHERE kind='low_battery' AND ref_id=? AND status!='resolved'`).get(b.id);
    if (!exists) {
      raiseFault(db, { kind: 'low_battery', refType: 'battery', refId: b.id,
        detail: `电池 ${b.code} 电量 ${b.charge_pct}% 低于 ${LOW_CHARGE_THRESHOLD}%，请安排充电` });
      created++;
    }
  }
  return { low: rows.length, faults_created: created };
}

// ---------------------------------------------------------------------------
// 故障队列
function raiseFault(db, { kind, refType, refId, showId = null, detail }) {
  const info = db.prepare(`INSERT INTO faults (kind, ref_type, ref_id, show_id, detail, created_at)
      VALUES (?,?,?,?,?,?)`).run(kind, refType, refId, showId, detail, now());
  return Number(info.lastInsertRowid);
}
function listFaults(db, status = 'open') {
  return db.prepare(`
    SELECT f.*,
      CASE f.ref_type WHEN 'battery' THEN (SELECT code FROM batteries WHERE id=f.ref_id)
                      WHEN 'microphone' THEN (SELECT code FROM microphones WHERE id=f.ref_id)
                      WHEN 'beltpack' THEN (SELECT code FROM beltpacks WHERE id=f.ref_id)
                      ELSE '' END AS ref_code,
      s.name AS show_name
      FROM faults f LEFT JOIN shows s ON s.id=f.show_id
     WHERE (?='all' OR f.status=?) ORDER BY
       CASE f.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, f.id`).all(status, status);
}
function acknowledgeFault(db, staff, id) {
  assertCan(staff.role, 'fault:resolve');
  db.prepare("UPDATE faults SET status='acknowledged' WHERE id=? AND status='open'").run(id);
  return { ok: true };
}
function resolveFault(db, staff, id, resolution) {
  assertCan(staff.role, 'fault:resolve');
  db.prepare("UPDATE faults SET status='resolved', resolved_at=?, resolved_by=?, resolution=? WHERE id=?")
    .run(now(), staff.id, resolution || '已处理', id);
  return { ok: true };
}
function resolveFaultsFor(db, refType, refId, staff, resolution) {
  db.prepare(`UPDATE faults SET status='resolved', resolved_at=?, resolved_by=?, resolution=?
              WHERE ref_type=? AND ref_id=? AND status!='resolved'`)
    .run(now(), staff.id, resolution, refType, refId);
}

// ---------------------------------------------------------------------------
function bizError(msg) { const e = new Error(msg); e.code = 'BIZ'; return e; }
function forbiddenError(msg) { const e = new Error(msg); e.code = 'FORBIDDEN'; return e; }

const stateText = {
  battery: { available: '在库', assigned: '演出占用/未追回', charging: '充电中', quarantined: '已隔离', retired: '已报废', lost: '丢失' },
  device: { in_stock: '在库', checked_out: '已领用未还', maintenance: '维修中', lost: '丢失' },
};

module.exports = {
  can, assertCan, PERMISSIONS,
  listStaff, listShows,
  listBatteries, listMicrophones, listBeltpacks, chargerGrid,
  dockBattery, ejectBattery,
  receiveReceipt, applyReceipts, estimateHealth,
  scanHealth, requestRelease, reviewRelease, autoQuarantine,
  createChecklist, getChecklist, getChecklistByShow, listChecklists,
  addItem, removeItem, lockChecklist, issueChecklist,
  scanReturn, settleChecklist, markLost, findDeviceInChecklist,
  listFreqPlan, checkFrequencies, fixFrequency,
  scanLowBattery,
  raiseFault, listFaults, acknowledgeFault, resolveFault,
};
