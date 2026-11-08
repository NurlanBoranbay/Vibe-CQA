/* Диалоги (#/new?tab=new|done): one module, two tabs.
   «Новые» — no score yet; «Оценённые» — scored, can be re-evaluated. Import + evaluate live here;
   rows that are being evaluated right now sit on top of their tab. */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.dialogs = { mode: 'new', runs: {}, rows: [], sel: new Set(), q: '', lang: '', channel: '', status: '', checklist: '*', checklists: [], sort: 'time', dir: -1 });
  const isNew = () => S.mode === 'new';

  function statusOf(r) {
    const run = CQA.state.runs.pending[r.conversation_id];
    if (run) return run === 'running' ? 'running' : 'queued';
    if (r.total == null) return 'new';
    return r.appeal_state === 'pending' ? 'appeal' : r.appeal_state === 'decided' ? 'appealed' : 'done';
  }
  const inProgress = (r) => !!CQA.state.runs.pending[r.conversation_id];
  const scope = (mode = S.mode) => S.rows.filter((r) => (mode === 'new' ? r.total == null : r.total != null));
  function filtered() {
    const q = S.q.trim().toLowerCase();
    return scope().filter((r) => (!q || r.conversation_id.toLowerCase().includes(q))
      && (!S.lang || r.language === S.lang)
      && (!S.channel || CQA.channelName(r.channel) === S.channel)
      && (!S.status || statusOf(r) === S.status))
      .sort((a, b) => {
        const live = { running: 2e10, queued: 1e10 };          // in-progress rows sort above every timestamp
        const k = S.sort === 'id' ? (x) => x.conversation_id
          : (x) => live[CQA.state.runs.pending[x.conversation_id]] || (isNew() ? x.imported_at : x.evaluated_at || x.imported_at) || 0;
        return (k(a) > k(b) ? 1 : k(a) < k(b) ? -1 : 0) * S.dir;
      });
  }
  const sortBtn = (k, label) => html`<button class="th-sort" data-act="dlg-sort" data-k="${k}">${label}${S.sort === k ? (S.dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
  // grey = only the AI has looked at it; green = a person has checked it
  const STATUS = { new: ['Не оценён', 'outline'], queued: ['В очереди', 'outline'], running: ['Оценивается', 'warn'],
    done: ['Оценено ИИ', ''], appeal: ['На апелляции', 'warn'], appealed: ['Проверено человеком', 'ok'] };
  const statusPill = (r) => { const k = statusOf(r); const st = STATUS[k]; return html`<span class="pill ${st[1]}">${k === 'running' ? raw('<span class="spinner sm"></span>') : ''}${st[0]}</span>`; };
  const objCell = (r) => html`<span class="row" style="gap:8px;flex-wrap:nowrap">${CQA.objCell({ ...r, turns: 0 })}${r.has_audio ? html`<span class="muted" data-tip="Есть запись разговора">${icon('audio', 14, 'Есть запись')}</span>` : ''}</span>`;
  const canPick = () => CQA.can('evaluate');
  /** «Прогон №3» + model · prompt, links to the run */
  const runCell = (id) => {
    const run = id && S.runs[id];
    if (!id) return html`<span class="muted">—</span>`;
    return html`<a class="run-cell" href="#/runs/${id}"><b>Прогон №${id}</b>${run ? html`<span>${S.checklist === '*' ? `${run.checklist_title || run.checklist_id} · ` : ''}${CQA.modelName(run.model)} · ${CQA.promptTitles[run.prompt_id] || run.prompt_id}</span>` : ''}</a>`;
  };

  function table() {
    const rows = filtered();
    if (!rows.length) {
      if (!scope().length) return isNew()
        ? CQA.empty('Новых диалогов нет', 'Все загруженные диалоги оценены. Загрузите новые — из API организаторов, по ссылке или файлом JSON.',
          canPick() ? html`<button class="btn primary" data-act="dlg-import">${icon('upload', 16)}Загрузить диалоги</button>` : '')
        : CQA.empty('Оценённых диалогов пока нет', 'Оцените диалоги на вкладке «Новые».');
      return CQA.empty('Ничего не найдено', 'Измените фильтры.');
    }
    const pick = rows.filter((r) => !inProgress(r));
    const allSel = pick.length && pick.every((r) => S.sel.has(r.conversation_id));
    const box = (r) => (inProgress(r) ? '' : html`<input type="checkbox" aria-label="Выбрать ${r.conversation_id}" data-act="dlg-one" data-id="${r.conversation_id}" ${S.sel.has(r.conversation_id) ? raw('checked') : ''}>`);
    return html`<div class="table-wrap"><table class="table">
      <thead><tr>
        ${canPick() ? html`<th style="width:40px"><input type="checkbox" aria-label="Выбрать все" data-act="dlg-all" ${allSel ? raw('checked') : ''}></th>` : ''}
        <th>№</th><th>${sortBtn('id', 'Звонок')}</th><th class="num">Реплик</th><th>Статус</th>
        ${isNew() ? html`<th>${sortBtn('time', 'Загружен')}</th>` : html`<th class="num">Итог</th><th>Грубые</th><th>${sortBtn('time', 'Оценён')}</th><th>Прогон</th><th class="row-go-h"></th>`}
      </tr></thead>
      <tbody>${rows.map((r, i) => html`<tr class="click" tabindex="0" data-act="dlg-row" data-id="${r.conversation_id}">
        ${canPick() ? html`<td class="sel-zone">${box(r)}</td>` : ''}
        <td class="muted sel-zone">${i + 1}</td>
        <td>${objCell(r)}</td>
        <td class="num">${r.turns}</td>
        <td>${statusPill(r)}</td>
        ${isNew() ? html`<td class="muted small nowrap">${r.imported_at ? fmt.date(r.imported_at) : '—'}</td>`
          : html`<td class="num">${CQA.scoreHtml(r.total)}</td>
            <td>${r.gross_error ? html`<span class="pill danger">${icon('flag', 12)}выявлены</span>` : html`<span class="muted small">нет</span>`}</td>
            <td class="muted small nowrap">${r.evaluated_at ? fmt.date(r.evaluated_at) : '—'}</td>
            <td>${runCell(r.run_id)}</td><td class="row-go" aria-hidden="true">${icon('back', 14)}</td>`}
      </tr>`)}</tbody></table></div>`;
  }
  function selBar() {
    const n = S.sel.size;
    return html`<button class="btn primary sel-go" id="dlg-eval-btn" data-act="dlg-evaluate" ${n ? '' : raw('disabled')}>${icon('sparkle', 14)}${isNew() ? 'Оценить' : 'Оценить заново'}</button>
      <span class="sel-count ${n ? 'on' : ''}">${n ? html`Выбрано <b>${n}</b>` : isNew() ? 'Отметьте диалоги в таблице' : 'Отметьте диалоги, чтобы оценить их заново'}</span>
      ${n ? html`<button class="btn link" data-act="dlg-clear">Снять выбор</button>` : ''}`;
  }
  function paint() {
    const t = document.getElementById('dlg-table');
    if (t) t.innerHTML = toStr(table());
    const b = document.getElementById('dlg-selbar');
    if (b) b.innerHTML = toStr(selBar());
    const tabs = document.getElementById('dlg-tabs');
    if (tabs) tabs.outerHTML = toStr(tabBar());
  }
  function tabBar() {
    const n = (m) => scope(m).length;
    return html`<div class="tabs" id="dlg-tabs" role="tablist" aria-label="Диалоги">
      ${[['new', 'Новые', 'без оценки'], ['done', 'Оценённые', 'можно оценить заново']].map(([k, l, sub]) => html`<button type="button" role="tab" class="tab" aria-selected="${S.mode === k}" data-act="dlg-tab" data-k="${k}">
        <span class="tab-l">${l}</span><span class="tab-n">${n(k)}</span><span class="tab-sub">${sub}</span></button>`)}</div>`;
  }
  function updateCount() {
    const n = S.rows.filter((r) => r.total == null && !inProgress(r)).length;
    if (CQA.state.newDialogs !== n) { CQA.state.newDialogs = n; CQA.renderNav(); }
  }

  /* ---------- «Расширенный отбор»: which calls to assess — period, operators, how many (N or %), per operator ---------- */
  const DAY = 86400;
  const NO_OP = '__none__';
  const opKey = (r) => r.operator || NO_OP;
  const opName = (k) => (k === NO_OP ? 'Не указан' : k);
  const toDate = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fromDate = (v, end) => (v ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}`).getTime() / 1000 : null);
  S.adv = S.adv || { from: '', to: '', ops: null, mode: 'all', count: 10, pct: 10, perOp: false, order: 'random' };

  /** apply the rule to the rows of the tab (toolbar filters included) */
  function sample(rule) {
    const lo = fromDate(rule.from), hi = fromDate(rule.to, true);
    const pool = filtered().filter((r) => !inProgress(r)
      && (lo == null || (r.call_at || 0) >= lo) && (hi == null || (r.call_at || 0) <= hi)
      && (!rule.ops || rule.ops.includes(opKey(r))));
    const groups = rule.perOp ? Object.values(pool.reduce((m, r) => ((m[opKey(r)] = m[opKey(r)] || []).push(r), m), {})) : [pool];
    const take = (g) => {
      const n = rule.mode === 'all' ? g.length : rule.mode === 'count' ? Math.min(g.length, Math.max(0, Math.floor(rule.count))) : Math.ceil((g.length * Math.max(0, Math.min(100, rule.pct))) / 100);
      const order = rule.order === 'newest' ? g.slice().sort((a, b) => (b.call_at || 0) - (a.call_at || 0)) : g.slice().sort(() => Math.random() - 0.5);
      return order.slice(0, n);
    };
    return { pool, picked: groups.flatMap(take) };
  }
  const ruleText = (r) => [
    r.from || r.to ? `${r.from ? `с ${r.from.split('-').reverse().join('.')}` : ''}${r.to ? ` по ${r.to.split('-').reverse().join('.')}` : ''}` : '',
    r.ops ? `операторов: ${r.ops.length}` : '',
    r.mode === 'count' ? `${r.count} шт.` : r.mode === 'pct' ? `${r.pct}%` : '',
    r.perOp && r.mode !== 'all' ? 'на каждого оператора' : '',
  ].filter(Boolean).join(' · ') || 'все подходящие';

  CQA.actions['dlg-adv'] = () => {
    const rule = { ...S.adv, ops: S.adv.ops ? [...S.adv.ops] : null };
    const seg = (name, items, value) => html`<div class="seg" role="radiogroup">${items.map(([k, l]) => html`<label class="seg-opt"><input type="radio" name="${name}" value="${k}" data-on-change="adv-upd" ${String(value) === k ? raw('checked') : ''}><span>${l}</span></label>`)}</div>`;
    const dlg = CQA.modal({
      title: 'Расширенный отбор',
      wide: true,
      body: html`<p class="muted small" style="margin:0 0 4px">Отмечает звонки на вкладке «${isNew() ? 'Новые' : 'Оценённые'}» по правилу. Фильтры над таблицей тоже учитываются.</p>
        <div class="adv-form">
          <div class="adv-row"><span class="adv-l">Период</span><div class="adv-c">
            ${CQA.dateRange({ name: 'period', from: rule.from, to: rule.to, onInput: 'adv-upd' })}
            <span class="field-hint">Пусто — за всё время. По дате звонка, а если её нет в данных — по времени загрузки</span></div></div>

          <div class="adv-row adv-off"><span class="adv-l">Операторы</span><div class="adv-c">
            <span class="adv-note">${icon('info', 14)}Сейчас в системе один оператор — отбор по операторам недоступен</span></div></div>

          <div class="adv-row"><span class="adv-l">Сколько</span><div class="adv-c">
            ${seg('mode', [['all', 'Все'], ['count', 'Количество'], ['pct', 'Процент']], rule.mode)}
            <div class="row adv-amount" style="gap:8px" ${rule.mode === 'all' ? raw('hidden') : ''}>
              <input type="number" class="input" name="amount" min="1" step="1" style="width:110px" aria-label="Сколько" data-on-input="adv-upd"
                value="${rule.mode === 'pct' ? rule.pct : rule.count}"><span class="muted small adv-unit">${rule.mode === 'pct' ? '% звонков' : 'звонков'}</span>
</div></div></div>

          <div class="adv-row"><span class="adv-l">Какие</span><div class="adv-c">${seg('order', [['random', 'Случайные'], ['newest', 'Сначала новые']], rule.order)}</div></div>
        </div>`,
      foot: html`<button class="btn" type="button" data-act="adv-reset">Сбросить</button><span class="adv-sum" id="adv-sum" role="status"></span><button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">Отметить звонки</button>`,
      onSubmit() {
        const r = readRule(dlg.el);
        const { picked } = sample(r);
        if (!picked.length) { CQA.toast('По этому правилу нет звонков', 'err'); return true; }
        S.adv = r;
        S.sel = new Set(picked.map((x) => x.conversation_id));
        paint();
        CQA.toast(`Отмечено звонков: ${picked.length} · ${ruleText(r)}`, 'ok', 4000);
      },
    });
    S.advPrevMode = rule.mode;
    updateSum(dlg.el);
  };
  /** reads the controls directly (FormData would skip disabled/hidden ones) */
  function readRule(root) {
    const q = (sel) => root.querySelector(sel);
    const val = (name) => (q(`[name=${name}]:checked`) || {}).value;
    const from = q('[name=period_from]').value, to = q('[name=period_to]').value;
    const mode = val('mode') || 'all';
    const amount = Number(q('[name=amount]').value) || 0;
    return { from, to, mode, order: val('order') || 'random', perOp: false, ops: null,   // one operator for now
      count: mode === 'count' ? amount : S.adv.count, pct: mode === 'pct' ? Math.min(100, amount) : S.adv.pct };
  }
  function updateSum(root) {
    const mode = (root.querySelector('[name=mode]:checked') || {}).value;
    const amt = root.querySelector('[name=amount]');
    if (mode !== S.advPrevMode) {                       // switching Количество ↔ Процент swaps the remembered value
      if (mode === 'pct') amt.value = S.adv.pct || 10;
      if (mode === 'count') amt.value = S.adv.count || 10;
      S.advPrevMode = mode;
    }
    root.querySelector('.adv-amount').hidden = mode === 'all';
    root.querySelector('.adv-unit').textContent = mode === 'pct' ? '% звонков' : 'звонков';
    amt.max = mode === 'pct' ? 100 : '';
    const r = readRule(root);
    const { pool, picked } = sample(r);
    root.querySelector('#adv-sum').innerHTML = CQA.toStr(html`Подходит <b>${pool.length}</b> · будет отмечено <b>${picked.length}</b>`);
  }
  CQA.actions['adv-upd'] = (el) => updateSum(el.closest('dialog'));
  CQA.actions['adv-reset'] = (el) => {
    S.adv = { from: '', to: '', ops: null, mode: 'all', count: 10, pct: 10, perOp: false, order: 'random' };
    el.closest('dialog').close();
    CQA.actions['dlg-adv']();
  };

  CQA.actions['dlg-sort'] = (el) => { const k = el.dataset.k; S.dir = S.sort === k ? -S.dir : (k === 'time' ? -1 : 1); S.sort = k; paint(); };
  /** whole row: evaluated → open its card; new → tick it (checkbox, links and buttons keep their own action) */
  CQA.actions['dlg-row'] = (el, e) => {
    if (e.target.closest('a, button, input, label')) return;
    const r = S.rows.find((x) => x.conversation_id === el.dataset.id);
    if (!r) return;
    const toggle = () => { if (canPick() && !inProgress(r)) { S.sel.has(r.conversation_id) ? S.sel.delete(r.conversation_id) : S.sel.add(r.conversation_id); paint(); } };
    // checkbox, № and Объект are a selection zone: a missed checkbox must never throw away the selection
    if (e.target.closest && e.target.closest('.sel-zone')) return toggle();
    if (r.total != null) return CQA.go(`#/eval/${encodeURIComponent(r.conversation_id)}?cl=${encodeURIComponent(r.checklist_id || S.checklist)}`);
    toggle();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('tr[data-act="dlg-row"]')) return;
    CQA.actions['dlg-row'](e.target, e);
  });
  CQA.actions['dlg-tab'] = (el) => CQA.go(`#/new?tab=${el.dataset.k}`);

  CQA.route('new', {
    title: 'Диалоги',
    onRuns(finished) { if (finished) CQA.render(); else { paint(); updateCount(); } },
    async render(r) {
      const mode = r.query.tab === 'done' ? 'done' : 'new';
      if (S.mode !== mode) { S.mode = mode; S.status = ''; S.sel.clear(); }
      if (r.query.cl) S.checklist = r.query.cl;
      const [rows, cls, runs] = await Promise.all([api(`/dialogs?checklist_id=${encodeURIComponent(S.checklist)}`), api('/checklists'),
        api(S.checklist === '*' ? '/runs' : `/runs?checklist_id=${encodeURIComponent(S.checklist)}`).catch(() => [])]);
      S.runs = Object.fromEntries(runs.map((x) => [x.id, x]));
      S.rows = rows;
      S.checklists = cls;
      S.sel = new Set([...S.sel].filter((id) => scope().some((x) => x.conversation_id === id)));
      updateCount();
      const mine = scope();
      const langs = [...new Set(rows.map((x) => x.language))].sort();
      const statusKeys = isNew() ? ['new', 'queued', 'running'] : ['done', 'appeal', 'appealed', 'queued', 'running'];
      const running = mine.filter(inProgress).length;
      const totals = mine.map((x) => x.total).filter((x) => x != null);
      return html`
        <div class="page-head"><h1>Диалоги</h1>
          ${canPick() ? html`<button class="btn secondary" data-act="dlg-import">${icon('upload', 16)}Загрузить диалоги</button>` : ''}</div>
        ${tabBar()}
        ${isNew() ? html`<div class="grid k4">
            <div class="kpi"><span class="lbl">Без оценки</span><span class="val">${mine.length - running}</span></div>
            <div class="kpi"><span class="lbl">Оцениваются сейчас</span><span class="val" style="color:${running ? 'var(--warn-text)' : 'inherit'}">${running}</span><span class="sub">${running ? html`<a href="#/runs">в прогонах</a>` : 'очередь пуста'}</span></div>
            <div class="kpi"><span class="lbl">Звонков</span><span class="val">${mine.filter((x) => CQA.channelName(x.channel) === 'Звонок').length}</span><span class="sub">с записью ${mine.filter((x) => x.has_audio).length}</span></div>
            <div class="kpi"><span class="lbl">Чатов</span><span class="val">${mine.filter((x) => CQA.channelName(x.channel) === 'Чат').length}</span></div>
          </div>`
        : html`<div class="grid k4">
            <div class="kpi"><span class="lbl">Оценено</span><span class="val">${mine.length}</span><span class="sub">${langs.map((l) => `${l} ${mine.filter((x) => x.language === l).length}`).join(' · ')}</span></div>
            <div class="kpi"><span class="lbl">Средний итог</span><span class="val">${CQA.scoreHtml(totals.length ? Math.round((totals.reduce((a2, b2) => a2 + b2, 0) / totals.length) * 100) / 100 : null)}</span></div>
            <div class="kpi"><span class="lbl">Грубые ошибки</span><span class="val" style="color:${mine.some((x) => x.gross_error) ? 'var(--danger-text)' : 'inherit'}">${mine.filter((x) => x.gross_error).length}</span></div>
            <div class="kpi"><span class="lbl">Оцениваются заново</span><span class="val" style="color:${running ? 'var(--warn-text)' : 'inherit'}">${running}</span><span class="sub">${running ? html`<a href="#/runs">в прогонах</a>` : 'очередь пуста'}</span></div>
          </div>`}
        <div class="card tight">
          <div class="toolbar" style="padding:14px 16px;border-bottom:1px solid var(--border)">
            <span class="tb-group"><span class="toolbar-lbl">Чек-лист</span>${CQA.dd({ value: S.checklist, onChange: 'dlg-cl', label: 'Чек-лист', cls: 'fixed', options: [{ value: '*', label: 'Все чек-листы' }, ...cls.map((c) => ({ value: c.id, label: c.title || c.id }))] })}</span><span class="tb-sep"></span>
            <label class="search"><span class="sr">Поиск по ID</span>${icon('search', 16)}<input class="input" type="search" placeholder="Поиск по ID диалога" value="${S.q}" data-on-input="dlg-q"></label>
            ${CQA.dd({ value: S.lang, onChange: 'dlg-f', data: { k: 'lang' }, label: 'Язык', options: [{ value: '', label: 'Все языки' }, ...langs] })}
            ${CQA.dd({ value: S.channel, onChange: 'dlg-f', data: { k: 'channel' }, label: 'Канал', options: [{ value: '', label: 'Все каналы' }, 'Чат', 'Звонок'] })}
            ${CQA.dd({ value: S.status, onChange: 'dlg-f', data: { k: 'status' }, label: 'Статус', options: [{ value: '', label: 'Все статусы' }, ...statusKeys.map((k) => ({ value: k, label: STATUS[k][0] }))] })}
            ${canPick() ? html`<button type="button" class="btn secondary" data-act="dlg-adv">${icon('filter', 16)}Расширенный отбор</button>` : ''}
          </div>
          ${canPick() ? html`<div class="toolbar selbar" id="dlg-selbar">${selBar()}</div>` : ''}
          <div id="dlg-table">${table()}</div>
        </div>`;
    },
  });

  CQA.actions['dlg-q'] = (el) => { S.q = el.value; paint(); };
  CQA.actions['dlg-f'] = (el) => { S[el.dataset.k] = el.value; paint(); };
  CQA.actions['dlg-cl'] = (el) => { S.checklist = el.value; CQA.go(`#/new?tab=${S.mode}&cl=${encodeURIComponent(el.value)}`); };
  CQA.actions['dlg-one'] = (el) => { el.checked ? S.sel.add(el.dataset.id) : S.sel.delete(el.dataset.id); paint(); };
  CQA.actions['dlg-all'] = (el) => { filtered().filter((r) => !inProgress(r)).forEach((r) => (el.checked ? S.sel.add(r.conversation_id) : S.sel.delete(r.conversation_id))); paint(); };
  CQA.actions['dlg-clear'] = () => { S.sel.clear(); paint(); };

  /* ---------- import ---------- */
  CQA.actions['dlg-import'] = () => {
    CQA.modal({
      title: 'Загрузить диалоги',
      body: html`
        <div class="field"><label for="imp-group">group_id из API организаторов</label>
          <div class="row"><input id="imp-group" name="group_id" class="input grow" style="flex:1" placeholder="DEV" autocomplete="off"></div>
</div>
        <div class="field"><label for="imp-url">или ссылка</label><input id="imp-url" name="source" class="input" placeholder="https://…?group_id=…" autocomplete="off"></div>
        <div class="field"><label for="imp-file">или файл JSON</label>${CQA.filePick({ id: 'imp-file', name: 'file', accept: '.json,application/json' })}</div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">${icon('upload', 16)}Загрузить</button>`,
      async onSubmit(fd) {
        const file = fd.get('file');
        let res;
        if (file && file.size) {
          const payload = JSON.parse(await file.text());
          res = await api('/dialogs/upload', { method: 'POST', body: { payload, dataset: file.name.replace(/\.json$/i, '') } });
        } else if (fd.get('source')) {
          res = await api('/dialogs/import', { method: 'POST', body: { source: fd.get('source') } });
        } else if (fd.get('group_id')) {
          res = await api('/dialogs/import', { method: 'POST', body: { group_id: fd.get('group_id').trim() } });
        } else throw new Error('Укажите group_id, ссылку или файл');
        CQA.toast(`Загружено диалогов: ${res.imported}`);
        CQA.render();
      },
    });
  };

  /* ---------- evaluate ---------- */
  CQA.actions['dlg-evaluate'] = () => {
    if (!CQA.can('evaluate')) return CQA.toast(`Запуск оценки доступен ролям: ${CQA.whoCan('evaluate')}`, 'err');
    const ids = [...S.sel];
    const again = S.rows.filter((r) => S.sel.has(r.conversation_id) && r.total != null).length;
    openEvaluate(ids, S.checklist === '*' ? 'official' : S.checklist, again);
  };

  /** shared with the checklist page ("apply to dialogs") */
  CQA.openEvaluate = async function openEvaluate(ids, checklistId, alreadyEvaluated = 0) {
    const models = (await api('/models').catch(() => [])).filter((m) => m.enabled && m.usable);
    if (!S.checklists.length) S.checklists = await api('/checklists').catch(() => []);
    CQA.modal({
      title: `Оценить ${ids.length} ${ids.length === 1 ? 'диалог' : 'диалогов'}`,
      body: html`
        <div class="field"><label for="ev-cl">Чек-лист</label>
          ${CQA.dd({ name: 'checklist', id: 'ev-cl', full: true, value: checklistId, options: (S.checklists.length ? S.checklists : [{ id: checklistId, version: '' }]).map((c) => ({ value: c.id, label: c.title || c.id })) })}</div>
        <div class="field"><label for="ev-model">Модель</label>
          ${models.length ? CQA.dd({ name: 'model_id', id: 'ev-model', full: true, value: (models.find((m) => m.default) || models[0]).id,
            options: models.map((m) => ({ value: m.id, label: `${m.label} · ${CQA.priceNote(m.price)}${m.default ? ' · по умолчанию' : ''}` })) })
            : html`<div class="notice">${icon('info', 16)}<div>Нет подключённых моделей${CQA.can('edit_prompt') ? html` — <a href="#/models">Модели и ключи</a>` : ''}</div></div>`}</div>
        <div class="notice ${ids.length > 20 ? 'warn' : ''}">${icon('info', 16)}<div>
          Оценка идёт в фоне · ≈ 30 с на диалог${alreadyEvaluated ? ` · ${alreadyEvaluated} будут перезаписаны` : ''}</div></div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">${icon('sparkle', 16)}Поставить в очередь</button>`,
      async onSubmit(fd) {
        const body = { conversation_ids: ids, checklist_id: fd.get('checklist') };
        if (fd.get('model_id')) body.model_id = fd.get('model_id');
        const run = await api('/evaluate', { method: 'POST', body });   // returns at once: the run is queued
        CQA.toast(`Прогон №${run.id} в очереди · ${run.n_total} диал.${run.ahead ? ` · перед ним ${run.ahead}` : ''}`, 'ok', 4000);
        S.sel.clear();
        await CQA.watchRuns();
        if (/^#\/(new|dialogs)/.test(location.hash)) { paint(); updateCount(); }
      },
    });
  };
  const openEvaluate = CQA.openEvaluate;
})();
