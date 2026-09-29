'use strict';
// 数据访问层：SQLite 表结构、连接与健康度阈值
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// 健康度低于该阈值自动隔离；低电量阈值；充满判定
const HEALTH_QUARANTINE_THRESHOLD = 80; // SOH < 80% → 自动隔离
const LOW_CHARGE_THRESHOLD = 20;        // 电量 < 20% → 低电量事件/提醒
const FULL_CHARGE = 99;

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 人员（演示数据）
CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('stage_manager','audio_engineer','warehouse','performer')),
  title      TEXT NOT NULL
);

-- 演出场次
CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  venue       TEXT NOT NULL,
  start_at    TEXT NOT NULL,   -- ISO 时间
  end_at      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled','in_progress','settled','cancelled'))
);

-- 麦克风（手持/头戴）
CREATE TABLE IF NOT EXISTS microphones (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,     -- 资产编号，如 MIC-HH-01
  model     TEXT NOT NULL,
  band      TEXT NOT NULL,            -- 频段，如 UHF-A
  freq_mhz  REAL,                     -- 当前频点
  kind      TEXT NOT NULL CHECK (kind IN ('handheld','headset')),
  state     TEXT NOT NULL DEFAULT 'in_stock'
            CHECK (state IN ('in_stock','checked_out','maintenance','lost'))
);

-- 腰包（发射机）
CREATE TABLE IF NOT EXISTS beltpacks (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE,
  model  TEXT NOT NULL,
  band   TEXT NOT NULL,
  state  TEXT NOT NULL DEFAULT 'in_stock'
         CHECK (state IN ('in_stock','checked_out','maintenance','lost'))
);

-- 电池
CREATE TABLE IF NOT EXISTS batteries (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  model         TEXT NOT NULL,
  cycles        INTEGER NOT NULL DEFAULT 0,      -- 循环次数
  charge_pct    INTEGER NOT NULL DEFAULT 100,    -- 当前电量
  health_pct    INTEGER NOT NULL DEFAULT 100,    -- 健康状态 SOH
  state         TEXT NOT NULL DEFAULT 'available'
                CHECK (state IN ('available','assigned','charging','quarantined','retired','lost')),
  -- 隔离复核：自动隔离时 review_status='auto'，人工解除需 warehouse 复核 → 'released'
  review_status TEXT NOT NULL DEFAULT 'none'
                CHECK (review_status IN ('none','auto','pending_release','released','rejected')),
  review_by     INTEGER REFERENCES staff(id),
  review_note   TEXT,
  updated_at    TEXT NOT NULL
);

-- 充电柜
CREATE TABLE IF NOT EXISTS chargers (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,    -- CAB-1
  name    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
  id          INTEGER PRIMARY KEY,
  charger_id  INTEGER NOT NULL REFERENCES chargers(id),
  position    INTEGER NOT NULL,   -- 槽位号 1..N
  UNIQUE (charger_id, position)
);

-- 槽位占用 / 充电会话
CREATE TABLE IF NOT EXISTS slot_sessions (
  id           INTEGER PRIMARY KEY,
  slot_id      INTEGER NOT NULL REFERENCES slots(id),
  battery_id   INTEGER NOT NULL REFERENCES batteries(id),
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  start_charge INTEGER NOT NULL,
  end_charge   INTEGER,
  status       TEXT NOT NULL DEFAULT 'charging'
               CHECK (status IN ('charging','done','failed','contact_bad','ejected'))
);

-- 设备原始回执（适配器上报，按 seq 乱序可能到达）
CREATE TABLE IF NOT EXISTS slot_receipts (
  id           INTEGER PRIMARY KEY,
  slot_code    TEXT NOT NULL,      -- CAB-1:3
  battery_code TEXT NOT NULL,
  seq          INTEGER NOT NULL,   -- 设备单调序号
  event        TEXT NOT NULL CHECK (event IN ('plugged','progress','full','failed','contact_bad')),
  charge_pct   INTEGER,
  payload_raw  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  applied      INTEGER NOT NULL DEFAULT 0,   -- 0 收到未应用, 1 已应用, 2 乱序丢弃
  UNIQUE (slot_code, seq)
);

-- 故障队列
CREATE TABLE IF NOT EXISTS faults (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN
               ('low_battery','charge_failed','contact_bad','lost','wrong_freq','missing_return','health_quarantine')),
  ref_type     TEXT NOT NULL CHECK (ref_type IN ('battery','microphone','beltpack','checklist')),
  ref_id       INTEGER NOT NULL,
  show_id      INTEGER REFERENCES shows(id),
  detail       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','acknowledged','resolved')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  INTEGER REFERENCES staff(id),
  resolution   TEXT
);

-- 演出频点方案（错频核对基准）
CREATE TABLE IF NOT EXISTS freq_plan (
  id       INTEGER PRIMARY KEY,
  show_id  INTEGER NOT NULL REFERENCES shows(id),
  band     TEXT NOT NULL,
  freq_mhz REAL NOT NULL,
  UNIQUE (show_id, band)
);

-- 领用清单（一场演出一份；创建即套装，领用后锁定）
CREATE TABLE IF NOT EXISTS checklists (
  id          INTEGER PRIMARY KEY,
  show_id     INTEGER NOT NULL UNIQUE REFERENCES shows(id),
  created_by  INTEGER REFERENCES staff(id),
  state       TEXT NOT NULL DEFAULT 'draft'
              CHECK (state IN ('draft','locked','issued','settled')),
  locked_at   TEXT,
  issued_at   TEXT,
  settled_at  TEXT,
  settle_note TEXT
);

-- 清单项：按角色绑定麦克风、腰包、备用电池
CREATE TABLE IF NOT EXISTS checklist_items (
  id              INTEGER PRIMARY KEY,
  checklist_id    INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  role_name       TEXT NOT NULL,          -- 例：男主唱 / 主持A
  assignee_name   TEXT,                   -- 具体演职人员（可空）
  microphone_id   INTEGER REFERENCES microphones(id),
  beltpack_id     INTEGER REFERENCES beltpacks(id),
  spare_battery_id INTEGER REFERENCES batteries(id),
  returned_mic     INTEGER NOT NULL DEFAULT 0,
  returned_bp      INTEGER NOT NULL DEFAULT 0,
  returned_battery INTEGER NOT NULL DEFAULT 0,
  UNIQUE (checklist_id, role_name)
);

-- 设备占用审计：保证同一电池不能同时出现在两个（未完成）清单；麦克风/腰包同理
-- 一张表记录所有已锁定套装中的设备，清单结算时删除
CREATE TABLE IF NOT EXISTS equipment_locks (
  id           INTEGER PRIMARY KEY,
  checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  device_type  TEXT NOT NULL CHECK (device_type IN ('battery','microphone','beltpack')),
  device_id    INTEGER NOT NULL,
  UNIQUE (device_type, device_id)   -- 套装唯一约束的最终防线
);

-- 归还扫描流水（迟到回传在清单 settled 后仅记录，不覆盖清点结果）
CREATE TABLE IF NOT EXISTS return_scans (
  id           INTEGER PRIMARY KEY,
  checklist_id INTEGER NOT NULL REFERENCES checklists(id),
  device_type  TEXT NOT NULL CHECK (device_type IN ('battery','microphone','beltpack')),
  device_code  TEXT NOT NULL,
  scanned_at   TEXT NOT NULL,
  accepted     INTEGER NOT NULL   -- 1 已计入清点; 0 迟到拒收
);
`;

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db')) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

module.exports = {
  openDb,
  HEALTH_QUARANTINE_THRESHOLD,
  LOW_CHARGE_THRESHOLD,
  FULL_CHARGE,
};
