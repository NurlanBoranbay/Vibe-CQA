/* CQA core: API client, safe templating, router, layout, roles, shared helpers.
   Plain ES2020, no build step: the same files can be packaged as a Dynamics 365 web resource. */
(function () {
  'use strict';
  const CQA = (window.CQA = { pages: {}, actions: {}, state: {} });
  const cfg = window.CQA_CONFIG || {};

  /* ---------------- safe HTML templating ---------------- */
  const RAW = Symbol('raw');
  const raw = (s) => ({ [RAW]: String(s == null ? '' : s) });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const part = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(part).join('') : v && v[RAW] !== undefined ? v[RAW] : esc(v));
  /** Tagged template: every interpolation is escaped unless it is html`` or raw(). */
  function html(strings, ...vals) {
    let out = '';
    strings.forEach((s, i) => { out += s; if (i < vals.length) out += part(vals[i]); });
    return raw(out);
  }
  const toStr = (h) => part(h);
  Object.assign(CQA, { html, raw, esc, toStr });

  /* ---------------- API ---------------- */
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch((cfg.apiBase || '') + path, init); } catch (e) { throw new Error('Сервис недоступен: ' + e.message); }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) {
      const d = data && data.detail;
      throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => x.msg).join('; ') : `HTTP ${r.status}`);
    }
    return data;
  }
  CQA.api = api;
  CQA.apiUrl = (p) => (cfg.apiBase || '') + p;

  /* ---------------- icons (inline stroke SVG) ---------------- */
  const P = {
    dialogs: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    evals: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    appeals: '<path d="M12 3l9 4-9 4-9-4z"/><path d="M5 10v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
    checklist: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    analytics: '<path d="M5 20V12M12 20V5M19 20v-6"/>',
    accuracy: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
    prompt: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
    sparkle: '<path d="M12 5.5l1.8 4.7 4.7 1.8-4.7 1.8L12 18.5l-1.8-4.7-4.7-1.8 4.7-1.8z"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    audio: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
    run: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    menu: '<path d="M4 8h16M4 16h16"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
  };
  const icon = (name, size = 18, label) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${P[name] || ''}</svg>`);
  CQA.icon = icon;

  /* ---------------- formatting ---------------- */
  const fmt = {
    num: (v, d = 1) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 })),
    pct: (v, d = 1) => (v == null || isNaN(v) ? '—' : `${fmt.num(v * 100, d)}%`),
    score: (v) => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`),
    date: (ts) => (ts ? new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
    mmss: (sec) => { sec = Math.max(0, Math.round(sec || 0)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; },
    usd: (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`),
  };
  CQA.fmt = fmt;
  const scoreTone = (v) => (v == null ? '' : v >= 85 ? 'ok' : v >= 60 ? 'warn' : 'danger');
  CQA.scoreTone = scoreTone;
  CQA.scoreHtml = (v) => html`<span class="score ${scoreTone(v)}">${v == null ? '—' : fmt.score(v)}</span>`;

  const LANG = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };
  CQA.langName = (l) => LANG[l] || l || '—';
  CQA.channelName = (c) => (c && c.toLowerCase().includes('call') ? 'Звонок' : 'Чат');
  const SPEAKER = { operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' };
  CQA.speakerName = (s) => SPEAKER[s] || s;

  /* ---------------- answers ---------------- */
  /** fraction of a criterion's weight earned by an answer (null = N/A) */
  CQA.fraction = (c, a) => {
    if (a === 'na' || a == null) return null;
    if (c.type === 'binary') return a === 'yes' ? 1 : 0;
    const s = c.scale || { min: 0, max: 2 };
    return s.max > s.min ? (Number(a) - s.min) / (s.max - s.min) : 1;
  };
  /** label + tone for an answer, aware of critical criteria where "yes" can mean a violation */
  CQA.answerView = (c, a) => {
    if (a === 'na' || a == null) return { label: 'N/A', tone: 'na' };
    if (c.critical) {
      const flagged = a === (c.flag_on || 'no');
      return flagged ? { label: 'Нарушение', tone: 'danger' } : { label: 'Нет нарушений', tone: 'ok' };
    }
    if (c.type === 'binary') return a === 'yes' ? { label: 'Да', tone: 'ok' } : { label: 'Нет', tone: 'danger' };
    const f = CQA.fraction(c, a);
    return { label: `${a} из ${c.scale.max}`, tone: f >= 1 ? 'ok' : f <= 0 ? 'danger' : 'warn' };
  };
  /** every answer a reviewer may choose for a criterion */
  CQA.answerOptions = (c) => {
    let opts;
    if (c.type === 'binary') opts = ['yes', 'no'];
    else {
      const s = c.scale || { min: 0, max: 2 };
      opts = s.steps && s.steps.length ? s.steps.slice() : Array.from({ length: s.max - s.min + 1 }, (_, i) => s.min + i);
      opts.sort((x, y) => y - x);
    }
    if (c.na_allowed) opts.push('na');
    return opts.map((v) => ({ value: v, label: CQA.answerView(c, v).label }));
  };

  /* ---------------- checklist cache ---------------- */
  const clCache = {};
  CQA.checklist = async (id = 'official', version) => {
    const k = `${id}@${version || 'latest'}`;
    if (!clCache[k]) clCache[k] = api(`/checklists/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`).catch((e) => { delete clCache[k]; throw e; });
    return clCache[k];
  };
  CQA.dropChecklistCache = () => Object.keys(clCache).forEach((k) => delete clCache[k]);

  /* ---------------- roles (demo: no auth, switch in the sidebar) ---------------- */
  const ROLES = {
    operator: { name: 'Оператор', can: ['appeal'] },
    reviewer: { name: 'Проверяющий', can: ['decide', 'evaluate'] },
    methodologist: { name: 'Методолог', can: ['decide', 'evaluate', 'edit_checklist', 'view_prompt'] },
    admin: { name: 'Администратор', can: ['decide', 'evaluate', 'edit_checklist', 'view_prompt', 'edit_prompt'] },
  };
  CQA.ROLES = ROLES;
  CQA.role = () => { try { return localStorage.getItem('cqa.role') || 'reviewer'; } catch (e) { return 'reviewer'; } };
  CQA.can = (perm) => (ROLES[CQA.role()] || ROLES.reviewer).can.includes(perm);
  CQA.isOperator = () => CQA.role() === 'operator';
  CQA.whoCan = (perm) => Object.values(ROLES).filter((r) => r.can.includes(perm)).map((r) => r.name).join(' или ');

  /* ---------------- toasts / modal / tooltip ---------------- */
  /** Enters fast and settles slowly; leaves fast, both sliding toward the bottom (see .toast in CSS). */
  const dismiss = (el) => {
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  /** action: optional { label, run } — e.g. «Вернуть» right after deleting something */
  CQA.toast = (msg, kind = 'ok', ms = 2700, action = null) => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = toStr(html`${kind === 'err' ? icon('alert', 16) : ''}<div>${msg}</div>${action ? html`<button type="button" class="toast-act">${action.label}</button>` : ''}`);
    if (action) el.querySelector('.toast-act').addEventListener('click', () => { action.run(); dismiss(el); });
    // while a modal dialog is open everything outside it is inert, so the toast goes inside the topmost dialog
    const dlg = [...document.querySelectorAll('dialog[open]')].pop();
    let box = document.getElementById('toasts');
    if (dlg) {
      box = dlg.querySelector(':scope > .toasts');
      if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); dlg.appendChild(box); }
    }
    box.appendChild(el);
    [...box.children].filter((t) => !t.classList.contains('out')).slice(0, -2).forEach(dismiss);
    setTimeout(() => dismiss(el), ms);
  };
  /** Small round "i" with a short explanation on hover / keyboard focus. */
  CQA.hint = (text) => html`<span class="hint" tabindex="0" role="note" aria-label="${text}" data-tip="${text}">i</span>`;
  CQA.fail = (e) => CQA.toast(e && e.message ? e.message : String(e), 'err', 7000);

  /** opens a <dialog>; returns {el, close}. body/foot are html`` fragments. */
  /* ---------------- appeal outcome tag (lists, card) ---------------- */
  /** a: {id, status, before, after} or a full appeal ({disputed, decision}); c: the criterion.
      Accepted appeals name the actual change ("Нет → Да", "N/A → Нарушение") instead of a vague "accepted". */
  CQA.appealTag = (a, c) => {
    const before = a.before !== undefined ? a.before : a.disputed && a.disputed.answer;
    const after = a.after !== undefined ? a.after : a.decision && a.decision.answer_after;
    const lbl = (v) => (c ? CQA.answerView(c, v).label : String(v));
    const name = c ? `критерию «${c.title}»` : 'критерию';
    if (a.status === 'pending') return { label: 'На апелляции', short: 'ожидает', tone: 'warn', tip: `Апелляция №${a.id} по ${name} ждёт решения проверяющего` };
    if (a.status === 'changed') return { label: `Исправлено: ${lbl(before)} → ${lbl(after)}`, short: `${lbl(before)} → ${lbl(after)}`, tone: 'ok', tip: `Апелляция №${a.id}: оценка по ${name} исправлена с «${lbl(before)}» на «${lbl(after)}»` };
    return { label: 'Оценка подтверждена', short: 'подтверждена', tone: '', tip: `Апелляция №${a.id}: проверяющий подтвердил оценку ИИ «${lbl(before)}» по ${name}` };
  };

  /* ---------------- system prompts (shared by checklists, prompts, card) ---------------- */
  CQA.promptTitles = { strict: 'Строгий', soft: 'По смыслу' };
  CQA.loadPrompts = async () => {
    const list = await api('/prompts');
    list.forEach((p) => { CQA.promptTitles[p.id] = p.title || p.id; });
    return list;
  };
  /** "soft v2" → "По смыслу · v2" (old evaluations without a label used the built-in strict prompt) */
  CQA.promptLabel = (label) => {
    const [id, v] = String(label || 'strict v1').split(' ');
    return `${CQA.promptTitles[id] || id}${v ? ` · ${v}` : ''}`;
  };
  /** The exact system message the model receives for this checklist (unsaved edits included). */
  CQA.showPrompt = async (checklist, promptId) => {
    const r = await api('/prompts/render', { method: 'POST', body: { checklist, prompt_id: promptId || checklist.prompt_id } });
    CQA.modal({
      title: `Системный промпт · ${r.title} · v${r.version}`,
      wide: true,
      body: html`<p class="muted small" style="margin:0 0 10px">Язык пояснений и «Контекст для модели» берутся из чек-листа</p>
        <pre class="prompt-text">${r.text}</pre>`,
      foot: html`<button class="btn" data-act="copy-prompt" type="button">${icon('copy', 16)}Копировать</button><button class="btn primary" value="cancel">Закрыть</button>`,
    });
  };
  CQA.actions['copy-prompt'] = (el) => {
    const t = el.closest('dialog').querySelector('.prompt-text').textContent;
    navigator.clipboard.writeText(t).then(() => CQA.toast('Скопировано'), () => CQA.toast('Не удалось скопировать', 'err'));
  };

  /* ---------------- form validation: red field + short message instead of the browser bubble ---------------- */
  const fieldMsg = (el) => {
    const v = el.validity;
    if (v.valueMissing) return el.type === 'file' ? 'Выберите файл' : 'Обязательное поле';
    if (v.patternMismatch) return el.getAttribute('title') || 'Неверный формат';
    if (v.typeMismatch) return 'Неверный формат';
    return el.validationMessage;
  };
  const markInvalid = (el, msg) => {
    const box = el.closest('.field') || el.parentElement;
    el.classList.add('invalid');
    el.setAttribute('aria-invalid', 'true');
    let m = box.querySelector(':scope > .field-err');
    if (!m) { m = document.createElement('span'); m.className = 'field-err'; m.id = `${el.id || el.name}-err`; box.appendChild(m); }
    m.textContent = msg;
    el.setAttribute('aria-describedby', m.id);
  };
  const clearInvalid = (el) => {
    if (!el.classList || !el.classList.contains('invalid')) return;
    el.classList.remove('invalid');
    el.removeAttribute('aria-invalid');
    const box = el.closest('.field') || el.parentElement;
    const m = box && box.querySelector(':scope > .field-err');
    if (m) m.remove();
  };
  CQA.markInvalid = markInvalid;
  let firstInvalidAt = 0;
  document.addEventListener('invalid', (e) => {
    e.preventDefault();                       // no native bubble
    markInvalid(e.target, fieldMsg(e.target));
    if (Date.now() - firstInvalidAt > 300) { firstInvalidAt = Date.now(); e.target.focus(); }
  }, true);
  for (const t of ['input', 'change']) document.addEventListener(t, (e) => { if (e.target.validity && e.target.validity.valid) clearInvalid(e.target); }, true);

  /* ---------------- file picker: styled button + chosen file name ---------------- */
  CQA.filePick = ({ id, name, accept, label = 'Выбрать файл' }) => html`<label class="file-pick">
      <input type="file" id="${id}" name="${name}" ${accept ? raw(`accept="${esc(accept)}"`) : ''} class="file-input">
      <span class="btn secondary sm" aria-hidden="true">${icon('upload', 14)}${label}</span>
      <span class="file-name">Файл не выбран</span></label>`;
  document.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('.file-pick input[type=file]')) return;
    const f = e.target.files && e.target.files[0];
    const n = e.target.closest('.file-pick').querySelector('.file-name');
    n.textContent = f ? `${f.name} · ${Math.max(1, Math.round(f.size / 1024))} КБ` : 'Файл не выбран';
    n.classList.toggle('chosen', !!f);
  });

  /* Click outside any open dialog closes it (through «cancel», so unsaved-changes checks still ask).
     The press must start outside too — a text selection dragged out of the dialog must not close it. */
  const outside = (d, e) => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let pressedOutside = null;
  document.addEventListener('mousedown', (e) => { pressedOutside = e.target.matches && e.target.matches('dialog[open]') && outside(e.target, e) ? e.target : null; });
  document.addEventListener('click', (e) => {
    const d = pressedOutside;
    pressedOutside = null;
    if (!d || e.target !== d || !outside(d, e)) return;
    if (d.dispatchEvent(new Event('cancel', { cancelable: true }))) d.close();
  });


  /* ---------------- date range picker: presets on the left, two months, click start → click end ---------------- */
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const p2 = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const ruDay = (s) => (s ? s.split('-').reverse().join('.') : '');
  const RANGE_PRESETS = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['7', 'За 7 дн.'], ['30', 'За 30 дн.'], ['month', 'Текущий месяц'], ['prevmonth', 'Прошлый месяц'], ['12m', 'За последние 12 месяцев']];
  function presetRange(k) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const back = (n) => { const x = new Date(t); x.setDate(x.getDate() - n); return x; };
    switch (k) {
      case 'today': return [t, t];
      case 'yesterday': return [back(1), back(1)];
      case '7': return [back(6), t];
      case '30': return [back(29), t];
      case 'month': return [new Date(t.getFullYear(), t.getMonth(), 1), t];
      case 'prevmonth': return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
      case '12m': { const x = new Date(t); x.setFullYear(x.getFullYear() - 1); x.setDate(x.getDate() + 1); return [x, t]; }
      default: return null;
    }
  }
  /** name → hidden inputs <name>_from / <name>_to (YYYY-MM-DD); onInput is fired on <name>_from after every change */
  CQA.dateRange = ({ name, from = '', to = '', onInput }) => html`<div class="dr">
      <input type="hidden" name="${name}_from" value="${from}" ${onInput ? raw(`data-on-input="${esc(onInput)}"`) : ''}>
      <input type="hidden" name="${name}_to" value="${to}">
      <button type="button" class="dr-field" data-act="dr-open" aria-haspopup="dialog" aria-expanded="false" aria-label="Период">
        ${icon('calendar', 16)}<span class="dr-v ${from ? '' : 'ph'}">${from ? ruDay(from) : 'Дата с'}</span><span class="dr-sep">—</span><span class="dr-v ${to ? '' : 'ph'}">${to ? ruDay(to) : 'Дата по'}</span>
        ${from || to ? html`<span class="dr-x" data-act="dr-clear" role="button" aria-label="Очистить период">${icon('x', 12)}</span>` : ''}</button></div>`;
  let dr = null;   // { root, from, to, view: Date (first day of the left month) }
  function drMonth(y, m) {
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;
    const today = isoDay(new Date());
    const end = dr.to || dr.hover || '';
    const days = Array.from({ length: 42 }, (_, i) => new Date(y, m, 1 - lead + i));
    return html`<div class="dr-month"><div class="dr-title">${y} ${MONTHS[m]}</div>
      <div class="dr-grid">${WD.map((w) => html`<span class="dr-wd">${w}</span>`)}${days.map((d) => {
        const k = isoDay(d);
        const lo = dr.from && end && end < dr.from ? end : dr.from, hi = dr.from && end && end < dr.from ? dr.from : end;
        const cls = [d.getMonth() !== m ? 'out' : '', k === today ? 'today' : '', lo && hi && k > lo && k < hi ? 'in' : '',
          k === dr.from || k === dr.to ? 'edge' : ''].filter(Boolean).join(' ');
        return html`<button type="button" class="dr-day ${cls}" data-act="dr-day" data-d="${k}" aria-label="${ruDay(k)}">${d.getDate()}</button>`;
      })}</div></div>`;
  }
  function drPop() {
    const v = dr.view, next = new Date(v.getFullYear(), v.getMonth() + 1, 1);
    return html`<div class="dr-in">
      <div class="dr-presets">${RANGE_PRESETS.map(([k, l]) => html`<button type="button" data-act="dr-preset" data-k="${k}">${l}</button>`)}
        <button type="button" class="dr-clear" data-act="dr-preset" data-k="clear">Очистить</button></div>
      <div class="dr-cal">
        <div class="dr-nav"><button type="button" data-act="dr-nav" data-n="-12" aria-label="Год назад">«</button><button type="button" data-act="dr-nav" data-n="-1" aria-label="Месяц назад">‹</button>
          <span class="grow"></span><button type="button" data-act="dr-nav" data-n="1" aria-label="Месяц вперёд">›</button><button type="button" data-act="dr-nav" data-n="12" aria-label="Год вперёд">»</button></div>
        <div class="dr-months">${drMonth(v.getFullYear(), v.getMonth())}${drMonth(next.getFullYear(), next.getMonth())}</div>
        <div class="dr-hint">${dr.from && !dr.to ? `С ${ruDay(dr.from)} — выберите дату окончания` : 'Выберите дату начала'}</div>
      </div></div>`;
  }
  const drPaint = () => { if (pop && dr) pop.el.innerHTML = toStr(drPop()); };
  function drCommit(from, to) {
    const root = dr.root;
    const [a, b] = from && to && to < from ? [to, from] : [from, to];
    const fi = root.querySelector('input[name$="_from"]'), ti = root.querySelector('input[name$="_to"]');
    fi.value = a || ''; ti.value = b || '';
    const btn = root.querySelector('.dr-field');
    const vs = btn.querySelectorAll('.dr-v');
    vs[0].textContent = a ? ruDay(a) : 'Дата с'; vs[0].classList.toggle('ph', !a);
    vs[1].textContent = b ? ruDay(b) : 'Дата по'; vs[1].classList.toggle('ph', !b);
    let x = btn.querySelector('.dr-x');                 // ✕ shows only while a period is set
    if ((a || b) && !x) btn.insertAdjacentHTML('beforeend', toStr(html`<span class="dr-x" data-act="dr-clear" role="button" aria-label="Очистить период">${icon('x', 12)}</span>`));
    if (!a && !b && x) x.remove();
    closePop(true);
    dr = null;
    fi.dispatchEvent(new Event('input', { bubbles: true }));
  }
  CQA.actions['dr-open'] = (el, e) => {
    if (e.target.closest('[data-act="dr-clear"]')) return;
    if (pop && pop.anchor === el) { closePop(); dr = null; return; }
    const root = el.closest('.dr');
    const from = root.querySelector('input[name$="_from"]').value, to = root.querySelector('input[name$="_to"]').value;
    const base = from ? new Date(`${from}T00:00:00`) : new Date();
    dr = { root, from, to, view: new Date(base.getFullYear(), base.getMonth(), 1) };
    openPop(el, drPop(), 'dr-pop');
  };
  CQA.actions['dr-day'] = (el) => {
    const d = el.dataset.d;
    if (!dr.from || dr.to) { dr.from = d; dr.to = ''; dr.hover = ''; drPaint(); return; }
    drCommit(dr.from, d);
  };
  CQA.actions['dr-nav'] = (el) => { dr.view = new Date(dr.view.getFullYear(), dr.view.getMonth() + Number(el.dataset.n), 1); drPaint(); };
  CQA.actions['dr-preset'] = (el) => {
    if (el.dataset.k === 'clear') return drCommit('', '');
    const [a, b] = presetRange(el.dataset.k);
    drCommit(isoDay(a), isoDay(b));
  };
  CQA.actions['dr-clear'] = (el) => {
    dr = { root: el.closest('.dr') };
    drCommit('', '');
  };
  // hover preview of the range while the end date is being chosen
  document.addEventListener('mouseover', (e) => {
    if (!dr || !dr.from || dr.to || !e.target.closest) return;
    const day = e.target.closest('.dr-day');
    if (day && day.dataset.d !== dr.hover) { dr.hover = day.dataset.d; drPaint(); }
  });

  CQA.modal = ({ title, body, foot, onSubmit, wide }) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    if (wide) d.style.width = 'min(820px, calc(100vw - 32px))';
    d.innerHTML = toStr(html`<form method="dialog" class="modal-form">
      <div class="modal-head"><h2>${title}</h2><button class="btn ghost sm icon" value="cancel" aria-label="Закрыть">${icon('x', 16)}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? html`<div class="modal-foot">${foot}</div>` : ''}
    </form>`);
    document.body.appendChild(d);
    // ✕ and «Отмена» must close the dialog even when required fields are empty
    d.querySelectorAll('button[value="cancel"]').forEach((b) => { b.formNoValidate = true; });
    const close = () => { d.close(); d.remove(); };
    d.addEventListener('close', () => d.remove());
    d.querySelector('form').addEventListener('submit', async (ev) => {
      const btn = ev.submitter;
      if (!btn || btn.value === 'cancel' || !onSubmit) return;
      ev.preventDefault();
      btn.disabled = true;
      const old = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>' + old;
      try { const keep = await onSubmit(new FormData(ev.target), d, btn.value); if (!keep) close(); }
      catch (e) { CQA.fail(e); }
      finally { if (d.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
    });
    d.showModal();
    return { el: d, close };
  };

  const tip = () => document.getElementById('tooltip');
  const showTip = (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    const el = tip();
    if (!t) { el.hidden = true; return; }
    el.textContent = t.getAttribute('data-tip');
    el.hidden = false;
    const r = t.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)) + 'px';
    el.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
  };
  document.addEventListener('mouseover', showTip);
  document.addEventListener('focusin', showTip);
  document.addEventListener('focusout', () => { tip().hidden = true; });

  /* ---------------- event delegation ---------------- */
  // Elements carry data-act="name"; pages register CQA.actions[name] = (el, event) => ...
  // A quick second click after picking from a dropdown lands on whatever was under the list — often a
  // clickable table row. For a moment after a dropdown closes, clicks on rows (and links in them) are ignored,
  // so nobody «falls into» a call by accident.
  let popClosedAt = 0;
  document.addEventListener('click', (e) => {
    if (Date.now() - popClosedAt > 450 || !e.target.closest || !e.target.closest('tr.click, tr[data-act]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  for (const type of ['click', 'change', 'input', 'submit']) {
    document.addEventListener(type, (e) => {
      const el = e.target.closest(`[data-${type === 'click' ? 'act' : 'on-' + type}]`);
      if (!el) return;
      const name = el.getAttribute(type === 'click' ? 'data-act' : 'data-on-' + type);
      const fn = CQA.actions[name];
      if (!fn) return;
      if (type === 'submit' || (type === 'click' && el.tagName === 'A' && el.getAttribute('href') === '#')) e.preventDefault();
      Promise.resolve(fn(el, e)).catch(CQA.fail);
    });
  }

  /* ---------------- router ---------------- */
  CQA.route = (name, page) => { CQA.pages[name] = page; };
  CQA.parseHash = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || '', args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
  };
  CQA.go = (hash) => { if (location.hash === hash) render(true); else location.hash = hash; };
  let current = null, renderSeq = 0;
  async function render(force) {
    const r = CQA.parseHash();
    if (r.name === 'dialogs') { location.replace('#/new?tab=done'); return; }   // the former «Все диалоги»
    if (!CQA.pages[r.name] || !CQA.allowed(r.name)) { if (location.hash !== CQA.home()) location.replace(CQA.home()); return; }
    const page = CQA.pages[r.name];
    const view = document.getElementById('view');
    const samePage = current && current.page === page && current.key === r.name + '/' + r.args.join('/');
    // same card, new ?t=: just jump inside the page instead of re-rendering
    if (!force && samePage && page.onQuery) { current.query = r.query; page.onQuery(r.query); return; }
    const seq = ++renderSeq;
    if (current && current.page.leave) current.page.leave();
    current = { page, key: r.name + '/' + r.args.join('/'), query: r.query };
    renderNav(r.name);
    closePop();
    toggleSide(false);
    const slot = document.getElementById('head-slot');
    if (!samePage) slot.innerHTML = toStr(html`<h1>${page.title}</h1>`);
    if (!samePage) view.innerHTML = toStr(html`<div class="stack"><div class="skel" style="height:120px"></div><div class="skel" style="height:320px"></div></div>`);
    try {
      const out = await page.render(r);
      if (seq !== renderSeq) return;
      view.innerHTML = toStr(out);
      // The page's own header (title + actions) is shown in the top bar, next to theme and account.
      const head = view.querySelector(':scope > .page-head');
      if (head) { slot.replaceChildren(...head.childNodes); head.remove(); }
      else slot.innerHTML = toStr(html`<h1>${page.title}</h1>`);
      document.title = `${page.title} · CQA`;
      if (!samePage) window.scrollTo(0, 0);
      if (page.mounted) page.mounted(r);
    } catch (e) {
      if (seq !== renderSeq) return;
      view.innerHTML = toStr(html`<div class="card danger"><div class="empty"><span class="ico">${icon('alert', 24)}</span><b>Не удалось загрузить</b><span>${e.message}</span>
        <button class="btn secondary" data-act="reload">Повторить</button></div></div>`);
    }
    refreshCounts();
  }
  CQA.render = () => render(true);
  CQA.actions.reload = () => render(true);

  /* ---------------- layout ---------------- */
  // roles: who sees the module (none = everyone except the operator)
  const NAV = [
    { name: 'me', label: 'Моя статистика', icon: 'analytics', roles: ['operator'] },
    { name: 'new', label: 'Диалоги', icon: 'dialogs', count: 'newDialogs', countLabel: 'новых без оценки' },
    { name: 'evaluations', label: 'Оценки', opLabel: 'Мои звонки', icon: 'evals', roles: ['operator', 'reviewer', 'methodologist', 'admin'] },
    { name: 'appeals', label: 'Апелляции', opLabel: 'Мои апелляции', icon: 'appeals', count: 'pendingAppeals', roles: ['operator', 'reviewer', 'methodologist', 'admin'] },
    { name: 'runs', label: 'Прогоны', icon: 'run', count: 'activeRuns', countLabel: 'идёт' },
    { name: 'checklists', label: 'Чек-листы', icon: 'checklist' },
    { name: 'prompts', label: 'Системные промпты', icon: 'prompt', roles: ['methodologist', 'admin'] },
    { name: 'analytics', label: 'Аналитика качества', icon: 'analytics' },
    { name: 'models', label: 'Модели и ключи', icon: 'key', roles: ['admin'] },
    { name: 'accuracy', label: 'Точность ИИ', icon: 'accuracy' },
  ];
  const ACTIVE = { eval: 'evaluations', appeal: 'appeals' };
  const navFor = (role) => NAV.filter((n) => (n.roles ? n.roles.includes(role) : role !== 'operator'));
  /** Can the current role open this route? (cards and appeal pages follow their module) */
  CQA.allowed = (name) => navFor(CQA.role()).some((n) => n.name === (ACTIVE[name] || name));
  CQA.home = () => `#/${navFor(CQA.role())[0].name}`;
  const ROLE_INFO = {
    operator: { initials: 'ОП', d: 'Свои оценки и апелляции' },
    reviewer: { initials: 'ПР', d: 'Решает апелляции, запускает оценку' },
    methodologist: { initials: 'МТ', d: 'Плюс чек-листы и выбор промпта' },
    admin: { initials: 'АД', d: 'Плюс промпты, модели и ключи' },
  };
  /** Left sidebar: modules only. */
  function renderNav(active) {
    active = ACTIVE[active] || active;
    document.getElementById('side').innerHTML = toStr(html`
      <a class="brand" href="${CQA.home()}"><span class="brand-mark">${icon('sparkle', 16)}</span><span class="brand-txt"><b>CQA</b><small>Контроль качества</small></span></a>
      <div class="side-label">Модули</div>
      ${navFor(CQA.role()).map((n) => html`<a class="side-link" href="#/${n.name}" ${active === n.name ? raw('aria-current="page"') : ''}>${icon(n.icon, 18)}<span>${CQA.isOperator() && n.opLabel ? n.opLabel : n.label}</span>
        ${n.count && CQA.state[n.count] ? html`<span class="nav-count" aria-label="${CQA.state[n.count]} ${n.countLabel || 'ожидают решения'}">${CQA.state[n.count]}</span>` : ''}</a>`)}`);
    renderTools();
    renderFoot();
  }
  /** Top-right utilities: theme, account (role). Page actions sit just left of them. */
  function renderTools() {
    const theme = document.documentElement.dataset.theme || 'light';
    const role = CQA.role();
    document.getElementById('tools').innerHTML = toStr(html`
      <button class="icon-btn" data-act="toggle-theme" aria-label="${theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}" title="${theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}">${icon(theme === 'dark' ? 'sun' : 'moon', 18)}</button>
      <button class="account-btn" id="account-btn" data-act="account" aria-haspopup="menu" aria-expanded="false">
        <span class="avatar ${role}" aria-hidden="true">${ROLE_INFO[role].initials}</span><span class="who">${ROLES[role].name}</span><span class="chev-d">${icon('down', 14)}</span></button>`);
    const mb = document.querySelector('.menu-btn');
    if (mb && !mb.firstChild) mb.innerHTML = toStr(icon('menu', 20));
  }
  function renderFoot() {
    if (!document.getElementById('foot')) return;
    const h = CQA.state.health;
    document.getElementById('foot').innerHTML = toStr(html`
      <span>CQA · Conversation Quality Analytics</span>
      <span>Модель оценки: ${h ? html`${h.provider.split(':').pop()} · ${h.strategy} · расход сессии $${Number(h.spent_usd).toFixed(4)}` : '…'}</span>`);
  }

  /* ---------------- popovers (account menu, dropdowns) ---------------- */
  let pop = null;
  function closePop(focusBack) {
    if (!pop) return;
    const { el, anchor } = pop;
    popClosedAt = Date.now();
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    pop = null;
    if (focusBack) anchor.focus();
  }
  function openPop(anchor, inner, cls, align = 'left') {
    closePop();
    const el = document.createElement('div');
    el.className = `popover ${cls}`;
    el.innerHTML = toStr(inner);
    (anchor.closest('dialog[open]') || document.body).appendChild(el);   // inside a modal dialog's top layer
    const r = anchor.getBoundingClientRect();
    const w = Math.max(el.offsetWidth, cls.includes('dd-pop') ? r.width : 0);
    el.style.minWidth = cls.includes('dd-pop') ? `${r.width}px` : '';
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom;
    const h = el.offsetHeight;
    el.style.left = `${left}px`;
    el.style.top = `${below < h + 12 && r.top > h + 12 ? r.top - h - 6 : r.bottom + 6}px`;
    anchor.setAttribute('aria-expanded', 'true');
    pop = { el, anchor };
    return el;
  }
  document.addEventListener('click', (e) => {
    if (pop && e.target.isConnected && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePop();
    const side = document.getElementById('side');
    if (side.classList.contains('open') && !side.contains(e.target) && !e.target.closest('.menu-btn')) toggleSide(false);
  });
  window.addEventListener('resize', () => closePop());
  document.addEventListener('scroll', (e) => { if (pop && !pop.el.contains(e.target)) closePop(); }, true);
  document.addEventListener('keydown', (e) => {
    if (!pop) { if (e.key === 'Escape') toggleSide(false); return; }
    const items = [...pop.el.querySelectorAll('[role=option],[role=menuitemradio]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closePop(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') closePop();
  });
  function toggleSide(open) {
    const side = document.getElementById('side');
    side.classList.toggle('open', open);
    const mb = document.querySelector('.menu-btn');
    if (mb) mb.setAttribute('aria-expanded', String(open));
  }
  CQA.actions.menu = (el, e) => { e.stopPropagation(); toggleSide(!document.getElementById('side').classList.contains('open')); };

  CQA.actions.account = (el) => {
    if (pop && pop.anchor === el) return closePop();
    const role = CQA.role();
    const m = openPop(el, html`<div role="menu" aria-label="Роль">
      <h3>Войти как (демо, без пароля)</h3>
      ${Object.entries(ROLES).map(([k, r]) => html`<button class="menu-item" role="menuitemradio" aria-checked="${k === role}" data-act="set-role" data-role="${k}">
        <span class="avatar ${k}" aria-hidden="true">${ROLE_INFO[k].initials}</span><span><b>${r.name}</b><span class="d">${ROLE_INFO[k].d}</span></span>
        <span class="tick">${k === role ? icon('check', 16) : ''}</span></button>`)}</div>`, 'account-pop', 'right');
    (m.querySelector('[aria-checked="true"]') || m.querySelector('.menu-item')).focus();
  };

  /**
   * Styled dropdown that replaces <select>. A hidden input carries name/value for forms and fires a bubbling
   * "change" event, so form handlers and data-on-change handlers work exactly as with a native select.
   *   CQA.dd({ name, value, options: [{value, label}] | [value], onChange, data: {k: 'lang'}, label, id, size: 'sm', full })
   */
  CQA.dd = (o) => {
    const opts = (o.options || []).map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));
    const cur = opts.find((x) => String(x.value) === String(o.value)) || opts[0] || { value: '', label: '' };
    const data = Object.entries(o.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
    return html`<div class="dd ${o.size || ''} ${o.full ? 'full' : ''} ${o.cls || ''}">
      <input type="hidden" ${o.name ? raw(`name="${esc(o.name)}"`) : ''} value="${cur.value}" ${o.onChange ? raw(`data-on-change="${esc(o.onChange)}"`) : ''}${raw(data)}>
      <button type="button" class="dd-btn" ${o.id ? raw(`id="${esc(o.id)}"`) : ''} data-act="dd-open" aria-haspopup="listbox" aria-expanded="false" ${o.label ? raw(`aria-label="${esc(o.label)}: ${esc(cur.label)}"`) : ''}
        title="${cur.label}" data-opts="${JSON.stringify(opts)}" data-label="${o.label || ''}"><span class="dd-val">${cur.label}</span>${icon('down', 14)}</button></div>`;
  };
  CQA.actions['dd-open'] = (btn) => {
    if (pop && pop.anchor === btn) return closePop();
    const opts = JSON.parse(btn.dataset.opts);
    const val = btn.parentElement.querySelector('input').value;
    const el = openPop(btn, html`<div role="listbox" aria-label="${btn.dataset.label || ''}">${opts.map((x) => html`
      <button type="button" class="dd-opt" role="option" aria-selected="${String(x.value) === val}" data-act="dd-pick" data-v="${x.value}">
        <span>${x.label}</span><span class="tick">${String(x.value) === val ? icon('check', 16) : ''}</span></button>`)}</div>`, 'dd-pop');
    (el.querySelector('[aria-selected="true"]') || el.querySelector('.dd-opt')).focus();
  };
  CQA.actions['dd-pick'] = (opt) => {
    if (!pop) return;
    const btn = pop.anchor;
    const input = btn.parentElement.querySelector('input');
    const opts = JSON.parse(btn.dataset.opts);
    const x = opts.find((o) => String(o.value) === opt.dataset.v);
    closePop(true);
    if (!x || String(x.value) === input.value) return;
    input.value = x.value;
    btn.querySelector('.dd-val').textContent = x.label;
    if (btn.dataset.label) btn.setAttribute('aria-label', `${btn.dataset.label}: ${x.label}`);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  async function refreshCounts() {
    try {
      const [pending, health] = await Promise.all([api('/appeals?status=pending'), CQA.state.health ? null : api('/health')]);
      const n = pending.length;
      if (health) CQA.state.health = health;
      if (CQA.state.newDialogs === undefined && CQA.allowed('new')) {     // badge on «Новые диалоги»
        const rows = await api('/dialogs');
        CQA.state.newDialogs = rows.filter((r) => r.total == null && !CQA.state.runs.pending[r.conversation_id]).length;
        renderNav(CQA.parseHash().name);
      }
      if (n !== CQA.state.pendingAppeals) { CQA.state.pendingAppeals = n; renderNav(CQA.parseHash().name); }
      else if (health) renderFoot();
    } catch (e) { /* nav counts are best-effort */ }
  }
  CQA.refreshCounts = refreshCounts;
  CQA.renderNav = () => renderNav(CQA.parseHash().name);

  /* ---------------- evaluation runs: queue watcher ---------------- */
  CQA.modelName = (m) => {
    const s = String(m || '');
    if (/gemma-4-26b/i.test(s)) return 'Gemma 4 26B-A4B';
    if (/deepseek.*pro/i.test(s)) return 'DeepSeek Pro';
    if (/deepseek/i.test(s)) return 'DeepSeek Flash';
    if (/qwen/i.test(s)) return 'Qwen';
    return s.replace(/@.*$/, '').replace(/\[.*$/, '').replace(/^.*[/:]/, '') || '—';
  };
  CQA.runStatus = (r) => ({
    queued: ['В очереди', 'outline'],
    running: [`Идёт · ${(r.n_done || 0) + (r.n_failed || 0)} из ${r.n_total}`, 'warn'],
    done: r.n_failed ? [`Готов · ошибок ${r.n_failed}`, 'warn'] : ['Готов', 'ok'],
    failed: ['Ошибка', 'danger'],
  }[r.status] || [r.status, 'outline']);
  CQA.duration = (sec) => {
    if (sec == null || sec < 0) return '—';
    sec = Math.round(sec);
    return sec < 60 ? `${sec} с` : sec < 3600 ? `${Math.floor(sec / 60)} мин ${sec % 60} с` : `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`;
  };
  CQA.state.runs = { active: [], pending: {} };      // pending: conversation_id -> 'queued' | 'running'
  let runTimer = null, knownActive = new Set();
  CQA.watchRuns = async () => {
    clearTimeout(runTimer);
    let list;
    try { list = await api('/runs?active=1'); } catch (e) { runTimer = setTimeout(CQA.watchRuns, 5000); return; }
    const pending = {};
    list.forEach((r) => (r.pending_ids || []).forEach((cid) => { pending[cid] = r.status; }));
    const ids = new Set(list.map((r) => r.id));
    const finished = [...knownActive].filter((id) => !ids.has(id));
    knownActive = ids;
    CQA.state.runs = { active: list, pending };
    if (CQA.state.activeRuns !== list.length) { CQA.state.activeRuns = list.length; renderNav(CQA.parseHash().name); }
    finished.forEach((id) => api(`/runs/${id}`).then((r) => CQA.toast(r.status === 'failed'
      ? `Прогон №${id} завершился с ошибкой`
      : `Прогон №${id} готов: ${r.n_done} диал.${r.avg_total != null ? ` · средний итог ${fmt.score(r.avg_total)}` : ''}${r.n_failed ? ` · ошибок ${r.n_failed}` : ''}`,
    r.status === 'done' && !r.n_failed ? 'ok' : 'err', 6000)).catch(() => {}));
    if (finished.length) { CQA.state.newDialogs = undefined; refreshCounts(); }
    if (current && current.page.onRuns) current.page.onRuns(finished.length > 0);
    if (list.length) runTimer = setTimeout(CQA.watchRuns, 2500);
  };

  CQA.actions['set-role'] = (el) => {
    const k = el.dataset.role;
    try { localStorage.setItem('cqa.role', k); } catch (e) {}
    closePop();
    CQA.toast(`Вы вошли как ${ROLES[k].name}`);
    render(true);
    setTimeout(() => { const b = document.getElementById('account-btn'); if (b) b.focus(); });
  };
  CQA.actions['toggle-theme'] = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('cqa.theme', t); } catch (e) {}
    renderTools();
    document.querySelector('[data-act="toggle-theme"]').focus();
  };

  /* ---------------- shared bits ---------------- */
  CQA.empty = (title, text, extra) => html`<div class="empty"><span class="ico">${icon('info', 24)}</span><b>${title}</b>${text ? html`<span>${text}</span>` : ''}${extra || ''}</div>`;
  CQA.objCell = (row) => html`<div class="obj"><b>${row.conversation_id}</b><span>${CQA.channelName(row.channel)} · ${row.language || '—'}${row.turns ? ` · ${row.turns} реплик` : ''}</span></div>`;
  CQA.downloadJson = (obj, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  CQA.start = () => {
    window.addEventListener('hashchange', () => render(false));
    render(true);
    CQA.watchRuns();
  };
})();
