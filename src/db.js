'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ROLES = {
  AUDIO: 'audio',       // 调音师：改频、锁定领用单
  STAGE: 'stage',       // 舞台主管：发料锁定、归还结算（含漏件例外）
  TECH: 'tech',         // 设备技术员：充电柜操作、发起解除隔离
  MANAGER: 'manager',   // 场馆经理：隔离复核、故障销案
};

const HEALTH_THRESHOLD = 80;   // 健康度低于此值自动隔离
const LOW_BATTERY = 20;        // 电量低于此值告警且禁止入场
const FULL_CHARGE = 95;        // 超过视为可发放

function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS staff(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    pin TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shows(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | closed
    notes TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS microphones(
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL DEFAULT '',
    band TEXT NOT NULL DEFAULT '',
    freq_mhz REAL,
    status TEXT NOT NULL DEFAULT 'ok',        -- ok | fault | isolated | retired
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS beltpacks(
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS batteries(
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL DEFAULT '',
    cycles INTEGER NOT NULL DEFAULT 0,
    charge_pct INTEGER NOT NULL DEFAULT 100,
    health_pct INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'active',    -- active | isolated | retired
    isolated_reason TEXT NOT NULL DEFAULT '',
    isolated_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'none', -- none | pending | approved | rejected
    review_requested_by INTEGER,
    review_requested_at TEXT,
    reviewed_by INTEGER,
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cabinets(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slots(
    id INTEGER PRIMARY KEY,
    cabinet_id INTEGER NOT NULL REFERENCES cabinets(id),
    position TEXT NOT NULL,
    battery_id INTEGER REFERENCES batteries(id),
    state TEXT NOT NULL DEFAULT 'empty', -- empty | charging | charge_failed | contact_fault | ready
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_receipt_at TEXT,
    message TEXT NOT NULL DEFAULT '',
    UNIQUE(cabinet_id, position)
  );

  CREATE TABLE IF NOT EXISTS checklists(
    id INTEGER PRIMARY KEY,
    show_id INTEGER NOT NULL REFERENCES shows(id),
    role_name TEXT NOT NULL DEFAULT '',
    assignee_id INTEGER REFERENCES staff(id),
    status TEXT NOT NULL DEFAULT 'draft', -- draft | locked | checked_in
    locked_at TEXT,
    checked_in_at TEXT,
    settle_note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS kit_items(
    id INTEGER PRIMARY KEY,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id),
    kind TEXT NOT NULL,                    -- mic | battery | pack
    ref_id INTEGER NOT NULL,
    is_spare INTEGER NOT NULL DEFAULT 0,
    returned INTEGER NOT NULL DEFAULT 0,
    returned_at TEXT,
    UNIQUE(checklist_id, kind, ref_id)
  );

  -- 设备占用：锁定时写入，归还时删除。同一设备物理唯一，不能同时出现在两张生效清单。
  CREATE TABLE IF NOT EXISTS holds(
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id),
    locked_at TEXT NOT NULL,
    PRIMARY KEY(kind, ref_id)
  );

  CREATE TABLE IF NOT EXISTS receipt_events(
    id INTEGER PRIMARY KEY,
    slot_id INTEGER NOT NULL REFERENCES slots(id),
    battery_id INTEGER,
    seq INTEGER NOT NULL,
    charge_pct INTEGER,
    health_pct INTEGER,
    result TEXT NOT NULL,                  -- charging | ready | charge_failed | contact_fault
    received_at TEXT NOT NULL,
    applied INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS return_scans(
    id INTEGER PRIMARY KEY,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id),
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    scanned_at TEXT NOT NULL,
    applied INTEGER NOT NULL DEFAULT 1,   -- 0 = 迟到回传，挂起复核
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS faults(
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL, -- low_battery | charge_failed | contact_fault | lost | wrong_freq | missing_return
    severity TEXT NOT NULL DEFAULT 'warn', -- info | warn | block
    ref_kind TEXT NOT NULL DEFAULT '',
    ref_id INTEGER,
    show_id INTEGER,
    slot_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',   -- open | pending_review | resolved | dismissed
    detail TEXT NOT NULL DEFAULT '',
    reported_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by INTEGER,
    resolution TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    actor_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_kit_checklist ON kit_items(checklist_id);
  CREATE INDEX IF NOT EXISTS idx_faults_status ON faults(status);
  CREATE INDEX IF NOT EXISTS idx_receipts_slot ON receipt_events(slot_id, id);
  `);
}

module.exports = { openDb, ROLES, HEALTH_THRESHOLD, LOW_BATTERY, FULL_CHARGE };
