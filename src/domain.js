'use strict';
const { ROLES, HEALTH_THRESHOLD, LOW_BATTERY, FULL_CHARGE } = require('./db');

class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const now = () => new Date().toISOString();

function createServices(db, clock = now) {
  const ts = () => clock();

  // ---------- 权限矩阵 ----------
  const CAN = {
    checklist_lock: [ROLES.STAGE, ROLES.MANAGER],
    return_scan: [ROLES.TECH, ROLES.STAGE],
    settle: [ROLES.STAGE],
    charge_op: [ROLES.TECH],
    freq_change: [ROLES.AUDIO],
    review_release: [ROLES.MANAGER],
    review_request: [ROLES.TECH],
    fault_close: [ROLES.MANAGER, ROLES.STAGE],
  };
  const permit = (actor, action) => {
    if (!actor) throw new DomainError('unauthorized', '未指定操作人员');
    if (!CAN[action].includes(actor.role)) {
      throw new DomainError('forbidden', `岗位 ${actor.role} 无权执行：${action}`);
    }
  };
  const staffById = (id) => db.prepare('SELECT * FROM staff WHERE id=? AND archived=0').get(id);
  const actorOf = (staffId) => {
    const a = staffById(staffId);
    if (!a) throw new DomainError('unauthorized', '人员不存在或已停用');
    return a;
  };

  const audit = (actorId, action, detail = '') => {
    db.prepare('INSERT INTO audit_log(ts, actor_id, action, detail) VALUES(?,?,?,?)')
      .run(ts(), actorId, action, detail);
  };

  const openFault = (type, data) => {
    const dup = db.prepare(
      `SELECT id FROM faults WHERE type=? AND status IN ('open','pending_review')
       AND IFNULL(ref_kind,'')=IFNULL(?,'') AND IFNULL(ref_id,0)=IFNULL(?,0)
       AND IFNULL(show_id,0)=IFNULL(?,0)`
    ).get(type, data.ref_kind ?? null, data.ref_id ?? null, data.show_id ?? null);
    if (dup) return dup.id;
    const r = db.prepare(
      `INSERT INTO faults(type, severity, ref_kind, ref_id, show_id, slot_id, detail, reported_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(type, data.severity || 'warn', data.ref_kind ?? '', data.ref_id ?? null,
          data.show_id ?? null, data.slot_id ?? null, data.detail ?? '', ts());
    return Number(r.lastInsertRowid);
  };

  // ---------- 电池：健康隔离与复核 ----------
  const autoIsolate = (batteryId, reason) => {
    const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
    if (!b || b.status !== 'active') return false;
    db.prepare(
      `UPDATE batteries SET status='isolated', isolated_reason=?, isolated_at=?, review_status='none' WHERE id=?`
    ).run(reason, ts(), batteryId);
    openFault('health', {
      severity: 'block', ref_kind: 'battery', ref_id: batteryId,
      detail: `电池 ${b.code} 健康度 ${b.health_pct}% 低于阈值 ${HEALTH_THRESHOLD}%，已自动隔离：${reason}`,
    });
    audit(null, 'battery.auto_isolate', `${b.code} ${reason}`);
    return true;
  };

  // 设备技术员发起解除隔离申请
  const requestRelease = (staffId, batteryId) => {
    const actor = actorOf(staffId);
    permit(actor, 'review_request');
    const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
    if (!b) throw new DomainError('not_found', '电池不存在');
    if (b.status !== 'isolated') throw new DomainError('conflict', '该电池未处于隔离状态');
    if (b.review_status === 'pending') throw new DomainError('conflict', '已提交复核，等待经理审批');
    db.prepare(
      `UPDATE batteries SET review_status='pending', review_requested_by=?, review_requested_at=? WHERE id=?`
    ).run(actor.id, ts(), batteryId);
    db.prepare(
      `UPDATE faults SET status='pending_review' WHERE type='health' AND ref_id=? AND status IN ('open','pending_review')`
    ).run(batteryId);
    audit(actor.id, 'battery.review_request', b.code);
    return { ok: true };
  };

  // 场馆经理复核：健康度仍低于阈值时不得批准
  const reviewRelease = (staffId, batteryId, approved, comment = '') => {
    const actor = actorOf(staffId);
    permit(actor, 'review_release');
    const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
    if (!b) throw new DomainError('not_found', '电池不存在');
    if (b.review_status !== 'pending') throw new DomainError('conflict', '该电池没有待审批的解除申请');
    if (approved && b.health_pct < HEALTH_THRESHOLD) {
      throw new DomainError('review_blocked',
        `健康度 ${b.health_pct}% 仍低于阈值 ${HEALTH_THRESHOLD}%，不能解除隔离`);
    }
    if (approved) {
      db.prepare(
        `UPDATE batteries SET status='active', isolated_reason='', isolated_at=NULL,
          review_status='approved', reviewed_by=?, reviewed_at=? WHERE id=?`
      ).run(actor.id, ts(), batteryId);
      db.prepare(
        `UPDATE faults SET status='resolved', resolved_at=?, resolved_by=?, resolution=?
         WHERE type='health' AND ref_id=? AND status IN ('open','pending_review')`
      ).run(ts(), actor.id, '经理复核通过：' + comment, batteryId);
    } else {
      db.prepare(
        `UPDATE batteries SET review_status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?`
      ).run(actor.id, ts(), batteryId);
    }
    audit(actor.id, approved ? 'battery.review_approve' : 'battery.review_reject',
      `${b.code} ${comment}`);
    return { ok: true, approved };
  };

  // ---------- 充电柜：槽位 + 乱序回执 ----------
  const dockBattery = (staffId, slotId, batteryId) => {
    const actor = actorOf(staffId);
    permit(actor, 'charge_op');
    const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(slotId);
    if (!slot) throw new DomainError('not_found', '充电槽不存在');
    const b = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
    if (!b) throw new DomainError('not_found', '电池不存在');
    const occupied = db.prepare('SELECT id FROM slots WHERE battery_id=? AND id<>?').get(batteryId, slotId);
    if (occupied) throw new DomainError('conflict', '该电池已在其他槽位');
    const held = db.prepare('SELECT checklist_id FROM holds WHERE kind=? AND ref_id=?').get('battery', batteryId);
    if (held) throw new DomainError('conflict', '该电池已随演出套装出库，不在馆内，无法入柜');
    db.prepare(
      `UPDATE slots SET battery_id=?, state='charging', last_seq=last_seq+1,
       last_receipt_at=?, message='放入，开始充电' WHERE id=?`
    ).run(batteryId, ts(), slotId);
    audit(actor.id, 'slot.dock', `slot#${slotId} battery#${batteryId}`);
    return { ok: true };
  };

  const undockBattery = (staffId, slotId) => {
    const actor = actorOf(staffId);
    permit(actor, 'charge_op');
    db.prepare(
      `UPDATE slots SET battery_id=NULL, state='empty', message='槽位已清空' WHERE id=?`
    ).run(slotId);
    audit(actor.id, 'slot.undock', `slot#${slotId}`);
    return { ok: true };
  };

  /**
   * 本地适配器上报充电回执。seq 必须严格大于槽位已应用序号；
   * 乱序/迟到回执写入 receipt_events 但 applied=0，绝不覆盖较新状态。
   */
  const receiveReceipt = (slotId, payload) => {
    const slot = db.prepare('SELECT * FROM slots WHERE id=?').get(slotId);
    if (!slot) throw new DomainError('not_found', '充电槽不存在');
    const seq = Math.trunc(payload.seq);
    const applied = seq > slot.last_seq;
    db.prepare(
      `INSERT INTO receipt_events(slot_id, battery_id, seq, charge_pct, health_pct, result, received_at, applied, note)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(slotId, payload.battery_id ?? slot.battery_id ?? null, seq,
      payload.charge_pct ?? null, payload.health_pct ?? null,
      payload.result, ts(), applied ? 1 : 0,
      applied ? '' : `乱序回执(seq=${seq} <= 已应用 ${slot.last_seq})，已丢弃`);

    if (!applied) {
      return { applied: false, reason: 'stale_seq', last_seq: slot.last_seq };
    }

    const batteryId = payload.battery_id ?? slot.battery_id;
    let state = payload.result;
    if (state === 'ready') state = 'ready';
    let message = ({
      charging: `充电中 ${payload.charge_pct}%`,
      ready: `充电完成 ${payload.charge_pct}%`,
      charge_failed: '充电失败：电池无应答',
      contact_fault: '接触不良：请重新插拔',
    })[state] || state;

    db.prepare(
      `UPDATE slots SET state=?, last_seq=?, last_receipt_at=?, message=?, battery_id=COALESCE(battery_id,?) WHERE id=?`
    ).run(state, seq, ts(), message, batteryId, slotId);

    if (batteryId) {
      const b0 = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
      if (b0) {
        const fields = [];
        if (payload.charge_pct != null) fields.push(['charge_pct', Math.max(0, Math.min(100, payload.charge_pct))]);
        if (payload.health_pct != null) fields.push(['health_pct', Math.max(0, Math.min(100, payload.health_pct))]);
        let cycles = b0.cycles;
        // 完成一次完整充电：循环次数 +1
        if (state === 'ready' && slot.state !== 'ready') cycles += 1;
        fields.push(['cycles', cycles]);
        db.prepare(`UPDATE batteries SET ${fields.map(f => `${f[0]}=?`).join(',')} WHERE id=?`)
          .run(...fields.map(f => f[1]), batteryId);

        if (state === 'charge_failed') {
          openFault('charge_failed', { severity: 'warn', ref_kind: 'battery', ref_id: batteryId, slot_id: slotId,
            detail: `槽位 ${slot.position} 报告电池 ${b0.code} 充电失败` });
        }
        if (state === 'contact_fault') {
          openFault('contact_fault', { severity: 'warn', ref_kind: 'slot', ref_id: slotId, slot_id: slotId,
            detail: `槽位 ${slot.position} 接触不良（电池 ${b0.code}）` });
        }
        const b1 = db.prepare('SELECT * FROM batteries WHERE id=?').get(batteryId);
        if (b1.health_pct < HEALTH_THRESHOLD) {
          autoIsolate(batteryId, `回执健康度 ${b1.health_pct}% (seq=${seq})`);
        }
      }
    }
    audit(null, 'slot.receipt', `slot#${slotId} seq=${seq} ${payload.result} applied=1`);
    return { applied: true, seq, state };
  };

  // ---------- 麦克风：频率 ----------
  const setMicFrequency = (staffId, micId, freqMhz) => {
    const actor = actorOf(staffId);
    permit(actor, 'freq_change');
    const mic = db.prepare('SELECT * FROM microphones WHERE id=?').get(micId);
    if (!mic) throw new DomainError('not_found', '麦克风不存在');
    const f = Number(freqMhz);
    if (!Number.isFinite(f) || f <= 0) throw new DomainError('bad_request', '频率无效');
    const clash = db.prepare('SELECT id, code FROM microphones WHERE id<>? AND ABS(freq_mhz-?)<0.01 AND status<>\'retired\'')
      .get(micId, f);
    db.prepare('UPDATE microphones SET freq_mhz=?, status=? WHERE id=?')
      .run(f, clash ? 'fault' : 'ok', micId);
    if (clash) {
      openFault('wrong_freq', { severity: 'block', ref_kind: 'mic', ref_id: micId,
        detail: `${mic.code} 频率 ${f}MHz 与 ${clash.code} 撞频` });
    } else {
      db.prepare(`UPDATE faults SET status='resolved', resolved_at=?, resolved_by=?, resolution='频率已校正'
        WHERE type='wrong_freq' AND ref_id=? AND status IN ('open','pending_review')`)
        .run(ts(), actor.id, micId);
    }
    audit(actor.id, 'mic.freq_set', `${mic.code} -> ${f}MHz`);
    return { ok: true, clash: !!clash };
  };

  const flagWrongFreq = (staffId, micId, detail) => {
    const actor = actorOf(staffId);
    permit(actor, 'freq_change');
    const mic = db.prepare('SELECT * FROM microphones WHERE id=?').get(micId);
    if (!mic) throw new DomainError('not_found', '麦克风不存在');
    db.prepare("UPDATE microphones SET status='fault' WHERE id=?").run(micId);
    const fid = openFault('wrong_freq', { severity: 'block', ref_kind: 'mic', ref_id: micId,
      detail: detail || `${mic.code} 频率异常/错频（当前 ${mic.freq_mhz ?? '未设'}MHz）` });
    audit(actor.id, 'mic.freq_flag', mic.code);
    return { fault_id: fid };
  };

  // ---------- 领用单 / 套装 ----------
  const createChecklist = (showId, roleName, assigneeId) => {
    const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
    if (!show) throw new DomainError('not_found', '演出不存在');
    const r = db.prepare('INSERT INTO checklists(show_id, role_name, assignee_id) VALUES(?,?,?)')
      .run(showId, roleName, assigneeId ?? null);
    return Number(r.lastInsertRowid);
  };

  const addKitItem = (checklistId, kind, refId, isSpare = 0) => {
    if (!['mic', 'battery', 'pack'].includes(kind)) throw new DomainError('bad_request', '设备类型非法');
    const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
    if (!cl) throw new DomainError('not_found', '领用单不存在');
    if (cl.status !== 'draft') throw new DomainError('conflict', '领用单已锁定，不能改动套装');
    const table = { mic: 'microphones', battery: 'batteries', pack: 'beltpacks' }[kind];
    const dev = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(refId);
    if (!dev) throw new DomainError('not_found', '设备不存在');
    if (kind === 'battery' && dev.status === 'isolated') {
      throw new DomainError('battery_isolated', `电池 ${dev.code} 已隔离，禁止领用`);
    }
    if ((kind === 'mic' || kind === 'pack') && dev.status === 'fault') {
      throw new DomainError('device_fault', `设备 ${dev.code} 有未排除故障，禁止领用`);
    }
    try {
      db.prepare('INSERT INTO kit_items(checklist_id, kind, ref_id, is_spare) VALUES(?,?,?,?)')
        .run(checklistId, kind, refId, isSpare ? 1 : 0);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new DomainError('duplicate', '该设备已在本套装中');
      throw e;
    }
    return { ok: true };
  };

  const removeKitItem = (checklistId, itemId) => {
    const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
    if (!cl) throw new DomainError('not_found', '领用单不存在');
    if (cl.status !== 'draft') throw new DomainError('conflict', '领用单已锁定，不能改动套装');
    db.prepare('DELETE FROM kit_items WHERE id=? AND checklist_id=?').run(itemId, checklistId);
    return { ok: true };
  };

  /** 锁定套装：把每件设备写入 holds；任一设备已被其他生效清单占用则整体回滚。 */
  const lockChecklist = (staffId, checklistId) => {
    const actor = actorOf(staffId);
    permit(actor, 'checklist_lock');
    const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
    if (!cl) throw new DomainError('not_found', '领用单不存在');
    if (cl.status !== 'draft') throw new DomainError('conflict', '领用单已锁定或已清点');
    const items = db.prepare('SELECT * FROM kit_items WHERE checklist_id=?').all(checklistId);
    if (!items.some(i => i.kind === 'mic')) throw new DomainError('empty_kit', '套装至少要绑定一支麦克风');

    const conflicts = [];
    for (const it of items) {
      const hold = db.prepare('SELECT * FROM holds WHERE kind=? AND ref_id=?').get(it.kind, it.ref_id);
      if (hold) {
        const other = db.prepare('SELECT c.id, c.role_name, s.name show_name FROM checklists c JOIN shows s ON s.id=c.show_id WHERE c.id=?')
          .get(hold.checklist_id);
        conflicts.push({ kind: it.kind, ref_id: it.ref_id, held_by: other });
      }
    }
    if (conflicts.length) {
      throw new DomainError('kit_conflict', '套装中的设备已被其他领用单占用', { conflicts });
    }

    db.prepare('BEGIN').run();
    try {
      for (const it of items) {
        db.prepare('INSERT INTO holds(kind, ref_id, checklist_id, locked_at) VALUES(?,?,?,?)')
          .run(it.kind, it.ref_id, checklistId, ts());
      }
      db.prepare("UPDATE checklists SET status='locked', locked_at=? WHERE id=?").run(ts(), checklistId);
      db.prepare('COMMIT').run();
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch { /* 事务可能已结束 */ }
      throw e;
    }
    audit(actor.id, 'checklist.lock', `checklist#${checklistId} (${items.length} 件)`);
    return { ok: true, locked: items.length };
  };

  /** 归还扫码：锁定后可扫；已完成清点的迟到回传只登记不覆盖。 */
  const scanReturn = (staffId, checklistId, kind, refId, note = '') => {
    const actor = actorOf(staffId);
    permit(actor, 'return_scan');
    const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
    if (!cl) throw new DomainError('not_found', '领用单不存在');
    if (cl.status === 'draft') throw new DomainError('conflict', '套装尚未锁定，无需归还');

    const item = db.prepare('SELECT * FROM kit_items WHERE checklist_id=? AND kind=? AND ref_id=?')
      .get(checklistId, kind, refId);
    if (!item) throw new DomainError('not_in_kit', '该设备不属于此套装');

    const applied = cl.status === 'locked' ? 1 : 0; // checked_in 后一律挂起
    db.prepare('INSERT INTO return_scans(checklist_id, kind, ref_id, scanned_at, applied, note) VALUES(?,?,?,?,?,?)')
      .run(checklistId, kind, refId, ts(), applied, note || (applied ? '' : '清点完成后的迟到回传，不覆盖已完成清点'));

    if (!applied) {
      openFault('late_return', { severity: 'info', ref_kind: kind, ref_id: refId, show_id: cl.show_id,
        detail: `场次已清点后收到归还回传：${kind}#${refId}，已挂起，未改动清点结果` });
      audit(actor.id, 'return.late_scan', `checklist#${checklistId} ${kind}#${refId}`);
      return { applied: false, settled: true };
    }
    if (!item.returned) {
      db.prepare('UPDATE kit_items SET returned=1, returned_at=? WHERE id=?').run(ts(), item.id);
    }
    audit(actor.id, 'return.scan', `checklist#${checklistId} ${kind}#${refId}`);
    return { applied: true };
  };

  /**
   * 归还结算：缺件必须由舞台主管逐条登记例外（视为丢失）后才能完成清点。
   * 未登记例外的缺件 -> missing_return 故障，结算中止。
   */
  const settleChecklist = (staffId, checklistId, exceptions = []) => {
    const actor = actorOf(staffId);
    permit(actor, 'settle');
    const cl = db.prepare('SELECT * FROM checklists WHERE id=?').get(checklistId);
    if (!cl) throw new DomainError('not_found', '领用单不存在');
    if (cl.status !== 'locked') throw new DomainError('conflict', '套装不在待清点状态');

    const items = db.prepare('SELECT * FROM kit_items WHERE checklist_id=?').all(checklistId);
    const missing = items.filter(i => !i.returned);
    const exMap = new Map(exceptions.map(e => [`${e.kind}:${e.ref_id}`, e.reason || '舞台主管例外放行']));

    const unexplained = missing.filter(m => !exMap.has(`${m.kind}:${m.ref_id}`));
    for (const m of unexplained) {
      openFault('missing_return', { severity: 'block', ref_kind: m.kind, ref_id: m.ref_id, show_id: cl.show_id,
        detail: `领用单#${checklistId}（${cl.role_name}）归还缺件：${m.kind}#${m.ref_id}` });
    }
    if (unexplained.length) {
      throw new DomainError('missing_items', `有 ${unexplained.length} 件设备未归还且未登记例外`,
        { missing: missing.map(m => ({ kind: m.kind, ref_id: m.ref_id, explained: exMap.has(`${m.kind}:${m.ref_id}`) })) });
    }

    db.prepare('BEGIN').run();
    try {
      // 归还件释放占用；例外缺件按丢失建单并同样释放（设备不再处于“在用”）
      for (const m of missing) {
        openFault('lost', { severity: 'block', ref_kind: m.kind, ref_id: m.ref_id, show_id: cl.show_id,
          detail: `领用单#${checklistId} 丢失：${m.kind}#${m.ref_id} — ${exMap.get(`${m.kind}:${m.ref_id}`)}` });
      }
      db.prepare('DELETE FROM holds WHERE checklist_id=?').run(checklistId);
      db.prepare(
        `UPDATE checklists SET status='checked_in', checked_in_at=?, settle_note=? WHERE id=?`
      ).run(ts(), missing.length ? `缺件 ${missing.length} 件，已登记例外` : '齐套归还', checklistId);
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    audit(actor.id, 'checklist.settle',
      `checklist#${checklistId} returned=${items.length - missing.length}/${items.length}`);
    return { ok: true, returned: items.length - missing.length, lost: missing.length };
  };

  const closeFault = (staffId, faultId, resolution) => {
    const actor = actorOf(staffId);
    permit(actor, 'fault_close');
    const f = db.prepare('SELECT * FROM faults WHERE id=?').get(faultId);
    if (!f) throw new DomainError('not_found', '故障不存在');
    if (f.type === 'health') throw new DomainError('forbidden', '隔离故障必须通过隔离复核流程关闭');
    db.prepare("UPDATE faults SET status='resolved', resolved_at=?, resolved_by=?, resolution=? WHERE id=?")
      .run(ts(), actor.id, resolution || '人工关闭', faultId);
    audit(actor.id, 'fault.close', `fault#${faultId}`);
    return { ok: true };
  };

  // ---------- 场次 ----------
  const setShowStatus = (showId, status) => {
    if (!['scheduled', 'live', 'closed'].includes(status)) throw new DomainError('bad_request', '场次状态非法');
    db.prepare('UPDATE shows SET status=? WHERE id=?').run(status, showId);
    return { ok: true };
  };

  return {
    db, ts, DomainError, CAN,
    staffById, permit,
    autoIsolate, requestRelease, reviewRelease,
    dockBattery, undockBattery, receiveReceipt,
    setMicFrequency, flagWrongFreq,
    createChecklist, addKitItem, removeKitItem, lockChecklist,
    scanReturn, settleChecklist, closeFault, setShowStatus,
    openFault, audit,
    HEALTH_THRESHOLD, LOW_BATTERY, FULL_CHARGE,
  };
}

module.exports = { createServices, DomainError };
