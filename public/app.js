'use strict';
/* 声场周转台 —— 前端逻辑（原生 JS，无依赖） */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CAN = {
  checklist_lock: ['stage', 'manager'],
  return_scan: ['tech', 'stage'],
  settle: ['stage'],
  charge_op: ['tech'],
  freq_change: ['audio'],
  review_release: ['manager'],
  review_request: ['tech'],
  fault_close: ['manager', 'stage'],
};
const ROLE_LABEL = { manager: '场馆经理', stage: '舞台主管', audio: '调音师', tech: '设备技术员' };
const KIND_LABEL = { mic: '麦克风', battery: '电池', pack: '腰包' };

let state = null;
let currentStaffId = Number(localStorage.getItem('staffId') || 0);
let calCursor = new Date(2026, 8, 1); // 2026-09
let chosenReturnCl = Number(localStorage.getItem('returnCl') || 0);

// ---------- API ----------
async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || '请求失败');
    err.payload = data;
    throw err;
  }
  return data;
}
function toast(msg, type = '') {
  const t = el('div', { class: 'toast ' + type }, msg);
  $('#toastWrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 3200);
  setTimeout(() => t.remove(), 3800);
}
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}
const actor = () => state.staff.find(s => s.id === currentStaffId) || null;
const can = (action) => { const a = actor(); return a && CAN[action].includes(a.role); };

// ---------- 标签与格式化 ----------
const showStatusBadge = (st) => ({
  scheduled: ['badge cyan', '待演出'], live: ['badge red', '正在演出'], closed: ['badge gray', '已结清'],
}[st] || ['badge', st]);
const clStatusBadge = (st) => ({
  draft: ['badge amber', '草稿'], locked: ['badge violet', '已锁定'], checked_in: ['badge green', '已清点'],
}[st] || ['badge', st]);
const batStatusBadge = (b) => b.status === 'isolated'
  ? '<span class="badge red">已隔离</span>'
  : b.status === 'retired' ? '<span class="badge gray">报废</span>'
  : '<span class="badge green">在用</span>';
const slotStateBadge = (st) => ({
  empty: ['badge gray', '空槽'], charging: ['badge cyan', '充电中'], ready: ['badge green', '已充满'],
  charge_failed: ['badge red', '充电失败'], contact_fault: ['badge red', '接触不良'],
}[st] || ['badge', st]);
const micStatusBadge = (st) => ({
  ok: '<span class="badge green">正常</span>', fault: '<span class="badge red">故障/错频</span>',
  isolated: '<span class="badge red">隔离</span>', retired: '<span class="badge gray">退役</span>',
}[st] || st);
const packStatusBadge = (st) => st === 'ok'
  ? '<span class="badge green">正常</span>'
  : '<span class="badge red">' + ({ fault: '故障', isolated: '隔离' }[st] || st) + '</span>';

function fmtDT(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dateKey(s) { return (s || '').slice(0, 10); }
function chargeClass(pct) { return pct <= 20 ? 'low' : pct < 60 ? 'mid' : pct >= 95 ? 'full' : ''; }
function healthClass(h) { return h < 80 ? 'bad' : h < 90 ? 'warn' : 'ok'; }
function devName(kind, id) {
  const list = kind === 'mic' ? state.microphones : kind === 'pack' ? state.beltpacks : state.batteries;
  return (list.find(x => x.id === id) || {}).code || `${kind}#${id}`;
}

// ---------- 视图：场次日历 ----------
function renderCalendar() {
  $('#todayLabel').textContent = '2026-09-29';
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $('#calTitle').textContent = `${y} 年 ${m + 1} 月`;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - (first.getDay() || 7) + 1); // 周一起
  const grid = $('#calGrid');
  grid.innerHTML = '';
  ['一', '二', '三', '四', '五', '六', '日'].forEach(d =>
    grid.appendChild(el('div', { class: 'cal-dow' }, d)));
  const byDate = {};
  for (const s of state.shows) (byDate[dateKey(s.start_at)] ??= []).push(s);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const inMonth = d.getMonth() === m;
    const cell = el('div', { class: 'cal-cell' + (inMonth ? '' : ' dim') + (key === '2026-09-29' ? ' today' : '') });
    cell.appendChild(el('div', { class: 'cal-date' }, String(d.getDate())));
    for (const s of byDate[key] || []) {
      const [cls, label] = s.status === 'live' ? ['live', '● 演出中']
        : s.status === 'closed' ? ['closed', '✓ 已结清'] : ['', ''];
      cell.appendChild(el('div', { class: 'cal-event ' + cls, title: `${s.venue} ${s.start_at.slice(11)}` },
        `${s.start_at.slice(11)} ${s.name.length > 10 ? s.name.slice(0, 10) + '…' : s.name}${label ? ' ' + label : ''}`));
    }
    grid.appendChild(cell);
  }

  $('#showList').innerHTML = '<table class="table"><tr><th>演出</th><th>场馆</th><th>时间</th><th>状态</th><th>领用单</th><th></th></tr>' +
    state.shows.map(s => {
      const cls = state.checklists.filter(c => c.show_id === s.id);
      const [bc, bl] = showStatusBadge(s.status);
      return `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.venue)}</td>
      <td class="mono">${fmtDT(s.start_at)} – ${s.end_at.slice(11)}</td>
      <td><span class="${bc}">${bl}</span></td>
      <td>${cls.map(c => `<span class="badge gray">${esc(c.role_name)} · ${({ draft: '草稿', locked: '已锁定', checked_in: '已清点' })[c.status]}</span>`).join(' ') || '<span class="muted">无</span>'}</td>
      <td>${s.status === 'scheduled' ? `<button class="btn ghost sm" data-act="goto-checklists">去发料</button>` : ''}
          ${s.status === 'live' ? `<button class="btn ghost sm" data-act="goto-returns" data-cl="${cls[0]?.id || ''}">去归还</button>` : ''}</td></tr>`;
    }).join('') + '</table>';
}

// ---------- 视图：设备套装 ----------
function renderKits() {
  const wrap = $('#kitsByShow');
  wrap.innerHTML = '';
  for (const s of state.shows) {
    const cls = state.checklists.filter(c => c.show_id === s.id);
    if (!cls.length && s.status === 'closed') continue;
    const [bc, bl] = showStatusBadge(s.status);
    const card = el('div', { class: 'card' },
      el('h3', {}, s.name, ' ', el('span', { class: 'meta' }, `${s.venue} · ${fmtDT(s.start_at)}`),
        el('span', { class: 'spacer' }), el('span', { class: bc }, bl)));
    const grid = el('div', { class: 'grid cols-3' });
    for (const c of cls) grid.appendChild(kitCard(c));
    if (!cls.length) grid.appendChild(el('p', { class: 'muted' }, '尚未创建领用单'));
    card.appendChild(grid);
    wrap.appendChild(card);
  }

  // 麦克风频率台账
  $('#micTable').innerHTML = '<table class="table"><tr><th>编号</th><th>型号</th><th>频段</th><th>频率</th><th>状态</th><th>操作</th></tr>' +
    state.microphones.map(m => {
      const heldBy = holdOf('mic', m.id);
      return `<tr><td class="mono"><strong>${m.code}</strong></td><td>${esc(m.model)}</td><td>${esc(m.band)}</td>
      <td class="mono">${m.freq_mhz ?? '—'} MHz</td><td>${micStatusBadge(m.status)}${heldBy ? `<span class="badge gray" title="被 ${esc(heldBy.role_name)} 套装占用">锁定中</span>` : ''}</td>
      <td class="pill-actions">
        <button class="btn ghost sm ${can('freq_change') ? '' : 'denied'}" data-act="mic-freq" data-id="${m.id}">改频</button>
        <button class="btn ghost sm ${can('freq_change') ? '' : 'denied'}" data-act="mic-flag" data-id="${m.id}">标记错频</button>
      </td></tr>`;
    }).join('') + '</table>';

  $('#packTable').innerHTML = '<table class="table"><tr><th>编号</th><th>型号</th><th>状态</th><th>备注</th></tr>' +
    state.beltpacks.map(p => `<tr><td class="mono"><strong>${p.code}</strong></td>
      <td>${esc(p.model)}</td><td>${packStatusBadge(p.status)}</td><td class="muted">${esc(p.note) || '—'}</td></tr>`).join('') + '</table>';
}

function holdOf(kind, id) {
  const h = state.holds.find(x => x.kind === kind && x.ref_id === id);
  return h ? state.checklists.find(c => c.id === h.checklist_id) : null;
}

function kitItemRow(it) {
  const b = it.kind === 'battery';
  const cls = it.returned ? 'returned' : '';
  const spare = it.is_spare ? '<span class="badge cyan">备用</span>' : '';
  const statusLine = it.kind === 'battery'
    ? `<span class="muted">${it.charge_pct}% · 健康 ${it.health_pct}% · ${devName('battery', it.ref_id)}</span>`
    : it.kind === 'mic' ? `<span class="muted mono">${it.freq_mhz ?? '—'} MHz</span>` : '<span class="muted">腰包发射机</span>';
  const ret = it.returned ? '<span class="badge green">已还</span>' : '';
  return `<div class="kit-device ${cls}">
    <span class="badge ${it.kind === 'mic' ? 'violet' : it.kind === 'pack' ? 'amber' : 'cyan'}">${KIND_LABEL[it.kind]}</span>
    <span class="code">${esc(it.dev_code)}</span>${spare}${ret}
    <span class="spacer"></span>${statusLine}
  </div>`;
}

function kitCard(c) {
  const [bc, bl] = clStatusBadge(c.status);
  const node = el('div', { class: 'card', style: 'margin:0;box-shadow:none;background:#FCFAF4' });
  const mics = c.items.filter(i => i.kind === 'mic');
  const packs = c.items.filter(i => i.kind === 'pack');
  const bats = c.items.filter(i => i.kind === 'battery');
  const part = (title, list) =>
    `<div style="margin-bottom:8px"><div class="muted" style="margin-bottom:3px">${title}（${list.length}）</div>${list.map(kitItemRow).join('') || '<span class="muted">未配置</span>'}</div>`;
  node.innerHTML = `<div class="row" style="margin-bottom:8px">
      <strong>${esc(c.role_name)}</strong><span class="${bc}">${bl}</span>
      <span class="spacer"></span>
      <span class="muted">${c.returned_count}/${c.item_count} 已还</span>
    </div>
    ${part('麦克风', mics)}${part('腰包', packs)}${part('电池（含备用）', bats)}`;

  if (c.status === 'draft') {
    const addBar = el('div', { class: 'row', style: 'margin-top:6px' });
    const sel = el('select');
    sel.innerHTML = '<option value="">添加设备…</option>' +
      ['mic', 'pack', 'battery'].map(k => {
        const list = k === 'mic' ? state.microphones : k === 'pack' ? state.beltpacks : state.batteries;
        const inKit = new Set(c.items.filter(i => i.kind === k).map(i => i.ref_id));
        return '<optgroup label="' + KIND_LABEL[k] + '">' + list
          .filter(d => !inKit.has(d.id) && !holdOf(k, d.id))
          .filter(d => k !== 'battery' || d.status === 'active')
          .filter(d => (k === 'battery') || d.status !== 'fault')
          .map(d => `<option value="${k}:${d.id}">${d.code}${k === 'battery' ? ` (${d.charge_pct}%)` : ''}</option>`).join('') + '</optgroup>';
      }).join('');
    const spareCb = el('input', { type: 'checkbox', title: '标记为备用设备' });
    const spareLabel = el('label', { class: 'muted', style: 'display:flex;gap:3px;align-items:center' }, spareCb, '备用');
    const addBtn = el('button', { class: 'btn cyan sm', onclick: async () => {
      const v = sel.value;
      if (!v) return toast('请先选择设备', 'err');
      const [kind, id] = v.split(':');
      try {
        await api(`/api/checklists/${c.id}/items`, { kind, ref_id: Number(id), is_spare: spareCb.checked });
        toast(`已加入套装：${devName(kind, Number(id))}`, 'ok'); refresh();
      } catch (e) { toast(e.message, 'err'); }
    } }, '加入');
    addBar.append(sel, spareLabel, addBtn);
    node.appendChild(addBar);
    node.appendChild(el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', {
        class: 'btn sm ' + (can('checklist_lock') ? 'cyan' : 'ghost denied'),
        title: can('checklist_lock') ? '' : '仅舞台主管/经理可锁定',
        onclick: async () => {
          if (!can('checklist_lock')) return toast('仅舞台主管或场馆经理可锁定套装', 'err');
          try { await api(`/api/checklists/${c.id}/lock`, { staff_id: currentStaffId });
            toast('套装已锁定，设备占用生效', 'ok'); refresh();
          } catch (e) {
            if (e.payload?.conflicts?.length) toast('锁定失败：' + e.payload.conflicts.map(x =>
              `${KIND_LABEL[x.kind]}#${x.ref_id} 被《${x.held_by?.show_name || ''}》${x.held_by?.role_name || ''} 占用`).join('；'), 'err');
            else toast(e.message, 'err');
          }
        }
      }, '🔒 锁定套装并发料'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn ghost sm', 'data-act': 'goto-returns', 'data-cl': c.id, onclick: () => { chosenReturnCl = c.id; localStorage.setItem('returnCl', c.id); switchView('returns'); } }, '归还页 →')
    ));
  }
  return node;
}

// ---------- 视图：充电柜 ----------
function renderCabinet() {
  const wrap = $('#cabinets');
  wrap.innerHTML = '';
  const cabs = {};
  for (const s of state.slots) (cabs[s.cabinet_id] ??= []).push(s);
  for (const cab of state.cabinets) {
    const slots = cabs[cab.id] || [];
    const card = el('div', { class: 'card' },
      el('h3', {}, cab.name, el('span', { class: 'meta' },
        `${slots.filter(s => s.battery_id).length}/${slots.length} 槽位在用`)));
    const grid = el('div', { class: 'slot-grid' });
    for (const s of slots) grid.appendChild(slotEl(s));
    card.appendChild(grid);
    wrap.appendChild(card);
  }

  $('#batteryTable').innerHTML = '<table class="table"><tr><th>编号</th><th>型号</th><th>循环</th><th>电量</th><th>健康度</th><th>状态/复核</th><th>操作</th></tr>' +
    state.batteries.map(b => {
      const inSlot = state.slots.find(s => s.battery_id === b.id);
      const review = { none: '', pending: '<span class="badge amber">复核待批</span>', approved: '<span class="badge green">已批准</span>', rejected: '<span class="badge red">已驳回</span>' }[b.review_status] || '';
      const acts = [];
      if (b.status === 'isolated' && b.review_status !== 'pending')
        acts.push(`<button class="btn ghost sm ${can('review_request') ? '' : 'denied'}" data-act="review-request" data-id="${b.id}">申请解除隔离</button>`);
      if (b.review_status === 'pending')
        acts.push(`<button class="btn cyan sm ${can('review_release') ? '' : 'denied'}" data-act="review" data-id="${b.id}" data-ok="1">复核通过</button>`,
                  `<button class="btn danger sm ${can('review_release') ? '' : 'denied'}" data-act="review" data-id="${b.id}" data-ok="0">驳回</button>`);
      return `<tr><td class="mono"><strong>${b.code}</strong></td><td>${esc(b.model)}</td><td class="mono">${b.cycles}</td>
      <td><div class="row"><div class="charge-bar ${chargeClass(b.charge_pct)}" style="width:90px"><i style="width:${b.charge_pct}%"></i></div><span class="mono">${b.charge_pct}%</span></div></td>
      <td><span class="health-pill ${healthClass(b.health_pct)}">${b.health_pct}%</span></td>
      <td>${batStatusBadge(b)} ${review} ${inSlot ? `<span class="badge gray">${inSlot.position}</span>` : ''}<div class="muted">${esc(b.isolated_reason)}</div></td>
      <td class="pill-actions">${acts.join(' ') || '<span class="muted">—</span>'}</td></tr>`;
    }).join('') + '</table>';
}

function slotEl(s) {
  const node = el('div', { class: `slot state-${s.state} ${s.battery_id ? '' : 'empty'}` });
  const [bc, bl] = slotStateBadge(s.state);
  let html = `<div class="pos"><span class="mono">${s.position}</span><span class="${bc}">${bl}</span><span class="spacer"></span><span class="muted mono">#${s.last_seq}</span></div>`;
  if (s.battery_id) {
    html += `<div class="bcode mono">⚡ ${esc(s.battery_code)}</div>
      <div class="charge-bar ${chargeClass(s.charge_pct)}"><i style="width:${s.charge_pct}%"></i></div>
      <div class="row muted"><span>电量 <b>${s.charge_pct}%</b></span><span class="spacer"></span>
        <span class="health-pill ${healthClass(s.health_pct)}">健康 ${s.health_pct}%</span></div>
      <div class="msg">${esc(s.message)}</div>`;
  } else {
    html += '<div class="muted" style="margin-top:14px">空槽</div>';
  }
  node.innerHTML = html;

  const actions = el('div', { class: 'pill-actions', style: 'margin-top:auto' });
  if (!s.battery_id) {
    const freeBats = state.batteries.filter(b => b.status === 'active' &&
      !state.slots.some(x => x.battery_id === b.id) &&
      !state.holds.some(h => h.kind === 'battery' && h.ref_id === b.id));
    const sel = el('select', { style: 'flex:1;min-width:90px' });
    sel.innerHTML = '<option value="">选电池</option>' +
      freeBats.map(b => `<option value="${b.id}">${b.code} (${b.charge_pct}%)</option>`).join('');
    const btn = el('button', { class: 'btn cyan sm', onclick: async () => {
      if (!can('charge_op')) return toast('仅设备技术员可操作充电柜', 'err');
      if (!sel.value) return;
      try { await api(`/api/slots/${s.id}/dock`, { staff_id: currentStaffId, battery_id: Number(sel.value) });
        toast(`已放入 ${sel.options[sel.selectedIndex].text}`, 'ok'); refresh();
      } catch (e) { toast(e.message, 'err'); }
    } }, '放入');
    actions.append(sel, btn);
  } else {
    actions.appendChild(el('button', { class: 'btn ghost sm', onclick: async () => {
      if (!can('charge_op')) return toast('仅设备技术员可操作充电柜', 'err');
      try { await api(`/api/slots/${s.id}/undock`, { staff_id: currentStaffId });
        toast(`${s.battery_code} 已取下`, 'ok'); refresh();
      } catch (e) { toast(e.message, 'err'); }
    } }, '取下'));
    // 演示用：模拟硬件回执
    const sim = el('select');
    sim.innerHTML = '<option value="">模拟回执…</option><option value="contact_fault">接触不良</option><option value="charge_failed">充电失败</option><option value="charging">继续充电</option><option value="ready">充满</option><option value="ooo">乱序两帧</option>';
    sim.addEventListener('change', async () => {
      const v = sim.value; if (!v) return;
      try {
        if (v === 'ooo') {
          const r = await api(`/api/slots/${s.id}/receipt-ooo`, {
            later: { result: 'charging', charge_pct: 88, health_pct: s.health_pct },
            earlier: { result: 'charging', charge_pct: 40, health_pct: s.health_pct },
          });
          toast(`乱序测试：新帧 applied=${r.applied_newer.applied}，旧帧 applied=${r.applied_older.applied}（已丢弃，电量不回退）`, 'ok');
        } else {
          const payload = { result: v, seq: s.last_seq + 1, battery_id: s.battery_id };
          if (v === 'charging') payload.charge_pct = Math.min(100, s.charge_pct + 15);
          if (v === 'ready') payload.charge_pct = 100;
          if (v === 'charging' || v === 'ready') payload.health_pct = s.health_pct;
          await api(`/api/slots/${s.id}/receipt`, payload);
          toast('回执已处理：' + slotStateBadge(v)[1], 'ok');
        }
        refresh();
      } catch (e) { toast(e.message, 'err'); }
      sim.value = '';
    });
    actions.appendChild(sim);
  }
  node.appendChild(actions);
  return node;
}

// ---------- 视图：领用清单 ----------
function renderChecklists() {
  const cls = state.checklists;
  $('#clStats').innerHTML = [
    ['草稿', cls.filter(c => c.status === 'draft').length, 'amber'],
    ['已锁定/在用', cls.filter(c => c.status === 'locked').length, 'cyan'],
    ['已清点', cls.filter(c => c.status === 'checked_in').length, 'green'],
    ['未归还设备', state.faults.filter(f => f.type === 'missing_return' || f.type === 'lost').length, 'red'],
  ].map(([l, n, c]) => `<div class="stat"><div class="n ${c}">${n}</div><div class="l">${l}</div></div>`).join('');

  $('#newClShow').innerHTML = state.shows.filter(s => s.status !== 'closed')
    .map(s => `<option value="${s.id}">${s.start_at.slice(5, 16)} 《${esc(s.name)}》</option>`).join('');

  $('#clList').innerHTML = '';
  for (const s of state.shows) {
    const list = cls.filter(c => c.show_id === s.id);
    if (!list.length) continue;
    const card = el('div', { class: 'card' }, el('h3', {}, s.name, el('span', { class: 'meta' }, fmtDT(s.start_at))));
    card.innerHTML += '<table class="table"><tr><th>角色/岗位</th><th>状态</th><th>麦克风</th><th>腰包</th><th>电池</th><th>归还</th><th>操作</th></tr>' +
      list.map(c => {
        const [bc, bl] = clStatusBadge(c.status);
        const cnt = k => c.items.filter(i => i.kind === k).length;
        return `<tr><td><strong>${esc(c.role_name)}</strong></td><td><span class="${bc}">${bl}</span></td>
        <td>${cnt('mic')}</td><td>${cnt('pack')}</td><td>${cnt('battery')}</td>
        <td>${c.returned_count}/${c.item_count}</td>
        <td><button class="btn ghost sm" data-act="goto-returns" data-cl="${c.id}">归还检测</button></td></tr>`;
      }).join('') + '</table>';
    $('#clList').appendChild(card);
  }
}

// ---------- 视图：归还检测 ----------
function renderReturns() {
  const sel = $('#returnClSelect');
  const options = state.checklists
    .filter(c => c.status !== 'draft')
    .map(c => `<option value="${c.id}" ${c.id === chosenReturnCl ? 'selected' : ''}>
      [${{ locked: '已锁定', checked_in: '已清点' }[c.status]}] 《${esc(c.show_name)}》— ${esc(c.role_name)}</option>`).join('');
  sel.innerHTML = options || '<option value="">暂无可检测的领用单</option>';
  if (!chosenReturnCl || !state.checklists.find(c => c.id === chosenReturnCl && c.status !== 'draft')) {
    chosenReturnCl = Number(sel.value) || 0;
  }
  const c = state.checklists.find(x => x.id === chosenReturnCl);
  const box = $('#returnDetail');
  box.innerHTML = '';
  if (!c) { box.appendChild(el('p', { class: 'muted' }, '请选择一张已锁定的领用单。')); }
  else box.appendChild(returnDetailCard(c));

  const lates = state.lateScans;
  $('#lateCard').style.display = lates.length ? 'block' : 'none';
  $('#lateScans').innerHTML = lates.length ? '<table class="table"><tr><th>场次</th><th>领用单</th><th>设备</th><th>回传时间</th><th>说明</th></tr>' +
    lates.map(r => `<tr><td>${esc(r.show_name)}</td><td>${esc(r.role_name)}</td>
      <td class="mono">${KIND_LABEL[r.kind]} ${devName(r.kind, r.ref_id)}</td>
      <td class="mono">${fmtDT(r.scanned_at)}</td><td class="muted">${esc(r.note)}</td></tr>`).join('') + '</table>' : '';
}

function returnCol(c, kind) {
  const list = c.items.filter(i => i.kind === kind);
  const head = el('div', { class: 'return-col' },
    el('header', {}, KIND_LABEL[kind],
      el('span', { class: 'count' }, `${list.filter(i => i.returned).length}/${list.length}`)));
  for (const it of list) {
    const got = it.returned;
    const row = el('div', { class: 'item ' + (got ? 'got' : 'lack') });
    const extras = it.kind === 'battery'
      ? `<span class="muted mono">出场 ${it.charge_pct}% · 健康 ${it.health_pct}%${it.is_spare ? ' · 备用' : ''}</span>`
      : it.kind === 'mic' ? `<span class="muted mono">${it.freq_mhz ?? '—'} MHz${it.is_spare ? ' · 备用' : ''}</span>`
        : `<span class="muted">${it.is_spare ? '备用腰包' : '腰包发射机'}</span>`;
    row.innerHTML = `<div class="row"><strong class="mono">${esc(it.dev_code)}</strong>
      <span class="spacer"></span><span class="st">${got ? '✓ 已归还 ' + fmtDT(it.returned_at) : '✗ 缺件'}</span></div>${extras}`;
    if (!got && c.status === 'locked') {
      row.appendChild(el('div', { style: 'margin-top:5px' },
        el('button', { class: 'btn cyan sm ' + (can('return_scan') ? '' : 'denied'), onclick: async () => {
          if (!can('return_scan')) return toast('仅设备技术员/舞台主管可扫码', 'err');
          try { await api(`/api/checklists/${c.id}/scan`, { staff_id: currentStaffId, kind, ref_id: it.ref_id });
            toast(`${it.dev_code} 归还扫码成功`, 'ok'); refresh();
          } catch (e) { toast(e.message, 'err'); }
        } }, '📷 扫码归还')));
    }
    head.appendChild(row);
  }
  if (!list.length) head.appendChild(el('div', { class: 'item muted' }, '该套装无此类设备'));
  return head;
}

function returnDetailCard(c) {
  const card = el('div', { class: 'card' });
  const [bc, bl] = clStatusBadge(c.status);
  const missing = c.items.filter(i => !i.returned);
  card.appendChild(el('h3', {}, `《${c.show_name}》 ${c.role_name}`,
    el('span', { class: 'meta' }, `锁定于 ${fmtDT(c.locked_at)}`),
    el('span', { class: 'spacer' }), el('span', { class: bc }, bl)));

  if (c.status === 'checked_in') {
    card.appendChild(el('p', { class: 'muted' }, '本场已完成清点，结果已定案；此后到达的回传只挂起到"迟到回传"，不覆盖本页结果。'));
    card.appendChild(el('p', {}, el('span', { class: 'badge ' + (c.settle_note.includes('缺件') ? 'red' : 'green') }, esc(c.settle_note))));
  }

  const cols = el('div', { class: 'return-cols' },
    returnCol(c, 'mic'), returnCol(c, 'battery'), returnCol(c, 'pack'));
  card.appendChild(cols);

  if (c.status === 'locked') {
    const bar = el('div', { class: 'card', style: 'margin-top:14px;background:#FCFAF4;box-shadow:none' });
    if (missing.length) {
      bar.appendChild(el('p', { style: 'margin:4px 0 8px;color:var(--red);font-weight:700' },
        `检测到 ${missing.length} 件缺件：必须逐条登记例外（按丢失处理）后，舞台主管才能完成清点`));
      for (const m of missing) {
        const inp = el('input', { placeholder: `缺件说明：${m.dev_code}（必填）`, style: 'flex:1;min-width:240px', 'data-ex': `${m.kind}:${m.ref_id}` });
        bar.appendChild(el('div', { class: 'row', style: 'margin-bottom:6px' },
          el('span', { class: 'badge red' }, KIND_LABEL[m.kind]), el('strong', { class: 'mono' }, m.dev_code), inp));
      }
    } else {
      bar.appendChild(el('p', { class: 'green-soft', style: 'margin:4px 0 8px;color:var(--green);font-weight:700' }, '三件类齐套，可以完成清点。'));
    }
    bar.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn ' + (can('settle') ? 'cyan' : 'ghost denied'), onclick: async () => {
        if (!can('settle')) return toast('仅舞台主管可完成清点结算', 'err');
        const exceptions = $$('input[data-ex]', bar).map(i => {
          const [kind, ref_id] = i.dataset.ex.split(':');
          return { kind, ref_id: Number(ref_id), reason: i.value.trim() };
        }).filter(e => e.reason);
        if (missing.length && exceptions.length !== missing.length) {
          return toast(`还有缺件未填写说明（${missing.length - exceptions.length} 件），结算将被拦截`, 'err');
        }
        try {
          const r = await api(`/api/checklists/${c.id}/settle`, { staff_id: currentStaffId, exceptions });
          toast(r.lost ? `清点完成：归还 ${r.returned} 件，登记丢失 ${r.lost} 件` : '齐套清点完成', 'ok');
          refresh();
        } catch (e) {
          if (e.code === 'missing_items' || e.payload?.code === 'missing_items') toast('结算被拦截：存在未登记例外的缺件', 'err');
          else toast(e.message, 'err');
        }
      } }, '✓ 完成清点结算'),
      el('span', { class: 'muted' }, can('settle') ? '缺件未登记例外时系统将拒绝结算' : '当前岗位无权结算')));
    card.appendChild(bar);
  }
  return card;
}

// ---------- 视图：故障队列 ----------
const FAULT_META = {
  low_battery: { icon: '🔋', label: '低电量', cls: 'warn' },
  charge_failed: { icon: '⚡', label: '充电失败', cls: 'warn' },
  contact_fault: { icon: '🔌', label: '接触不良', cls: 'warn' },
  lost: { icon: '❓', label: '丢失', cls: 'block' },
  missing_return: { icon: '📋', label: '归还漏件', cls: 'block' },
  wrong_freq: { icon: '📡', label: '错频/撞频', cls: 'block' },
  health: { icon: '🩺', label: '健康隔离', cls: 'block' },
  late_return: { icon: '🕒', label: '迟到回传', cls: 'info' },
  preflight: { icon: '⏰', label: '开演提醒', cls: 'info' },
};
function renderFaults() {
  const fs = state.faults;
  const count = t => fs.filter(f => f.type === t).length;
  $('#faultStats').innerHTML = [
    ['待处理故障', fs.length, 'red', ''],
    ['低电量', count('low_battery'), 'amber', ''],
    ['充电/接触', count('charge_failed') + count('contact_fault'), 'amber', ''],
    ['错频', count('wrong_freq'), 'red', ''],
    ['丢失/漏件', count('lost') + count('missing_return'), 'red', ''],
    ['隔离待复核', count('health'), 'red', ''],
  ].map(([l, n, c]) => `<div class="stat"><div class="n ${n ? c : ''}">${n}</div><div class="l">${l}</div></div>`).join('');

  $('#faultPill').style.display = fs.length ? 'inline-flex' : 'none';
  $('#faultPill').textContent = fs.length;

  $('#faultList').innerHTML = '';
  if (!fs.length) $('#faultList').appendChild(el('div', { class: 'card muted' }, '队列已清空，没有待处理故障。'));
  for (const f of fs) {
    const meta = FAULT_META[f.type] || { icon: '•', label: f.type, cls: 'warn' };
    const isHealth = f.type === 'health';
    const b = isHealth ? state.batteries.find(x => x.id === f.ref_id) : null;
    const node = el('div', { class: `fault ${meta.cls}` },
      el('div', { class: 'ficon' }, meta.icon),
      el('div', { class: 'fbody' },
        el('div', { class: 'row' },
          el('strong', {}, meta.label + (f.status === 'pending_review' ? ' · 复核中' : '')),
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted mono' }, fmtDT(f.reported_at))),
        el('div', { class: 'fdetail' }, f.detail),
        el('div', { class: 'fmeta' }, f.ref_kind ? `${KIND_LABEL[f.ref_kind] || f.ref_kind} ${b ? b.code : (f.ref_id ?? '')}` : '')));
    const acts = el('div', { class: 'pill-actions' });
    if (isHealth && b) {
      if (b.review_status === 'pending') {
        acts.appendChild(el('span', { class: 'badge amber' }, '设备员已申请，待经理复核'));
        acts.appendChild(el('button', { class: 'btn cyan sm ' + (can('review_release') ? '' : 'denied'),
          onclick: () => reviewAct(b.id, true) }, '经理：批准解除'));
        acts.appendChild(el('button', { class: 'btn danger sm ' + (can('review_release') ? '' : 'denied'),
          onclick: () => reviewAct(b.id, false) }, '经理：驳回'));
      } else {
        acts.appendChild(el('button', { class: 'btn ghost sm ' + (can('review_request') ? '' : 'denied'),
          onclick: () => reviewRequestAct(b.id) }, '设备员：申请解除隔离'));
      }
    } else {
      acts.appendChild(el('button', { class: 'btn ghost sm ' + (can('fault_close') ? '' : 'denied'),
        onclick: async () => {
          if (!can('fault_close')) return toast('仅舞台主管/经理可关闭故障', 'err');
          const resolution = prompt('处理记录（可留空）') ?? '';
          try { await api(`/api/faults/${f.id}/close`, { staff_id: currentStaffId, resolution });
            toast('故障已关闭', 'ok'); refresh();
          } catch (e) { toast(e.message, 'err'); }
        } }, '处理并关闭'));
    }
    node.appendChild(acts);
    $('#faultList').appendChild(node);
  }

  $('#auditList').innerHTML = '<table class="table"><tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr>' +
    state.audit.map(a => `<tr><td class="mono">${fmtDT(a.ts)}</td><td>${esc(a.actor_name || '系统')}</td>
      <td class="mono">${esc(a.action)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('') + '</table>';
}

async function reviewAct(batId, ok) {
  if (!can('review_release')) return toast('仅场馆经理可复核隔离解除', 'err');
  const comment = prompt(ok ? '复核意见（批准解除）' : '驳回原因', ok ? '复测健康度达标，准予解除' : '继续观察') ?? '';
  try {
    await api(`/api/batteries/${batId}/review`, { staff_id: currentStaffId, approved: ok, comment });
    toast(ok ? '已批准解除隔离' : '已驳回解除申请', ok ? 'ok' : 'err'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}
async function reviewRequestAct(batId) {
  if (!can('review_request')) return toast('仅设备技术员可发起解除申请', 'err');
  try { await api(`/api/batteries/${batId}/review-request`, { staff_id: currentStaffId });
    toast('已提交，等待场馆经理复核', 'ok'); refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- 渲染调度 ----------
function renderAll() {
  if (!state) return;
  renderCalendar(); renderKits(); renderCabinet(); renderChecklists(); renderReturns(); renderFaults();
  const a = actor();
  $('#roleTag').textContent = a ? ROLE_LABEL[a.role] : '';
}
async function refresh() {
  try {
    const data = await api('/api/state', null, 'GET');
    state = data.state;
    if (!currentStaffId || !state.staff.some(s => s.id === currentStaffId)) {
      currentStaffId = state.staff[0]?.id || 0;
      localStorage.setItem('staffId', currentStaffId);
    }
    renderAll();
  } catch (e) { console.error(e); }
}

function switchView(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}

// ---------- 事件绑定 ----------
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) switchView(b.dataset.view);
});
$('#roleSelect').addEventListener('change', e => {
  currentStaffId = Number(e.target.value);
  localStorage.setItem('staffId', currentStaffId);
  renderAll();
});
$('#calPrev').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); };
$('#calNext').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); };
$('#returnClSelect').addEventListener('change', e => {
  chosenReturnCl = Number(e.target.value);
  localStorage.setItem('returnCl', chosenReturnCl);
  renderReturns();
});
$('#newClBtn').onclick = async () => {
  const role_name = $('#newClRole').value.trim();
  const show_id = Number($('#newClShow').value);
  if (!role_name) return toast('请填写角色/岗位', 'err');
  try {
    const r = await api('/api/checklists', { show_id, role_name, assignee_id: currentStaffId });
    $('#newClRole').value = '';
    toast('草稿已创建，请到设备套装页配置并锁定', 'ok');
    switchView('kits'); refresh();
  } catch (e) { toast(e.message, 'err'); }
};

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'goto-returns') {
    if (btn.dataset.cl) { chosenReturnCl = Number(btn.dataset.cl); localStorage.setItem('returnCl', chosenReturnCl); }
    switchView('returns'); renderReturns();
  }
  if (act === 'goto-checklists') switchView('checklists');
  if (act === 'mic-freq') {
    if (!can('freq_change')) return toast('仅调音师可改频', 'err');
    const v = prompt('新频率 (MHz)', '530.000');
    if (v == null) return;
    try { const r = await api(`/api/mics/${btn.dataset.id}/freq`, { staff_id: currentStaffId, freq_mhz: Number(v) });
      toast(r.clash ? '已改频，但与其他麦克风撞频，已标记错频故障！' : '频率已更新', r.clash ? 'err' : 'ok'); refresh();
    } catch (e2) { toast(e2.message, 'err'); }
  }
  if (act === 'mic-flag') {
    if (!can('freq_change')) return toast('仅调音师可标记错频', 'err');
    const detail = prompt('错频现象描述', '现场听到串音/载波冲突') || '';
    try { await api(`/api/mics/${btn.dataset.id}/flag-freq`, { staff_id: currentStaffId, detail });
      toast('已进入故障队列', 'ok'); refresh(); } catch (e2) { toast(e2.message, 'err'); }
  }
  if (act === 'review-request') return reviewRequestAct(Number(btn.dataset.id));
  if (act === 'review') return reviewAct(Number(btn.dataset.id), btn.dataset.ok === '1');
});

// 初始化：先拿一次 state 以填充岗位选择
(async function init() {
  await refresh();
  $('#roleSelect').innerHTML = state.staff.map(s =>
    `<option value="${s.id}" ${s.id === currentStaffId ? 'selected' : ''}>${s.name} · ${ROLE_LABEL[s.role]}</option>`).join('');
  refresh();
  setInterval(refresh, 5000);
})();
