'use strict';
// 共享前端：导航、岗位登录、API、提示
const ROLE_LABEL = {
  stage_manager: '舞台监督',
  audio_engineer: '音响师',
  warehouse: '库房管理员',
  performer: '演员',
};
const FAULT_LABEL = {
  low_battery: '低电量', charge_failed: '充电失败', contact_bad: '接触不良',
  lost: '丢失', wrong_freq: '错频', missing_return: '归还漏件', health_quarantine: '健康度隔离',
};

let ME = null;
let PERMS = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function pctBar(pct) {
  const cls = pct < 20 ? 'low' : pct < 60 ? 'mid' : '';
  return `<span class="bar ${cls}" style="display:inline-block;vertical-align:middle"><i style="width:${pct}%"></i></span> <span class="mono">${pct}%</span>`;
}
function can(action) { return PERMS.includes(action); }

// 给需要权限的元素加 data-perm；无权则禁用/隐藏
function applyPermissions(root = document) {
  root.querySelectorAll('[data-perm]').forEach((el) => {
    const needed = el.dataset.perm.split(',');
    const ok = needed.some((p) => PERMS.includes(p));
    if (el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'INPUT') el.disabled = !ok;
    else el.style.display = ok ? '' : 'none';
    if (!ok) el.title = `当前岗位无权操作（需要：${needed.join(' / ')}）`;
  });
}

async function initAuth() {
  const [me, staff] = await Promise.all([api('/api/me'), api('/api/staff')]);
  ME = me.user;
  PERMS = me.permissions;

  const sel = document.getElementById('staffSelect');
  if (sel) {
    sel.innerHTML = '<option value="">未登录（只读演示）</option>' +
      staff.map((s) => `<option value="${s.id}" ${ME && ME.id === s.id ? 'selected' : ''}>${esc(s.name)} · ${ROLE_LABEL[s.role]}</option>`).join('');
    sel.addEventListener('change', async () => {
      if (!sel.value) { await api('/api/logout', { method: 'POST' }); }
      else { await api('/api/login', { method: 'POST', body: { staff_id: Number(sel.value) } }); }
      location.reload();
    });
  }
  const badge = document.getElementById('roleBadge');
  if (badge) {
    if (ME) { badge.textContent = ROLE_LABEL[ME.role]; badge.className = 'role-badge'; }
    else { badge.textContent = '未登录'; badge.className = 'role-badge none'; }
  }
  applyPermissions();
  return ME;
}

function stateLabel(s) {
  return {
    draft: '草稿', locked: '已锁定', issued: '演出中', settled: '已清点',
    scheduled: '待上演', in_progress: '进行中', cancelled: '已取消',
    available: '在库', assigned: '套装占用', charging: '充电中',
    quarantined: '已隔离', retired: '已报废', lost: '丢失',
    in_stock: '在库', checked_out: '已领用', maintenance: '维修中',
    charging_s: '充电中', done: '已充满', failed: '充电失败',
    contact_bad: '接触不良', ejected: '已弹出',
    auto: '自动隔离', pending_release: '待复核', released: '已解除', rejected: '复核驳回',
    open: '待处理', acknowledged: '处理中', resolved: '已解决',
  }[s] || s;
}

function badge(s, extra = '') {
  return `<span class="badge ${s} ${extra}">${stateLabel(s)}</span>`;
}

const PAGES = [
  ['/', '场次日历'],
  ['/kits.html', '设备套装'],
  ['/chargers.html', '充电柜'],
  ['/checklists.html', '领用清单'],
  ['/returns.html', '归还检测'],
  ['/faults.html', '故障队列'],
];
function renderTabs() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  const cur = location.pathname.replace(/^\/+/, '') || '';
  nav.innerHTML = PAGES.map(([href, label]) =>
    `<a href="${href}" class="${(href === '/' ? cur === '' || cur === 'index.html' : cur === href.slice(1)) ? 'active' : ''}">${label}</a>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  renderTabs();
  await initAuth();
  if (typeof pageInit === 'function') {
    try { await pageInit(); } catch (e) { toast(e.message, 'err'); }
  }
});
