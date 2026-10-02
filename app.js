'use strict';
/*
 * 請求書
 *  - データは端末の localStorage にだけ保存する。外部への送信はしない。
 *  - 保存のたびに直前の内容を .prev に残し、1日1回の控えを3日分持つ。
 */

const APP_VER = '1.1.4';
const KEY = 'seikyu.data';
const KEY_PREV = 'seikyu.data.prev';
const KEY_DAILY = 'seikyu.daily';
const KEY_VER = 'seikyu.ver';
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/* ---------- 小物 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => {
  const s = String(v ?? '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，円¥\s]/g, '');
  const n = Number(s);
  return isFinite(n) ? n : 0;
};
const yen = n => Math.round(n).toLocaleString('ja-JP');
const qtyStr = q => (Math.round(q * 100) / 100).toLocaleString('ja-JP');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const jpDate = s => { if (!s) return ''; const d = toDate(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const slash = s => { const d = toDate(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const md = s => { const d = toDate(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const endOfMonth = (y, m) => new Date(y, m + 1, 0); // m は0始まり
const clone = o => JSON.parse(JSON.stringify(o));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- データ ---------- */
function blank() {
  return {
    v: 1,
    issuer: {
      name: '', rep: '', zip: '', addr1: '', addr2: '', tel: '', email: '', regno: '',
      bank: '', branch: '', acctType: '普通', acctNo: '', holder: '',
      rounding: 'floor', withholding: false, seal: '',
      note: '恐れ入りますが、振込手数料は貴社にてご負担くださいますようお願いいたします。'
    },
    clients: [],
    items: [],
    entries: {},   // entries[請求先ID][YYYY-MM-DD] = [{i, n, s, p, u, r, q}]
    history: [],
    cur: '',
    lastBackup: 0,
    savedAt: 0
  };
}

function normalize(d) {
  const b = blank();
  if (!d || typeof d !== 'object') return b;
  const out = Object.assign(b, d);
  out.issuer = Object.assign(blank().issuer, d.issuer || {});
  if (!Array.isArray(out.clients)) out.clients = [];
  if (!Array.isArray(out.items)) out.items = [];
  if (!Array.isArray(out.history)) out.history = [];
  if (!out.entries || typeof out.entries !== 'object') out.entries = {};
  out.clients.forEach(c => {
    if (!c.taxMode) c.taxMode = 'incl';
    if (!Array.isArray(c.deduct)) c.deduct = [];
  });
  return out;
}

function load() {
  for (const k of [KEY, KEY_PREV]) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* 次を試す */ }
  }
  return blank();
}

let data = load();

function save() {
  data.savedAt = Date.now();
  let json, before;
  try {
    json = JSON.stringify(data);
    before = localStorage.getItem(KEY);
    if (before && before !== json) {
      try { localStorage.setItem(KEY_PREV, before); } catch (_) { localStorage.removeItem(KEY_PREV); }
    }
    localStorage.setItem(KEY, json);
  } catch (e) {
    alert('保存に失敗しました。端末の空き容量を確認してください。\n（印影の画像が大きい場合は外すと直ることがあります）');
    return;
  }
  dailyCopy(before || json);
}

// 1日1回、その日最初の保存時に控えを取る。3日分。
function dailyCopy(json) {
  try {
    const today = ymd(new Date());
    const list = JSON.parse(localStorage.getItem(KEY_DAILY) || '[]');
    if (list.length && list[0].day === today) return;
    list.unshift({ day: today, json });
    localStorage.setItem(KEY_DAILY, JSON.stringify(list.slice(0, 3)));
  } catch (e) {
    try { localStorage.removeItem(KEY_DAILY); } catch (_) {}
  }
}

// ブラウザに「消さないで」と頼んでおく（対応端末のみ）
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/* ---------- 参照 ---------- */
const clientById = id => data.clients.find(c => c.id === id);
const itemById = id => data.items.find(i => i.id === id);
const curClient = () => clientById(data.cur) || data.clients[0] || null;
const itemsFor = cid => data.items.filter(i => !i.client || i.client === cid);
const entriesOf = cid => (data.entries[cid] ||= {});
const dayTotal = list => list.reduce((s, e) => s + Math.round(e.q * e.p), 0);

/* =========================================================
   レイヤー（パネル／シート）と戻るボタン
   ========================================================= */
const layer = $('#layer');
const stack = [];
history.replaceState({ depth: 0 }, '');

function pushLayer(el, opts = {}) {
  layer.appendChild(el);
  stack.push(Object.assign({ el }, opts));
  history.pushState({ depth: stack.length }, '');
}
function closeTop(n = 1) { if (stack.length) history.go(-Math.min(n, stack.length)); }

window.addEventListener('popstate', e => {
  const depth = (e.state && e.state.depth) || 0;
  let popped = false;
  while (stack.length > depth) {
    const top = stack.pop();
    top.el.remove();
    if (top.onClose) top.onClose();
    popped = true;
  }
  if (popped) {
    const next = stack[stack.length - 1];
    if (next && next.refresh) next.refresh();
    renderMain();
  }
});

function openPanel(title, build, opts = {}) {
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-inner">
      <div class="head"><h2></h2><button class="back" type="button">閉じる</button></div>
      <div class="body"></div>
      <div class="foot" hidden></div>
    </div>`;
  const api = {
    el,
    body: $('.body', el),
    foot: $('.foot', el),
    setTitle: t => { $('h2', el).textContent = t; },
    refresh: () => build(api)
  };
  api.setTitle(title);
  $('.back', el).onclick = () => closeTop();
  pushLayer(el, { refresh: opts.noRefresh ? null : api.refresh, onClose: opts.onClose });
  build(api);
  return api;
}

function openSheet(title, build, opts = {}) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="shade"></div>
    <div class="sheet">
      <div class="head"><h2></h2><button class="back" type="button">閉じる</button></div>
      <div class="body"></div>
      <div class="foot" hidden></div>
    </div>`;
  const api = {
    el,
    body: $('.body', el),
    foot: $('.foot', el),
    setTitle: t => { $('h2', el).textContent = t; },
    refresh: () => build(api)
  };
  api.setTitle(title);
  $('.shade', el).onclick = () => closeTop();
  $('.back', el).onclick = () => closeTop();
  pushLayer(el, { refresh: api.refresh, onClose: opts.onClose });
  build(api);
  return api;
}

/* =========================================================
   フォーム
   ========================================================= */
function fieldHTML(f, o) {
  if (f.legend) return `<fieldset><legend>${esc(f.legend)}</legend></fieldset>`;
  if (f.cols) return `<div class="cols">${f.cols.map(c => fieldHTML(c, o)).join('')}</div>`;
  if (f.html) return f.html;
  const v = o[f.k] ?? '';
  const id = 'f_' + f.k;
  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : '';
  const ph = f.ph ? ` placeholder="${esc(f.ph)}"` : '';
  let input;
  switch (f.t) {
    case 'select':
      input = `<select id="${id}" name="${f.k}">${f.opts.map(([val, lab]) =>
        `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
      break;
    case 'textarea':
      input = `<textarea id="${id}" name="${f.k}"${ph}>${esc(v)}</textarea>`;
      break;
    case 'check':
      return `<div class="field"><label class="check"><input type="checkbox" name="${f.k}"${v ? ' checked' : ''}> ${esc(f.l)}</label>${hint}</div>`;
    case 'num':
      input = `<input type="text" inputmode="decimal" id="${id}" name="${f.k}" value="${esc(v)}"${ph}>`;
      break;
    case 'date':
      input = `<input type="date" id="${id}" name="${f.k}" value="${esc(v)}">`;
      break;
    default:
      input = `<input type="${f.t || 'text'}" id="${id}" name="${f.k}" value="${esc(v)}"${ph}${f.im ? ` inputmode="${f.im}"` : ''}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.l)}</label>${input}${hint}</div>`;
}
const formHTML = (fields, o) => fields.map(f => fieldHTML(f, o)).join('');

function readForm(root, fields, into = {}) {
  const flat = [];
  const walk = fs => fs.forEach(f => { if (f.cols) walk(f.cols); else if (f.k) flat.push(f); });
  walk(fields);
  flat.forEach(f => {
    const el = root.querySelector(`[name="${f.k}"]`);
    if (!el) return;
    if (f.t === 'check') into[f.k] = el.checked;
    else if (f.t === 'num') into[f.k] = num(el.value);
    else into[f.k] = el.value.trim();
  });
  return into;
}

/* =========================================================
   トップ（カレンダー）
   ========================================================= */
const today = new Date();
let viewY = today.getFullYear();
let viewM = today.getMonth();

function renderMain() {
  const c = curClient();
  if (c && data.cur !== c.id) data.cur = c.id;
  $('#clientName').textContent = c ? c.name + (c.honor ? ' ' + c.honor : '') : '請求先を登録してください';
  $('#monthLabel').textContent = `${viewY}年 ${viewM + 1}月`;

  const first = new Date(viewY, viewM, 1);
  const start = new Date(viewY, viewM, 1 - first.getDay());
  const last = endOfMonth(viewY, viewM);
  const cells = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
  const todayS = ymd(new Date());
  const ent = c ? entriesOf(c.id) : {};

  let html = '';
  let sum = 0, days = 0;
  for (let i = 0; i < cells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const s = ymd(d);
    const out = d.getMonth() !== viewM;
    const list = ent[s] || [];
    if (!out && list.length) { sum += dayTotal(list); days++; }
    const cls = ['day'];
    if (out) cls.push('out');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    if (s === todayS) cls.push('today');
    let tags = '';
    list.slice(0, 3).forEach(e => {
      const it = itemById(e.i);
      const label = (it && (it.short || it.name)) || e.s || e.n;
      const qn = e.q !== 1 ? '×' + qtyStr(e.q) : '';
      tags += `<span class="tag${it && it.fill ? ' fill' : ''}">${esc(label)}${qn}</span>`;
    });
    if (list.length > 3) tags += `<span class="more">他${list.length - 3}</span>`;
    html += `<button type="button" class="${cls.join(' ')}" data-d="${s}"><span class="d">${d.getDate()}</span>${tags}</button>`;
  }
  $('#cal').innerHTML = html;
  $('#monthSum').textContent = yen(sum) + '円';
  const tm = c ? c.taxMode : '';
  $('#monthDays').textContent = (days ? `${days}日分` : '') + (tm === 'excl' ? '（税抜）' : tm === 'incl' ? '（税込）' : '');
}

function moveMonth(n) {
  const d = new Date(viewY, viewM + n, 1);
  viewY = d.getFullYear();
  viewM = d.getMonth();
  renderMain();
}

$('#prevM').onclick = () => moveMonth(-1);
$('#nextM').onclick = () => moveMonth(1);
$('#monthLabel').onclick = () => { viewY = today.getFullYear(); viewM = today.getMonth(); renderMain(); };
$('#cal').onclick = e => {
  const b = e.target.closest('.day');
  if (!b) return;
  askPersist();
  const s = b.dataset.d;
  const d = toDate(s);
  if (d.getMonth() !== viewM) { viewY = d.getFullYear(); viewM = d.getMonth(); renderMain(); }
  openDay(s);
};
$('#menuBtn').onclick = openMenu;
$('#clientBtn').onclick = openClientPicker;
$('#toInvoice').onclick = () => openInvoice();

// 横スワイプで月送り
(() => {
  let x0 = null, y0 = null;
  const cal = $('#cal');
  cal.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  cal.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) moveMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

/* ---------- 請求先の切り替え ---------- */
function openClientPicker() {
  openSheet('請求先を切り替え', api => {
    const cur = curClient();
    if (!data.clients.length) {
      api.body.innerHTML = `<p class="empty">まだ請求先がありません。</p>
        <button class="btn dark wide" data-act="add" type="button">請求先を登録する</button>`;
    } else {
      api.body.innerHTML = `<ul class="menu">${data.clients.map(c =>
        `<li><button type="button" data-id="${c.id}"><span>${c.id === (cur && cur.id) ? '● ' : ''}${esc(c.name)}</span><small>${esc(c.honor || '')}</small></button></li>`).join('')}</ul>
        <p style="margin-top:14px"><button class="link" data-act="manage" type="button">請求先の登録・編集</button></p>`;
    }
    api.body.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.id) { data.cur = b.dataset.id; save(); closeTop(); return; }
      if (b.dataset.act === 'add') openClientEdit(null);
      if (b.dataset.act === 'manage') openClients();
    };
  });
}

/* =========================================================
   日付をタップしたとき
   ========================================================= */
function openDay(s) {
  const c = curClient();
  if (!c) {
    if (confirm('先に請求先を登録してください。今登録しますか？')) openClientEdit(null);
    return;
  }
  const d = toDate(s);
  const title = `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;

  openSheet(title, api => {
    const ent = entriesOf(c.id);
    const list = ent[s] || [];
    const items = itemsFor(c.id);

    if (!items.length) {
      api.body.innerHTML = `<p class="empty">「${esc(c.name)}」で使える項目がまだありません。<br>作業内容と単価を先に登録してください。</p>
        <button class="btn dark wide" data-act="additem" type="button">項目を登録する</button>`;
      api.foot.hidden = true;
      api.body.onclick = e => { if (e.target.closest('[data-act=additem]')) openItemEdit(null, c.id); };
      return;
    }

    // 項目一覧＋（削除済み項目のぶん）
    const rows = items.map(it => {
      const e = list.find(x => x.i === it.id);
      return { id: it.id, name: it.name, price: e ? e.p : it.price, unit: it.unit, q: e ? e.q : 0 };
    });
    list.filter(e => !items.some(it => it.id === e.i)).forEach(e => {
      rows.push({ id: e.i, name: e.n, price: e.p, unit: e.u, q: e.q, gone: true });
    });

    api.body.innerHTML = `<ul class="items">${rows.map(r => `
      <li class="${r.q ? 'on' : ''}" data-id="${r.id}">
        <div class="nm" data-act="toggle"><b>${esc(r.name)}</b><span>${yen(r.price)}円${c.taxMode === 'incl' ? '（税込）' : c.taxMode === 'excl' ? '（税抜）' : ''}${r.unit ? ' / ' + esc(r.unit) : ''}${r.gone ? '（削除した項目）' : ''}</span></div>
        <div class="step">
          <button type="button" data-act="minus" aria-label="減らす">−</button>
          <input type="text" inputmode="decimal" value="${r.q ? qtyStr(r.q) : 0}" aria-label="数量">
          <button type="button" data-act="plus" aria-label="増やす">＋</button>
        </div>
      </li>`).join('')}</ul>
      <p style="margin-top:14px">
        ${list.length ? '<button class="link" data-act="clear" type="button">この日の入力を消す</button>'
                      : '<button class="link" data-act="copy" type="button">前回の入力と同じにする</button>'}
      </p>`;

    api.foot.hidden = false;
    api.foot.innerHTML = `<div class="day-total"><span>この日の金額</span><b>${yen(dayTotal(list))}円</b></div>`;

    const setQ = (id, q) => {
      q = Math.max(0, Math.round(q * 100) / 100);
      let arr = (ent[s] || []).slice();
      const idx = arr.findIndex(x => x.i === id);
      if (q === 0) {
        if (idx >= 0) arr.splice(idx, 1);
      } else if (idx >= 0) {
        arr[idx] = Object.assign({}, arr[idx], { q });
      } else {
        const it = itemById(id);
        if (!it) return;
        arr.push({ i: it.id, n: it.name, s: it.short, p: it.price, u: it.unit, r: it.rate, q });
        // 項目の並び順にそろえる
        const order = id => { const k = data.items.findIndex(x => x.id === id); return k < 0 ? 999 : k; };
        arr.sort((a, b) => order(a.i) - order(b.i));
      }
      if (arr.length) ent[s] = arr; else delete ent[s];
      save();
      api.refresh();
      renderMain();
    };

    api.body.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const li = b.closest('li');
      const id = li && li.dataset.id;
      const cur = id ? ((ent[s] || []).find(x => x.i === id) || { q: 0 }).q : 0;
      switch (b.dataset.act) {
        case 'toggle': setQ(id, cur ? 0 : 1); break;
        case 'plus': setQ(id, Math.floor(cur) + 1); break;
        case 'minus': setQ(id, Math.ceil(cur) - 1); break;
        case 'clear':
          if (confirm('この日の入力を消しますか？')) { delete ent[s]; save(); api.refresh(); renderMain(); }
          break;
        case 'copy': {
          const prev = Object.keys(ent).filter(k => k < s && ent[k].length).sort().pop();
          if (!prev) { toast('前の入力がありません'); break; }
          ent[s] = clone(ent[prev]);
          save(); api.refresh(); renderMain();
          toast(`${md(prev)}と同じ内容を入れました`);
          break;
        }
      }
    };
    api.body.onchange = e => {
      if (e.target.tagName !== 'INPUT') return;
      const li = e.target.closest('li');
      setQ(li.dataset.id, num(e.target.value));
    };
    if (!api.body.dataset.sel) {
      api.body.dataset.sel = '1';
      api.body.addEventListener('focusin', e => { if (e.target.tagName === 'INPUT') e.target.select(); });
    }
  });
}

/* =========================================================
   メニュー
   ========================================================= */
function openMenu() {
  openPanel('メニュー', api => {
    const lb = data.lastBackup;
    const ago = lb ? Math.floor((Date.now() - lb) / 86400000) : null;
    const bkText = ago === null ? '未保存' : ago === 0 ? '今日' : `${ago}日前`;
    api.body.innerHTML = `
      <div class="menu-sec">請求書</div>
      <ul class="menu">
        <li><button data-act="invoice" type="button"><span>請求書を作る</span><small>›</small></button></li>
        <li><button data-act="history" type="button"><span>発行した請求書</span><small>${data.history.length}件</small></button></li>
      </ul>
      <div class="menu-sec">登録</div>
      <ul class="menu">
        <li><button data-act="clients" type="button"><span>請求先</span><small>${data.clients.length}件</small></button></li>
        <li><button data-act="items" type="button"><span>項目と単価</span><small>${data.items.length}件</small></button></li>
        <li><button data-act="issuer" type="button"><span>自分の情報（請求元・振込先）</span><small>${data.issuer.name ? '' : '未登録'}</small></button></li>
      </ul>
      <div class="menu-sec">データ</div>
      <ul class="menu">
        <li><button data-act="backup" type="button"><span>バックアップ</span><small>最終：${bkText}</small></button></li>
        <li><button data-act="update" type="button"><span>アプリを更新</span><small>ver ${APP_VER}</small></button></li>
        <li><button data-act="help" type="button"><span>使い方</span><small>›</small></button></li>
      </ul>
      <p class="ver">データはこの端末の中だけに保存されています。</p>`;
    api.body.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      ({
        invoice: () => openInvoice(),
        history: openHistory,
        clients: openClients,
        items: () => openItems(),
        issuer: openIssuer,
        backup: openBackup,
        update: updateApp,
        help: openHelp
      })[b.dataset.act]();
    };
  });
}

/* =========================================================
   請求先
   ========================================================= */
const DUE_OPTS = [
  ['next-end', '翌月末'],
  ['this-end', '当月末'],
  ['next2-end', '翌々月末'],
  ['d30', '請求日から30日後'],
  ['d14', '請求日から14日後'],
  ['none', '書かない']
];

function openClients() {
  openPanel('請求先', api => {
    const cs = data.clients;
    api.body.innerHTML = cs.length
      ? `<ul class="list">${cs.map((c, i) => `
          <li data-id="${c.id}">
            <div class="main" data-act="edit"><div class="t">${esc(c.name)} ${esc(c.honor || '')}</div>
              <div class="s">${esc([c.addr1, c.person && c.person + ' 様'].filter(Boolean).join('　')) || '　'}</div></div>
            <div class="ord"><button type="button" data-act="up" ${i ? '' : 'disabled'}>▲</button><button type="button" data-act="down" ${i < cs.length - 1 ? '' : 'disabled'}>▼</button></div>
          </li>`).join('')}</ul>`
      : `<p class="empty">まだ登録がありません。</p>`;
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="add">請求先を追加</button>`;
    api.foot.onclick = e => { if (e.target.closest('[data-act=add]')) openClientEdit(null); };
    api.body.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.closest('li').dataset.id;
      const i = cs.findIndex(c => c.id === id);
      if (b.dataset.act === 'edit') openClientEdit(id);
      if (b.dataset.act === 'up' && i > 0) { [cs[i - 1], cs[i]] = [cs[i], cs[i - 1]]; save(); api.refresh(); }
      if (b.dataset.act === 'down' && i < cs.length - 1) { [cs[i + 1], cs[i]] = [cs[i], cs[i + 1]]; save(); api.refresh(); }
    };
  });
}

const CLIENT_FIELDS = [
  { cols: [{ k: 'name', l: '請求先の名前', ph: '株式会社〇〇' }] },
  { cols: [
    { k: 'honor', l: '敬称', t: 'select', opts: [['御中', '御中'], ['様', '様'], ['', 'なし']] },
    { k: 'person', l: 'ご担当者（任意）', ph: '山田' }
  ] },
  { k: 'zip', l: '郵便番号', ph: '000-0000', im: 'numeric' },
  { k: 'addr1', l: '住所' },
  { k: 'addr2', l: '建物名・部署など' },
  { k: 'due', l: '支払期限', t: 'select', opts: DUE_OPTS },
  { k: 'taxMode', l: '単価の扱い', t: 'select', opts: [['incl', '税込み'], ['excl', '税抜き（請求書で消費税を足す）'], ['none', '消費税を扱わない']] }
];

// 差し引く金額の入力行（請求先の固定分・請求書の今回分で共用）
function dedRowsHTML(list, kind) {
  return list.map((x, i) => `
    <li data-i="${i}" data-kind="${kind}">
      <div class="cols">
        <div class="field" style="flex:2"><input type="text" data-k="n" value="${esc(x.n)}" placeholder="内容（例：協力会費）"></div>
        <div class="field"><input type="text" inputmode="numeric" data-k="amt" value="${esc(x.amt)}" placeholder="金額"></div>
      </div>
      <div class="rm"><button class="link" type="button" data-act="rmded">消す</button></div>
    </li>`).join('');
}
function readDedRows(ul, list) {
  $$('li', ul).forEach(li => {
    const x = list[Number(li.dataset.i)];
    if (x) $$('[data-k]', li).forEach(el => { x[el.dataset.k] = el.value; });
  });
}
const cleanDed = list => list.filter(x => String(x.n || '').trim() || num(x.amt)).map(x => ({ n: String(x.n || '').trim(), amt: x.amt }));

function openClientEdit(id) {
  const c = id ? clientById(id) : null;
  const o = c ? clone(c) : { name: '', honor: '御中', person: '', zip: '', addr1: '', addr2: '', due: 'next-end', taxMode: 'incl', deduct: [] };
  openPanel(c ? '請求先の編集' : '請求先の追加', api => {
    api.body.innerHTML = formHTML(CLIENT_FIELDS, o) + `
      <fieldset><legend>毎回差し引く金額（固定）</legend></fieldset>
      <p class="note">ここに入れたものは、消すまで毎回の請求書に載ります。今回だけのものは請求書を作る画面で足せます。</p>
      <ul class="lines" id="dedFixed">${dedRowsHTML(o.deduct, 'fixed')}</ul>
      <button class="btn small" type="button" data-act="addded">＋ 追加</button>` +
      (c ? `<p style="margin-top:28px"><button class="btn danger small" data-act="del" type="button">この請求先を削除</button></p>` : '');
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="save">保存</button>`;
    api.foot.onclick = e => {
      if (!e.target.closest('[data-act=save]')) return;
      readForm(api.body, CLIENT_FIELDS, o);
      readDedRows($('#dedFixed', api.body), o.deduct);
      o.deduct = cleanDed(o.deduct);
      if (!o.name) { toast('名前を入れてください'); return; }
      if (c) Object.assign(c, o);
      else {
        o.id = uid();
        data.clients.push(o);
        if (!clientById(data.cur)) data.cur = o.id;
      }
      save();
      toast('保存しました');
      closeTop();
    };
    api.body.onclick = e => {
      const ul = $('#dedFixed', api.body);
      if (e.target.closest('[data-act=addded]')) {
        readDedRows(ul, o.deduct);
        o.deduct.push({ n: '', amt: '' });
        ul.innerHTML = dedRowsHTML(o.deduct, 'fixed');
        $('li:last-child input', ul).focus();
        return;
      }
      const rm = e.target.closest('[data-act=rmded]');
      if (rm) {
        readDedRows(ul, o.deduct);
        o.deduct.splice(Number(rm.closest('li').dataset.i), 1);
        ul.innerHTML = dedRowsHTML(o.deduct, 'fixed');
        return;
      }
      if (!e.target.closest('[data-act=del]')) return;
      const n = Object.keys(data.entries[c.id] || {}).length;
      const msg = `「${c.name}」を削除します。` + (n ? `\nカレンダーの入力（${n}日分）も消えます。` : '') + '\nよろしいですか？';
      if (!confirm(msg)) return;
      data.clients = data.clients.filter(x => x.id !== c.id);
      delete data.entries[c.id];
      data.items.forEach(it => { if (it.client === c.id) it.client = ''; });
      if (data.cur === c.id) data.cur = data.clients[0] ? data.clients[0].id : '';
      save();
      closeTop();
    };
  }, { noRefresh: true });
}

/* =========================================================
   項目と単価
   ========================================================= */
let itemFilter = 'all';

function openItems() {
  openPanel('項目と単価', api => {
    const chips = [['all', 'すべて'], ['', '共通']].concat(data.clients.map(c => [c.id, c.name]));
    const list = data.items.filter(it => itemFilter === 'all' || it.client === itemFilter);
    api.body.innerHTML = `
      ${data.clients.length ? `<div class="chips">${chips.map(([v, l]) =>
        `<button type="button" class="chip${itemFilter === v ? ' on' : ''}" data-f="${esc(v)}">${esc(l)}</button>`).join('')}</div>` : ''}
      ${list.length ? `<ul class="list">${list.map(it => {
        const cl = it.client ? clientById(it.client) : null;
        const all = data.items;
        const gi = all.indexOf(it);
        return `<li data-id="${it.id}">
          <div class="main" data-act="edit">
            <div class="t"><span class="tag${it.fill ? ' fill' : ''}" style="display:inline-block;margin-right:6px;font-size:11px">${esc(it.short || it.name)}</span>${esc(it.name)}</div>
            <div class="s">${yen(it.price)}円${it.unit ? ' / ' + esc(it.unit) : ''}　${it.rate === 8 ? '8%' : it.rate === 0 ? '対象外' : '10%'}　${cl ? esc(cl.name) + 'のみ' : '共通'}</div>
          </div>
          <div class="ord"><button type="button" data-act="up" ${gi ? '' : 'disabled'}>▲</button><button type="button" data-act="down" ${gi < all.length - 1 ? '' : 'disabled'}>▼</button></div>
        </li>`;
      }).join('')}</ul>` : `<p class="empty">項目がありません。<br>「日勤 15,000円」「交通費」のように、よく使う作業と単価を登録しておくと、カレンダーからすぐ選べます。</p>`}`;
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="add">項目を追加</button>`;
    api.foot.onclick = e => {
      if (e.target.closest('[data-act=add]')) openItemEdit(null, itemFilter === 'all' ? '' : itemFilter);
    };
    api.body.onclick = e => {
      const ch = e.target.closest('.chip');
      if (ch) { itemFilter = ch.dataset.f; api.refresh(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.closest('li').dataset.id;
      const all = data.items;
      const i = all.findIndex(x => x.id === id);
      if (b.dataset.act === 'edit') openItemEdit(id);
      if (b.dataset.act === 'up' && i > 0) { [all[i - 1], all[i]] = [all[i], all[i - 1]]; save(); api.refresh(); }
      if (b.dataset.act === 'down' && i < all.length - 1) { [all[i + 1], all[i]] = [all[i], all[i + 1]]; save(); api.refresh(); }
    };
  });
}

function itemFields() {
  return [
    { k: 'name', l: '項目名（請求書に載る名前）', ph: '例）日勤　作業費　交通費' },
    { cols: [
      { k: 'short', l: 'カレンダー表示', ph: '日勤', hint: '2〜3文字くらい' },
      { k: 'fill', l: '表示の色', t: 'select', opts: [['', '白（枠だけ）'], ['1', '黒']] }
    ] },
    { cols: [
      { k: 'price', l: '単価（円）', t: 'num', ph: '15000', hint: '税込みか税抜きかは請求先の設定に合わせる' },
      { k: 'unit', l: '単位', ph: '日・時間・式' }
    ] },
    { k: 'rate', l: '消費税率', t: 'select', opts: [['10', '10%'], ['8', '8%（軽減税率）'], ['0', '対象外・非課税']] },
    { k: 'client', l: '使う請求先', t: 'select', opts: [['', 'すべての請求先で使う']].concat(data.clients.map(c => [c.id, c.name + 'だけ'])) }
  ];
}

function openItemEdit(id, defClient = '') {
  const it = id ? itemById(id) : null;
  const o = it ? clone(it) : { name: '', short: '', fill: false, price: '', unit: '', rate: 10, client: defClient };
  o.fill = o.fill ? '1' : '';
  openPanel(it ? '項目の編集' : '項目の追加', api => {
    const fields = itemFields();
    api.body.innerHTML = formHTML(fields, o) +
      (it ? `<p style="margin-top:28px"><button class="btn danger small" data-act="del" type="button">この項目を削除</button></p>` : '');
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="save">保存</button>`;
    api.foot.onclick = e => {
      if (!e.target.closest('[data-act=save]')) return;
      const v = readForm(api.body, fields, {});
      if (!v.name) { toast('項目名を入れてください'); return; }
      const nv = {
        name: v.name,
        short: v.short.slice(0, 6),
        fill: v.fill === '1',
        price: num(v.price),
        unit: v.unit,
        rate: Number(v.rate),
        client: v.client
      };
      if (it) {
        const changed = it.price !== nv.price || it.name !== nv.name || it.unit !== nv.unit || it.rate !== nv.rate;
        Object.assign(it, nv);
        if (changed) {
          const n = countUses(it.id);
          if (n && confirm(`この項目はカレンダーに${n}件入っています。\n入力済みの分も新しい内容（名前・単価など）に変えますか？\n\n［キャンセル］なら入力済みの分は今のままです。`)) {
            applyItemToEntries(it);
          }
        }
      } else {
        nv.id = uid();
        data.items.push(nv);
      }
      save();
      toast('保存しました');
      closeTop();
    };
    api.body.onclick = e => {
      if (!e.target.closest('[data-act=del]')) return;
      if (!confirm(`「${it.name}」を削除しますか？\nカレンダーに入力済みの分は消えずに残ります。`)) return;
      data.items = data.items.filter(x => x.id !== it.id);
      save();
      closeTop();
    };
  }, { noRefresh: true });
}

function countUses(itemId) {
  let n = 0;
  Object.values(data.entries).forEach(byDay => Object.values(byDay).forEach(list => list.forEach(e => { if (e.i === itemId) n++; })));
  return n;
}
function applyItemToEntries(it) {
  Object.values(data.entries).forEach(byDay => Object.values(byDay).forEach(list => list.forEach(e => {
    if (e.i === it.id) Object.assign(e, { n: it.name, s: it.short, p: it.price, u: it.unit, r: it.rate });
  })));
}

/* =========================================================
   自分の情報（請求元）
   ========================================================= */
const ISSUER_FIELDS = [
  { k: 'name', l: '屋号・会社名・氏名', ph: '〇〇デザイン事務所' },
  { k: 'rep', l: '代表者・担当者名（任意）' },
  { k: 'zip', l: '郵便番号', ph: '000-0000', im: 'numeric' },
  { k: 'addr1', l: '住所' },
  { k: 'addr2', l: '建物名など' },
  { k: 'tel', l: '電話番号', t: 'tel' },
  { k: 'email', l: 'メールアドレス', t: 'email' },
  { k: 'regno', l: '登録番号（インボイス）', ph: 'T1234567890123', hint: '適格請求書発行事業者でなければ空欄のままで大丈夫です' },
  { legend: '振込先' },
  { cols: [{ k: 'bank', l: '銀行名', ph: '〇〇銀行' }, { k: 'branch', l: '支店名', ph: '〇〇支店' }] },
  { cols: [
    { k: 'acctType', l: '種別', t: 'select', opts: [['普通', '普通'], ['当座', '当座'], ['貯蓄', '貯蓄']] },
    { k: 'acctNo', l: '口座番号', im: 'numeric' }
  ] },
  { k: 'holder', l: '口座名義（カナ）' },
  { legend: '消費税' },
  { html: '<p class="note">税込み・税抜きの扱いは、請求先ごとに「請求先」の画面で決めます。</p>' },
  { k: 'rounding', l: '消費税の端数', t: 'select', opts: [['floor', '切り捨て'], ['round', '四捨五入'], ['ceil', '切り上げ']] },
  { k: 'withholding', l: '源泉徴収税を差し引く', t: 'check', hint: '個人で報酬を受け取る場合など。請求書を作るときに毎回変えることもできます。' },
  { legend: 'その他' },
  { k: 'note', l: '備考欄に最初から入れておく文', t: 'textarea' }
];

function openIssuer() {
  const o = clone(data.issuer);
  openPanel('自分の情報', api => {
    api.body.innerHTML = formHTML(ISSUER_FIELDS, o) + `
      <fieldset><legend>印影（任意）</legend></fieldset>
      <div class="seal-prev">
        ${o.seal ? `<img src="${o.seal}" alt="">` : '<span class="note" style="margin:0">未設定</span>'}
        <label class="btn small">画像を選ぶ<input type="file" accept="image/*" hidden id="sealFile"></label>
        ${o.seal ? '<button class="btn small" type="button" data-act="nos">外す</button>' : ''}
      </div>
      <p class="note">背景が白い印鑑の写真を選ぶと、白い部分を透明にして使います。</p>`;
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="save">保存</button>`;

    const keep = () => readForm(api.body, ISSUER_FIELDS, o);
    $('#sealFile', api.body).onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      keep();
      try { o.seal = await makeSeal(f); } catch (_) { toast('画像を読み込めませんでした'); }
      api.refresh();
    };
    api.body.onclick = e => {
      if (e.target.closest('[data-act=nos]')) { keep(); o.seal = ''; api.refresh(); }
    };
    api.foot.onclick = e => {
      if (!e.target.closest('[data-act=save]')) return;
      keep();
      data.issuer = o;
      save();
      toast('保存しました');
      closeTop();
    };
  }, { noRefresh: true });
}

// 印影：最大240pxに縮め、白っぽい部分を透明に、色はモノクロに
function makeSeal(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 240 / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, w, h);
      const px = cx.getImageData(0, 0, w, h);
      const a = px.data;
      for (let i = 0; i < a.length; i += 4) {
        const lum = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        const sat = Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]);
        const ink = Math.max(255 - lum, sat); // 朱肉の赤も拾う
        const alpha = ink < 40 ? 0 : Math.min(255, (ink - 40) * 2);
        a[i] = a[i + 1] = a[i + 2] = 0;
        a[i + 3] = alpha;
      }
      cx.putImageData(px, 0, 0);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

/* =========================================================
   請求書の作成
   ========================================================= */
function dueFrom(rule, issue) {
  const d = toDate(issue);
  const y = d.getFullYear(), m = d.getMonth();
  switch (rule) {
    case 'this-end': return ymd(endOfMonth(y, m));
    case 'next2-end': return ymd(endOfMonth(y, m + 2));
    case 'd30': return ymd(new Date(y, m, d.getDate() + 30));
    case 'd14': return ymd(new Date(y, m, d.getDate() + 14));
    case 'none': return '';
    default: return ymd(endOfMonth(y, m + 1));
  }
}

function defaultSubject(from, to) {
  const a = toDate(from), b = toDate(to);
  const fullMonth = a.getDate() === 1 && ymd(endOfMonth(b.getFullYear(), b.getMonth())) === to &&
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  if (fullMonth) return `${a.getMonth() + 1}月分`;
  return `${md(from)}〜${md(to)}分`;
}

// 期間内の入力と追加行をまとめて、明細の元データにする
function collect(inv) {
  const out = [];
  const ent = data.entries[inv.clientId] || {};
  Object.keys(ent).sort().forEach(d => {
    if (d < inv.from || d > inv.to) return;
    ent[d].forEach(e => out.push({ d, i: e.i, n: e.n, q: e.q, u: e.u || '', p: e.p, r: e.r ?? 10 }));
  });
  (inv.extra || []).forEach(x => {
    if (!x.n && !x.p) return;
    out.push({ d: '', i: '', n: x.n || '', q: x.q === '' || x.q == null ? 1 : num(x.q), u: x.u || '', p: num(x.p), r: Number(x.r ?? 10), extra: true });
  });
  return out;
}

function compute(snap) {
  const is = snap.issuer;
  const R = { floor: Math.floor, round: Math.round, ceil: Math.ceil }[is.rounding] || Math.floor;
  const mode = (snap.client && snap.client.taxMode) || is.taxMode || 'incl';
  const raw = snap.raw;
  let rows = [];

  if (snap.inv.group === 'date') {
    rows = raw.map(x => ({ d: x.d, n: x.n, q: x.q, u: x.u, p: x.p, r: x.r }));
  } else {
    const order = id => { const k = (snap.itemOrder || []).indexOf(id); return k < 0 ? 9999 : k; };
    const map = new Map();
    raw.forEach((x, idx) => {
      const key = x.extra ? 'x' + idx : [x.n, x.p, x.r, x.u].join('|');
      if (!map.has(key)) map.set(key, { n: x.n, q: 0, u: x.u, p: x.p, r: x.r, o: x.extra ? 10000 + idx : order(x.i), first: x.d });
      map.get(key).q += x.q;
    });
    rows = Array.from(map.values()).sort((a, b) => a.o - b.o || String(a.first).localeCompare(String(b.first)));
  }
  rows.forEach(x => { x.amt = Math.round(x.q * x.p); });

  const by = {};
  rows.forEach(x => { by[x.r] = (by[x.r] || 0) + x.amt; });
  const rates = [];
  let sub = 0, tax = 0;
  Object.keys(by).map(Number).sort((a, b) => b - a).forEach(r => {
    const base = by[r];
    let t = 0;
    if (mode === 'excl') t = R(base * r / 100);
    else if (mode === 'incl') t = R(base * r / (100 + r));
    rates.push({ r, base, tax: t });
    sub += base;
    tax += t;
  });
  const gross = mode === 'excl' ? sub + tax : sub;
  const exclBase = mode === 'incl' ? sub - tax : sub;
  let wh = 0;
  if (snap.inv.withholding && exclBase > 0) {
    wh = exclBase <= 1000000 ? Math.floor(exclBase * 0.1021) : Math.floor((exclBase - 1000000) * 0.2042) + 102100;
  }
  const ded = (snap.deduct || []).map(x => ({ n: x.n, amt: num(x.amt) })).filter(x => x.n || x.amt);
  const dedSum = ded.reduce((a, x) => a + x.amt, 0);
  return { rows, rates, sub, tax, gross, wh, ded, dedSum, total: gross - wh - dedSum, mode };
}

function makeSnap(inv) {
  return {
    inv: clone(inv),
    issuer: clone(data.issuer),
    client: clone(clientById(inv.clientId) || {}),
    raw: collect(inv),
    deduct: cleanDed(((clientById(inv.clientId) || {}).deduct || []).concat(inv.deduct || [])),
    itemOrder: data.items.map(i => i.id)
  };
}

function openInvoice() {
  const c = curClient();
  if (!c) {
    if (confirm('先に請求先を登録してください。今登録しますか？')) openClientEdit(null);
    return;
  }
  const from = ymd(new Date(viewY, viewM, 1));
  const to = ymd(endOfMonth(viewY, viewM));
  const issue = ymd(new Date());
  const inv = {
    clientId: c.id,
    from, to, issue,
    due: dueFrom(c.due, issue),
    no: '',
    subject: defaultSubject(from, to),
    group: 'item',
    withholding: !!data.issuer.withholding,
    extra: [],
    deduct: [],
    note: data.issuer.note || ''
  };
  let histId = null; // 同じ画面から何度印刷しても履歴は1件

  const fields = () => [
    { k: 'clientId', l: '請求先', t: 'select', opts: data.clients.map(x => [x.id, x.name]) },
    { cols: [{ k: 'from', l: '対象期間（から）', t: 'date' }, { k: 'to', l: '（まで）', t: 'date' }] },
    { cols: [{ k: 'issue', l: '請求日', t: 'date' }, { k: 'due', l: 'お支払期限', t: 'date' }] },
    { cols: [{ k: 'no', l: '請求番号', ph: '空欄のままでも可' }, { k: 'group', l: '明細の並べ方', t: 'select', opts: [['item', '項目ごとに合計'], ['date', '日付ごと']] }] },
    { k: 'subject', l: '件名' }
  ];

  openPanel('請求書を作る', api => {
    const tail = [
      { k: 'withholding', l: '源泉徴収税を差し引く', t: 'check' },
      { k: 'note', l: '備考', t: 'textarea' }
    ];
    api.body.innerHTML = formHTML(fields(), inv) + `
      <fieldset><legend>追加の明細（交通費など）</legend></fieldset>
      <ul class="lines" id="lines"></ul>
      <button class="btn small" type="button" data-act="addline">＋ 行を追加</button>

      <fieldset><legend>差し引く金額</legend></fieldset>
      <p class="note" style="margin:0 0 6px"><b>毎回（固定）</b>　消すまでこの請求先の請求書に毎回載ります</p>
      <ul class="lines" id="dedFixed"></ul>
      <button class="btn small" type="button" data-act="addfixed">＋ 毎回差し引くものを追加</button>
      <p class="note" style="margin:18px 0 6px"><b>今回だけ</b></p>
      <ul class="lines" id="dedTemp"></ul>
      <button class="btn small" type="button" data-act="addtemp">＋ 今回だけ差し引くものを追加</button>
      <div style="height:16px"></div>
      ${formHTML(tail, inv)}
      <div class="calc" id="calc"></div>`;
    api.foot.hidden = false;
    api.foot.innerHTML = `<button class="btn dark wide" type="button" data-act="preview">確認して印刷・PDF保存へ</button>`;

    const linesEl = $('#lines', api.body);
    const fixedEl = $('#dedFixed', api.body);
    const tempEl = $('#dedTemp', api.body);
    const cl = () => clientById(inv.clientId);

    const drawLines = () => {
      linesEl.innerHTML = inv.extra.map((x, i) => `
        <li data-i="${i}">
          <div class="field"><input type="text" data-k="n" value="${esc(x.n)}" placeholder="項目（例：交通費）"></div>
          <div class="cols">
            <div class="field"><input type="text" inputmode="decimal" data-k="q" value="${esc(x.q)}" placeholder="数量 1"></div>
            <div class="field"><input type="text" data-k="u" value="${esc(x.u)}" placeholder="単位"></div>
            <div class="field"><input type="text" inputmode="numeric" data-k="p" value="${esc(x.p)}" placeholder="単価"></div>
          </div>
          <div class="cols">
            <div class="field"><select data-k="r">
              ${[['10', '10%'], ['8', '8%'], ['0', '対象外']].map(([v, l]) => `<option value="${v}"${String(x.r) === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select></div>
            <div class="rm"><button class="link" type="button" data-act="rmline">この行を消す</button></div>
          </div>
        </li>`).join('');
    };
    const drawDed = () => {
      const k = cl();
      fixedEl.innerHTML = dedRowsHTML(k ? k.deduct : [], 'fixed');
      tempEl.innerHTML = dedRowsHTML(inv.deduct, 'temp');
    };
    // 固定分は請求先に直接保存する
    const readFixed = () => {
      const k = cl();
      if (!k) return;
      const before = JSON.stringify(k.deduct);
      readDedRows(fixedEl, k.deduct);
      if (JSON.stringify(k.deduct) !== before) save();
    };
    const sync = () => {
      readFixed(); // 請求先を切り替える前に、元の請求先へ書き戻す
      readDedRows(tempEl, inv.deduct);
      const old = { from: inv.from, to: inv.to, clientId: inv.clientId, issue: inv.issue };
      const autoSubject = inv.subject === defaultSubject(old.from, old.to);
      readForm(api.body, fields(), inv);
      readForm(api.body, tail, inv);
      $$('li', linesEl).forEach(li => {
        const x = inv.extra[Number(li.dataset.i)];
        $$('[data-k]', li).forEach(el => { x[el.dataset.k] = el.value; });
      });
      if (inv.from > inv.to) inv.to = inv.from;
      if (autoSubject && (old.from !== inv.from || old.to !== inv.to)) {
        inv.subject = defaultSubject(inv.from, inv.to);
        $('[name=subject]', api.body).value = inv.subject;
      }
      if (old.clientId !== inv.clientId || old.issue !== inv.issue) {
        inv.due = dueFrom(cl() && cl().due, inv.issue);
        $('[name=due]', api.body).value = inv.due;
      }
      if (old.clientId !== inv.clientId) { histId = null; drawDed(); }
      drawCalc();
    };
    const drawCalc = () => {
      const snap = makeSnap(inv);
      const r = compute(snap);
      const days = new Set(snap.raw.filter(x => x.d).map(x => x.d)).size;
      const m = r.mode;
      $('#calc', api.body).innerHTML = `
        <div><span>対象</span><span>${days}日・${snap.raw.length}件</span></div>
        <div><span>小計${m === 'excl' ? '（税抜）' : m === 'incl' ? '（税込）' : ''}</span><span>${yen(r.sub)}円</span></div>
        ${m === 'excl' ? `<div><span>消費税</span><span>${yen(r.tax)}円</span></div>` : ''}
        ${m === 'incl' ? `<div><span>うち消費税</span><span>${yen(r.tax)}円</span></div>` : ''}
        ${r.wh ? `<div><span>源泉徴収税</span><span>△${yen(r.wh)}円</span></div>` : ''}
        ${r.ded.map(x => `<div><span>${esc(x.n || '差引')}</span><span>△${yen(x.amt)}円</span></div>`).join('')}
        <div class="big"><span>ご請求金額</span><span>${yen(r.total)}円</span></div>`;
    };

    drawLines();
    drawDed();
    drawCalc();
    api.body.oninput = e => { if (e.target.matches('[data-k]')) sync(); };
    api.body.onchange = () => sync();
    api.body.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'addline') {
        sync();
        inv.extra.push({ n: '', q: '', u: '', p: '', r: cl() && cl().taxMode === 'none' ? '0' : '10' });
        drawLines();
        const last = linesEl.lastElementChild;
        if (last) $('input', last).focus();
      }
      if (act === 'rmline') {
        sync();
        inv.extra.splice(Number(b.closest('li').dataset.i), 1);
        drawLines();
        drawCalc();
      }
      if (act === 'addfixed' || act === 'addtemp') {
        sync();
        const fixed = act === 'addfixed';
        (fixed ? cl().deduct : inv.deduct).push({ n: '', amt: '' });
        if (fixed) save();
        drawDed();
        $('li:last-child input', fixed ? fixedEl : tempEl).focus();
      }
      if (act === 'rmded') {
        sync();
        const li = b.closest('li');
        const fixed = li.dataset.kind === 'fixed';
        const list = fixed ? cl().deduct : inv.deduct;
        const x = list[Number(li.dataset.i)];
        if (fixed && (x.n || x.amt) && !confirm(`「${x.n || '差引'}」を毎回の差し引きから外しますか？\n次回からも載らなくなります。`)) return;
        list.splice(Number(li.dataset.i), 1);
        if (fixed) save();
        drawDed();
        drawCalc();
      }
    };
    api.foot.onclick = e => {
      if (!e.target.closest('[data-act=preview]')) return;
      sync();
      const k = cl();
      if (k) {
        const cleaned = cleanDed(k.deduct);
        if (cleaned.length !== k.deduct.length) { k.deduct = cleaned; save(); drawDed(); }
      }
      const snap = makeSnap(inv);
      if (!snap.raw.length) { toast('この期間の入力がありません'); return; }
      snap.id = histId;
      openPreview(snap, { fresh: true, onKept: id => { histId = id; } });
    };
  }, { noRefresh: true });
}

/* ---------- プレビューと印刷 ---------- */
function openPreview(snap, opts = {}) {
  const title = snap.inv.no ? `請求書 ${snap.inv.no}` : '請求書の確認';
  let fit = null;
  openPanel(title, api => {
    const warn = [];
    if (!snap.issuer.name) warn.push('自分の情報（請求元）が未登録です。');
    if (!snap.issuer.bank) warn.push('振込先が未登録です。');
    api.body.style.padding = '0';
    api.body.innerHTML = (warn.length ? `<p class="note" style="padding:8px 14px 0;margin:0">${warn.map(esc).join('<br>')}</p>` : '') +
      `<div class="preview-wrap"><div class="pv-box"><div class="preview-scale">${docHTML(snap)}</div></div></div>`;
    api.foot.hidden = false;
    api.foot.innerHTML = `<div class="btn-row">
        ${opts.fresh ? '' : '<button class="btn" type="button" data-act="del">履歴から削除</button>'}
        <button class="btn dark" type="button" data-act="print">印刷・PDFで保存</button>
      </div>
      <p class="note" style="margin:8px 0 0">PDFにするときは、印刷画面で「PDFに保存」を選んでください。iPhoneは印刷画面のプレビューを2本指で広げると共有からPDFで保存できます。</p>`;

    fit = () => {
      const wrap = $('.preview-wrap', api.body);
      const box = $('.pv-box', api.body);
      const sc = $('.preview-scale', api.body);
      const doc = $('.doc', sc);
      if (!wrap || !doc) return;
      const k = Math.min(1, (wrap.clientWidth - 16) / doc.offsetWidth);
      sc.style.transform = `scale(${k})`;
      box.style.width = doc.offsetWidth * k + 'px';
      box.style.height = doc.offsetHeight * k + 'px';
      box.style.margin = '0 auto';
    };
    requestAnimationFrame(fit);
    window.addEventListener('resize', fit);

    api.foot.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'print') {
        if (opts.fresh) { keepHistory(snap); if (opts.onKept) opts.onKept(snap.id); }
        printDoc(snap);
      }
      if (b.dataset.act === 'del') {
        if (!confirm('この請求書を履歴から削除しますか？\n（カレンダーの入力は消えません）')) return;
        data.history = data.history.filter(h => h.id !== snap.id);
        save();
        closeTop();
      }
    };
  }, { noRefresh: true, onClose: () => { if (fit) window.removeEventListener('resize', fit); } });
}

function keepHistory(snap) {
  const h = snap.id ? data.history.find(x => x.id === snap.id) : null;
  const r = compute(snap);
  const rec = Object.assign(clone(snap), { id: h ? h.id : uid(), total: r.total, at: Date.now() });
  // 印影の画像は容量を食うので履歴には持たず、表示のときに今の印影を使う
  rec.issuer.sealUse = !!rec.issuer.seal;
  rec.issuer.seal = '';
  if (h) Object.assign(h, rec); else data.history.unshift(rec);
  snap.id = rec.id;
  save();
}

function printDoc(snap) {
  const root = $('#print-root');
  root.innerHTML = docHTML(snap);
  const before = document.title;
  const cl = snap.client.name || '';
  document.title = ['請求書', cl, snap.inv.no || snap.inv.issue.replace(/-/g, '')].filter(Boolean).join('_').replace(/[\\/:*?"<>|\s]+/g, '');
  const restore = () => { document.title = before; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  setTimeout(() => { window.print(); setTimeout(restore, 1500); }, 50);
}

/* ---------- 請求書の中身（HTML） ---------- */
function docHTML(snap) {
  const is = snap.issuer, cl = snap.client, inv = snap.inv;
  const seal = is.seal || (is.sealUse ? data.issuer.seal : '');
  const r = compute(snap);
  const byDate = inv.group === 'date';
  const m = r.mode;
  const has8 = r.rows.some(x => x.r === 8) && m !== 'none';
  const zipS = z => z ? '〒' + esc(z) : '';

  const MIN_ROWS = byDate ? 12 : 8;
  const rowsHTML = r.rows.map(x => `<tr>
      ${byDate ? `<td class="c">${x.d ? md(x.d) : ''}</td>` : ''}
      <td>${esc(x.n)}${x.r === 8 && m !== 'none' ? '<span class="rate">※</span>' : ''}</td>
      <td class="n">${qtyStr(x.q)}</td>
      <td class="c">${esc(x.u)}</td>
      <td class="n">${yen(x.p)}</td>
      <td class="n">${yen(x.amt)}</td>
    </tr>`).join('') +
    Array.from({ length: Math.max(0, MIN_ROWS - r.rows.length - r.ded.length) }, () =>
      `<tr>${byDate ? '<td></td>' : ''}<td></td><td></td><td></td><td></td><td></td></tr>`).join('') +
    // 差し引く分は太線で区切って下にまとめる
    r.ded.map((x, i) => `<tr class="ded${i ? '' : ' ded-first'}">
      ${byDate ? '<td></td>' : ''}
      <td>${esc(x.n)}</td>
      <td></td><td></td><td></td>
      <td class="n">△${yen(x.amt)}</td>
    </tr>`).join('');

  const rateLabel = x => x.r === 0 ? '対象外' : x.r + '%対象';
  const taxTable = m === 'none' ? '' : `
    <div class="doc-tax">
      <table>
        <tr><th>内訳</th><th>${m === 'incl' ? '金額（税込）' : '金額（税抜）'}</th><th>消費税</th></tr>
        ${r.rates.map(x => `<tr><th>${rateLabel(x)}</th><td>${yen(x.base)}円</td><td>${x.r ? yen(x.tax) + '円' : '―'}</td></tr>`).join('')}
      </table>
      ${has8 ? '<div style="margin-top:1mm">※は軽減税率（8%）対象</div>' : ''}
    </div>`;

  const totals = `
    <table class="doc-totals">
      <tr><th>小計${m === 'excl' ? '（税抜）' : m === 'incl' ? '（税込）' : ''}</th><td>${yen(r.sub)}円</td></tr>
      ${m === 'excl' ? `<tr><th>消費税</th><td>${yen(r.tax)}円</td></tr>` : ''}
      ${m === 'incl' ? `<tr><th>（うち消費税）</th><td>${yen(r.tax)}円</td></tr>` : ''}
      ${r.wh ? `<tr><th>源泉徴収税</th><td>△${yen(r.wh)}円</td></tr>` : ''}
      ${r.ded.length ? `<tr><th>合計</th><td>${yen(r.gross - r.wh)}円</td></tr>
        <tr><th>差引額</th><td>△${yen(r.dedSum)}円</td></tr>
        <tr class="total"><th>ご請求金額</th><td>${yen(r.total)}円</td></tr>`
      : `<tr class="total"><th>合計</th><td>${yen(r.total)}円</td></tr>`}
    </table>`;

  const bankLines = [
    is.bank || is.branch ? `<tr><td>${esc(is.bank)}　${esc(is.branch)}</td></tr>` : '',
    is.acctNo ? `<tr><td>${esc(is.acctType)}　${esc(is.acctNo)}</td></tr>` : '',
    is.holder ? `<tr><td>口座名義　${esc(is.holder)}</td></tr>` : ''
  ].join('');

  return `<div class="doc">
    <h1 class="doc-title">請求書</h1>
    <div class="doc-meta"><table>
      <tr><th>請求日</th><td>${jpDate(inv.issue)}</td></tr>
      ${inv.no ? `<tr><th>請求番号</th><td>${esc(inv.no)}</td></tr>` : ''}
    </table></div>

    <div class="doc-parties">
      <div class="doc-to">
        <div class="ad">
          ${cl.zip ? zipS(cl.zip) + '<br>' : ''}
          ${cl.addr1 ? esc(cl.addr1) + '<br>' : ''}
          ${cl.addr2 ? esc(cl.addr2) : ''}
        </div>
        <div class="nm">${esc(cl.name)}<small>${esc(cl.honor || '')}</small></div>
        ${cl.person ? `<div class="ad">${esc(cl.person)} 様</div>` : ''}
      </div>
      <div class="doc-from">
        ${is.zip ? `<div>${zipS(is.zip)}</div>` : ''}
        ${is.addr1 ? `<div>${esc(is.addr1)}</div>` : ''}
        ${is.addr2 ? `<div>${esc(is.addr2)}</div>` : ''}
        <div class="who">
          ${seal ? `<img class="seal" src="${seal}" alt="">` : ''}
          <div class="nm">${esc(is.name)}</div>
          ${is.rep ? `<div class="rep">${esc(is.rep)}</div>` : ''}
        </div>
        ${is.tel ? `<div>TEL ${esc(is.tel)}</div>` : ''}
        ${is.email ? `<div>${esc(is.email)}</div>` : ''}
        ${is.regno ? `<div>登録番号 ${esc(is.regno)}</div>` : ''}
      </div>
    </div>

    <p class="doc-lead">下記のとおりご請求申し上げます。</p>
    ${inv.subject ? `<div class="doc-subject">件名　${esc(inv.subject)}</div>` : ''}
    <div class="doc-amount">
      <div class="l">ご請求金額</div>
      <div class="v">¥${yen(r.total)}-${m === 'none' ? '' : '<small>（税込）</small>'}</div>
    </div>
    <div class="doc-due">
      対象期間　${slash(inv.from)} 〜 ${slash(inv.to)}
      ${inv.due ? `<br>お支払期限　${jpDate(inv.due)}` : ''}
    </div>

    <table class="doc-table">
      <thead><tr>
        ${byDate ? '<th class="w-date">日付</th>' : ''}
        <th>項目</th>
        <th class="w-qty">数量</th>
        <th class="w-unit">単位</th>
        <th class="w-price">単価${m === 'incl' ? '<span class="rate">(税込)</span>' : m === 'excl' ? '<span class="rate">(税抜)</span>' : ''}</th>
        <th class="w-amt">金額</th>
      </tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>

    <div class="doc-bottom">
      ${taxTable || '<div></div>'}
      ${totals}
    </div>

    ${bankLines ? `<div class="doc-box">
      <div class="h">お振込先</div>
      <div class="c" style="white-space:normal"><table class="doc-bank">${bankLines}</table></div>
    </div>` : ''}

    ${inv.note ? `<div class="doc-box"><div class="h">備考</div><div class="c">${esc(inv.note)}</div></div>` : ''}
  </div>`;
}

/* =========================================================
   発行した請求書
   ========================================================= */
function openHistory() {
  openPanel('発行した請求書', api => {
    const hs = data.history;
    api.body.innerHTML = hs.length
      ? `<p class="note">印刷・PDF保存をしたときの内容がそのまま残っています。あとで単価を変えても、ここの請求書は変わりません。</p>
         <ul class="list">${hs.map(h => `
          <li data-id="${h.id}">
            <div class="main" data-act="open">
              <div class="t">${esc(h.client.name || '（請求先なし）')}　${yen(h.total)}円</div>
              <div class="s">${h.inv.no ? 'No.' + esc(h.inv.no) + '　' : ''}${esc(h.inv.subject || '')}　${slash(h.inv.issue)}</div>
            </div>
          </li>`).join('')}</ul>`
      : `<p class="empty">まだありません。請求書を印刷・PDF保存すると、ここに残ります。</p>`;
    api.body.onclick = e => {
      const b = e.target.closest('[data-act=open]');
      if (!b) return;
      const h = data.history.find(x => x.id === b.closest('li').dataset.id);
      if (h) openPreview(h);
    };
  });
}

/* =========================================================
   バックアップ
   ========================================================= */
function openBackup() {
  openPanel('バックアップ', api => {
    let daily = [];
    try { daily = JSON.parse(localStorage.getItem(KEY_DAILY) || '[]'); } catch (_) {}
    const lb = data.lastBackup ? new Date(data.lastBackup) : null;
    api.body.innerHTML = `
      <p class="note" style="font-size:13px;color:#333">
        データはこの端末のブラウザの中にあります。機種変更やアプリの削除、ブラウザのデータ消去をすると消えてしまうので、
        ときどきファイルに書き出しておいてください。
      </p>
      <p class="note">最後に書き出した日：${lb ? `${lb.getFullYear()}/${lb.getMonth() + 1}/${lb.getDate()}` : 'まだありません'}</p>
      <button class="btn dark wide" type="button" data-act="export">ファイルに書き出す</button>
      <div style="height:10px"></div>
      <label class="btn wide" style="display:block;text-align:center">ファイルから戻す<input type="file" accept=".json,application/json" hidden id="impFile"></label>
      <p class="note">書き出したファイルには住所や口座番号が入っています。人に送ったり、共有の場所に置いたりしないでください。</p>

      <fieldset><legend>端末内の自動控え</legend></fieldset>
      <p class="note">1日1回、その日最初の保存のときに自動で控えを取っています（3日分）。間違えて消したときに使えます。</p>
      ${daily.length ? `<ul class="list">${daily.map((d, i) => `
        <li><div class="main"><div class="t">${slash(d.day)} の控え</div></div>
        <button class="btn small" type="button" data-act="restore" data-i="${i}">この状態に戻す</button></li>`).join('')}</ul>`
      : '<p class="empty">まだありません。</p>'}`;

    $('#impFile', api.body).onchange = e => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const obj = JSON.parse(rd.result);
          const d = obj && obj.app === 'seikyu' ? obj.data : obj;
          if (!d || !Array.isArray(d.clients) || !d.issuer) throw 0;
          const at = obj.at ? new Date(obj.at) : null;
          if (!confirm(`${at ? `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} に書き出した` : 'この'}データに置き換えます。\n今の内容は上書きされます。よろしいですか？`)) return;
          data = normalize(d);
          save();
          toast('読み込みました');
          api.refresh();
          renderMain();
        } catch (_) {
          alert('このファイルは読み込めませんでした。');
        }
      };
      rd.readAsText(f);
      e.target.value = '';
    };
    api.body.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'export') exportBackup().then(() => api.refresh());
      if (b.dataset.act === 'restore') {
        const d = daily[Number(b.dataset.i)];
        if (!d || !confirm(`${slash(d.day)} の状態に戻します。\nそれ以降の入力は消えます。よろしいですか？`)) return;
        try {
          data = normalize(JSON.parse(d.json));
          save();
          toast('戻しました');
          api.refresh();
          renderMain();
        } catch (_) { alert('控えが壊れていて戻せませんでした。'); }
      }
    };
  });
}

async function exportBackup() {
  const now = new Date();
  const json = JSON.stringify({ app: 'seikyu', ver: APP_VER, at: now.toISOString(), data });
  const name = `seikyu-backup-${ymd(now).replace(/-/g, '')}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  let ok = false;
  if (mobile && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        ok = true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  if (!ok) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  data.lastBackup = Date.now();
  save();
  toast('書き出しました');
}

/* =========================================================
   更新
   ========================================================= */
async function updateApp() {
  if (!navigator.onLine) { alert('ネットにつながっていないため更新できません。'); return; }
  if (!confirm('最新版を読み込みます。\n入力したデータはそのまま残ります。')) return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch (_) {}
  location.reload();
}

/* =========================================================
   使い方
   ========================================================= */
function openHelp() {
  openPanel('使い方', api => {
    api.body.innerHTML = `
      <div style="font-size:14px">
      <p><b>1. 最初に登録するもの</b><br>
      メニューから「自分の情報」「請求先」「項目と単価」を入れます。項目は「日勤 15,000円」のような作業の種類と単価です。
      特定の請求先だけで使う項目は、その請求先を選んでおくと他の請求先には出てきません。</p>

      <p><b>2. カレンダーに入力</b><br>
      日付をタップして、その日にやった項目を選びます。数量は −／＋ で変えられます（0.5 などの数字も入力できます）。
      入力はその場で保存されます。<br>
      請求先は画面左上の名前をタップで切り替えます。カレンダーは請求先ごとに別々です。</p>

      <p><b>3. 請求書</b><br>
      下の「請求書を作る」から。表示している月が対象期間になります。締め日が月末でない場合は期間を変えてください。
      交通費など、カレンダーにない分は「追加の明細」で足せます。<br>
      請求先に差し引かれる金額は「差し引く金額」へ。毎回引かれるもの（固定）は消すまで毎回載り、「今回だけ」はその請求書にだけ載ります。
      固定のものは請求先の編集画面からも直せます。</p>

      <p><b>税込み・税抜き</b><br>
      請求先ごとに決められます（最初は税込み）。メニュー「請求先」から変えてください。</p>

      <p><b>PDFで保存するには</b><br>
      Android：印刷画面のプリンター選択で「PDFとして保存」。<br>
      iPhone：印刷画面のプレビューを2本指で広げる → 共有ボタン → 「ファイルに保存」。<br>
      パソコン：印刷先で「PDFに保存」。</p>

      <p><b>データについて</b><br>
      入力した内容はこの端末の中だけに保存され、どこにも送信されません。そのぶん端末を変えると引き継がれないので、
      メニューの「バックアップ」でときどき書き出しておいてください。</p>

      <p><b>単価を変えたとき</b><br>
      項目の単価を変えると、入力済みの日にも反映するかどうかを聞かれます。発行した請求書は変わりません。</p>
      </div>`;
  });
}

/* =========================================================
   起動
   ========================================================= */
renderMain();

if (!data.clients.length && !data.items.length) {
  setTimeout(() => {
    if (confirm('はじめに、請求先を1件登録しましょう。\n（自分の情報や項目はあとからメニューで登録できます）')) openClientEdit(null);
  }, 300);
}

try {
  const lastVer = localStorage.getItem(KEY_VER);
  if (lastVer && lastVer !== APP_VER) setTimeout(() => toast(`ver ${APP_VER} に更新しました`), 400);
  localStorage.setItem(KEY_VER, APP_VER);
} catch (_) {}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
