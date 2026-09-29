'use strict';
// 本地充电柜适配器：模拟真实硬件回执。
// 真实部署中这里会是串口/网络驱动；演示中按槽位状态推进充电并生成回执。
// 关键特性：回执带单调递增 seq，乱序到达时领域层只接受更新的序号。

function createChargerAdapter(svc, opts = {}) {
  const failRate = opts.failRate ?? 0.08;   // 充电失败概率
  const contactRate = opts.contactRate ?? 0.05; // 接触不良概率
  let tickNo = 0;

  // 测试/演示可注入随机源，保证可复现
  const rnd = opts.random || Math.random;

  /** 由适配器“下发”一帧回执（模拟硬件主动上报） */
  function emit(slot, overrides = {}) {
    const frame = {
      seq: (slot.last_seq || 0) + 1,
      battery_id: slot.battery_id,
      charge_pct: null,
      health_pct: null,
      result: 'charging',
      ...overrides,
    };
    return svc.receiveReceipt(slot.id, frame);
  }

  /** 模拟硬件网络抖动：两帧乱序到达（先高 seq 后低 seq） */
  function emitOutOfOrder(slot, later, earlier) {
    const a = svc.receiveReceipt(slot.id, { seq: (slot.last_seq || 0) + 2, battery_id: slot.battery_id, ...later });
    const b = svc.receiveReceipt(slot.id, { seq: (slot.last_seq || 0) + 1, battery_id: slot.battery_id, ...earlier });
    return { applied_newer: a, applied_older: b };
  }

  /** 推进一个充电槽：充电中 -> 电量上升 -> 充满；小概率故障 */
  function tickSlot(slot, battery) {
    if (!slot.battery_id || slot.state === 'empty' || slot.state === 'ready') return null;
    tickNo += 1;

    if (slot.state === 'contact_fault') {
      // 接触不良不会自愈，等待人工重新插拔
      return null;
    }
    if (slot.state === 'charge_failed') {
      // 重试一帧：恢复充电
      return emit(slot, { result: 'charging', charge_pct: battery.charge_pct, health_pct: battery.health_pct });
    }

    // 确定性“随机”：同一电池同一 tick 结果稳定一点也无妨
    const roll = rnd();
    if (roll < failRate && battery.charge_pct < 90) {
      return emit(slot, { result: 'charge_failed' });
    }
    if (roll < failRate + contactRate) {
      return emit(slot, { result: 'contact_fault' });
    }

    const next = Math.min(100, battery.charge_pct + 10 + Math.floor(rnd() * 11));
    const healthWear = tickNo % 7 === 0 && battery.health_pct > 1 ? -1 : 0; // 偶发健康磨损
    const health = battery.health_pct + healthWear;
    if (next >= 100) {
      return emit(slot, { result: 'ready', charge_pct: 100, health_pct: health });
    }
    return emit(slot, { result: 'charging', charge_pct: next, health_pct: health });
  }

  function tickAll() {
    const slots = svc.db.prepare('SELECT * FROM slots WHERE battery_id IS NOT NULL').all();
    const out = [];
    for (const slot of slots) {
      const b = svc.db.prepare('SELECT * FROM batteries WHERE id=?').get(slot.battery_id);
      const r = tickSlot(slot, b);
      if (r) out.push({ slot_id: slot.id, ...r });
    }
    return out;
  }

  return { emit, emitOutOfOrder, tickSlot, tickAll };
}

module.exports = { createChargerAdapter };
