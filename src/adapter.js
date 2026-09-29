'use strict';
// 本地充电适配器：模拟充电柜硬件上报。
// 回执通过 deliver() 进入入库队列；可指定 delay/shuffle，模拟网络乱序与迟到。
const core = require('./core');

class ChargerAdapter {
  constructor(db, opts = {}) {
    this.db = db;
    // outOfOrder=true 时故意打乱回执顺序，驱动乱序测试
    this.opts = opts;
    this._queued = [];   // 待投递回执（带延迟）
    this._timer = null;
  }

  // 生成一次完整充电过程的设备回执（不立即投递）
  planCharge(slotCode, batteryCode, { fail = false, contactBadAt = null, startCharge = 5 } = {}) {
    const receipts = [{ slot_code: slotCode, battery_code: batteryCode, seq: 1, event: 'plugged', charge_pct: startCharge }];
    if (contactBadAt != null) {
      receipts.push({ slot_code: slotCode, battery_code: batteryCode, seq: 2, event: 'contact_bad', charge_pct: contactBadAt });
      return receipts;
    }
    if (fail) {
      receipts.push({ slot_code: slotCode, battery_code: batteryCode, seq: 2, event: 'failed', charge_pct: startCharge });
      return receipts;
    }
    let seq = 2;
    for (const pct of [25, 50, 75, 95]) {
      receipts.push({ slot_code: slotCode, battery_code: batteryCode, seq: seq++, event: 'progress', charge_pct: pct });
    }
    receipts.push({ slot_code: slotCode, battery_code: batteryCode, seq: seq, event: 'full', charge_pct: 100 });
    return receipts;
  }

  // 直接送一条回执到入库队列（保持到达顺序即调用顺序）
  ingest(receipt) {
    return core.receiveReceipt(this.db, receipt);
  }

  // 批量投递；shuffle 时乱序发送，应用层按 seq 去重保序
  deliverBatch(receipts, { shuffle = false } = {}) {
    const ordered = receipts.slice();
    if (shuffle) {
      // 固定的“乱序”：后发的先到
      ordered.reverse();
    }
    const results = [];
    for (const r of ordered) results.push(this.ingest(r));
    return results;
  }

  // 模拟迟到回传：在会话已结束后再补发一条旧 seq 回执
  deliverLate(receipt) {
    return this.ingest(receipt);
  }

  // 便捷：完整模拟一次充电（含可选乱序），返回 apply 结果
  simulateCharge(slotCode, batteryCode, opts = {}) {
    const receipts = this.planCharge(slotCode, batteryCode, opts);
    this.deliverBatch(receipts, { shuffle: opts.shuffle });
    return core.applyReceipts(this.db);
  }
}

module.exports = { ChargerAdapter };
