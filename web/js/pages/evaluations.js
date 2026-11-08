/* Оценки: one row per EVALUATION (every run of every call, newest first) — a click opens exactly that evaluation.
   Calls (one row each, opening the latest evaluation) live in «Диалоги → Оценённые».
   Operator («Мои звонки»): one row per call. results.json export. */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.evals = { rows: [], cl: null, checklist: 'official', q: '', lang: '', channel: '', status: '', gross: false, latestOnly: false, run: '', sort: 'at', dir: -1 });
  const perCall = () => CQA.isOperator();          // operator sees calls; everyone else sees evaluation instances
  /** live state of a call applies only to its latest evaluation row */
  const live = (r) => (r.is_latest !== false ? CQA.state.runs.pending[r.conversation_id] : undefined);
  const evName = (r) => (r.run_id ? `Прогон №${r.run_id}` : `Оценка №${r.eval_no || 1}`);
  const href = (r) => `#/eval/${encodeURIComponent(r.conversation_id)}?cl=${S.checklist}${r.is_latest === false && r.eval_id ? `&e=${encodeURIComponent(r.eval_id)}` : ''}`;

  function status(r) {
    const run = live(r);
    if (run) return [run === 'running' ? 'running' : 'queued', run === 'running' ? 'Оценивается' : 'В очереди', run === 'running' ? 'warn' : 'outline'];
    const items = r.appeals.items || [];
    // green = checked by a person; grey = only the AI
    if (r.appeals.pending) return ['pending', 'На апелляции', 'warn'];
    if (items.some((a) => a.status === 'changed')) return ['changed', 'Проверено человеком · исправлено', 'ok'];
    if (items.some((a) => a.status === 'confirmed')) return ['rejected', 'Проверено человеком · без изменений', ''];
    if (r.needs_review) return ['review', 'Нужна проверка', 'warn'];
    return ['ai', 'Оценено ИИ', ''];
  }
  const naCount = (r) => Object.values(r.answers).filter((a) => a === 'na').length;
  function rows() {
    const q = S.q.trim().toLowerCase();
    const op = CQA.isOperator();
    const out = S.rows.filter((r) => (!op || !live(r)) && (!S.latestOnly || r.is_latest !== false) && (!q || r.conversation_id.toLowerCase().includes(q))
      && (!S.lang || r.language === S.lang) && (!S.channel || CQA.channelName(r.channel) === S.channel)
      && (!S.run || (S.run === 'none' ? !r.run_id : String(r.run_id) === S.run)) && (!S.status || status(r)[0] === S.status) && (!S.gross || r.gross_error));
    const key = { id: (r) => r.conversation_id, total: (r) => (r.total == null ? -1 : r.total), at: (r) => ({ running: 2e10, queued: 1e10 })[live(r)] || r.updated_at || 0 }[S.sort];
    return out.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * S.dir);
  }
  const sortBtn = (k, label) => html`<button class="th-sort" data-act="ev-sort" data-k="${k}">${label}${S.sort === k ? (S.dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
  function table() {
    const list = rows();
    const op = CQA.isOperator();      // operator: appeals live on their own page, no run internals
    if (!list.length) return CQA.empty(op ? 'Оценённых звонков нет' : 'Оценок нет', S.rows.length ? 'Под эти фильтры ничего не подходит.' : op ? 'Здесь появятся ваши звонки с оценкой.' : 'Запустите оценку в разделе «Диалоги».',
      S.rows.length && active() ? html`<button class="btn secondary sm" type="button" data-act="ev-reset" style="margin-top:12px">Сбросить фильтры</button>` : '');
    // fixed column widths: filtering or toggling never makes the columns jump
    const cols = op ? ['64px', '', '90px', '140px', '260px', '150px', '36px']
      : ['64px', '140px', '200px', '80px', '130px', '', '260px', '150px', '36px'];
    return html`<div class="table-wrap"><table class="table fixed-cols">
      <colgroup>${cols.map((w) => html`<col${w ? raw(` style="width:${w}"`) : ''}>`)}</colgroup>
      <thead><tr><th>№</th>${perCall() ? '' : html`<th>Оценка</th>`}<th>${sortBtn('id', 'Звонок')}</th><th class="num">${sortBtn('total', 'Итог')}</th><th>Грубые ошибки</th>${op ? '' : html`<th class="th-2"><span class="th-main">Апелляции ${CQA.hint('Оспоренный пункт: ответ ИИ → ответ после решения проверяющего. Одинаковые ответы — оценка подтверждена, «…» — ждёт решения. Наведите на пункт, чтобы увидеть подробности.')}</span><div class="th-sub">было → стало</div></th>`}<th>Статус</th><th>${sortBtn('at', 'Оценено')}</th><th class="row-go-h"></th></tr></thead>
      <tbody>${list.map((r, i) => {
        const st = status(r);
        return html`<tr class="click" data-act="ev-open" data-href="${href(r)}" tabindex="0">
          <td class="muted no-open">${i + 1}</td>
          ${perCall() ? '' : html`<td class="nowrap"><b style="font-weight:600">${evName(r)}</b>
            <div>${r.is_latest ? html`<span class="pill ok" style="height:18px">последняя</span>` : html`<span class="muted small">прежняя оценка</span>`}</div></td>`}
          <td>${CQA.objCell(r)}</td>
          <td class="num">${CQA.scoreHtml(r.total)}</td>
          <td>${r.gross_error ? html`<span class="pill danger">${icon('flag', 12)}выявлены</span>` : html`<span class="muted small">нет</span>`}</td>
          ${op ? '' : html`<td>${(r.appeals.items || []).length ? html`<div class="row" style="gap:4px">${r.appeals.items.map((a) => {
            const c = S.cl && S.cl.criteria.find((x) => x.id === a.criterion_id);
            const t = CQA.appealTag(a, c);
            const lbl = (v) => (c ? CQA.answerView(c, v).label : String(v));
            // AI verdict → verdict after the appeal; grey once decided, amber while waiting
            return html`<a class="pill ${a.status === 'pending' ? 'warn' : ''}" href="#/appeal/${a.id}" data-tip="${t.tip}">${c ? c.title : a.criterion_id}: ${lbl(a.before)} → ${a.status === 'pending' ? '…' : lbl(a.after ?? a.before)}</a>`;
          })}</div>` : ''}</td>`}
          <td><span class="pill ${st[2]}">${st[0] === 'running' ? raw('<span class="spinner sm"></span>') : ''}${st[1]}</span></td>
          <td class="nowrap"><span class="small">${fmt.date(r.updated_at)}</span>${r.run_id && !op ? html`<div><a class="small muted" href="#/runs/${r.run_id}">к прогону ›</a></div>` : ''}</td>
          <td class="row-go" aria-hidden="true">${icon('back', 14)}</td>
        </tr>`;
      })}</tbody></table></div>`;
  }
  const active = () => !!(S.q || S.lang || S.channel || S.status || S.gross || S.latestOnly || S.run);
  const paint = () => {
    const t = document.getElementById('ev-table'); if (t) t.innerHTML = toStr(table());
  };

  CQA.route('evaluations', {
    title: 'Оценки',
    onRuns(finished) { if (finished) CQA.render(); else paint(); },
    crumbs: () => [{ label: 'Оценки' }],
    async render(r) {
      if (r.query.cl) S.checklist = r.query.cl;
      const [list, cl, cls] = await Promise.all([api(`/evaluations?checklist_id=${encodeURIComponent(S.checklist)}${perCall() ? '' : '&all=1'}`), CQA.checklist(S.checklist), api('/checklists')]);
      S.rows = list; S.cl = cl;
      // runs that produced evaluations in this list, newest first (+ «без прогона» for imported/older evaluations)
      const runIds = [...new Set(list.map((x) => x.run_id).filter(Boolean))].sort((a, b) => b - a);
      if (S.run && S.run !== 'none' && !runIds.some((id) => String(id) === S.run)) S.run = '';
      const runTimes = {};
      list.forEach((x) => { if (x.run_id) runTimes[x.run_id] = Math.max(runTimes[x.run_id] || 0, x.updated_at || 0); });
      const runOpts = [{ value: '', label: 'Все прогоны' }, ...runIds.map((id) => ({ value: String(id), label: `Прогон №${id}` })),
        ...(list.some((x) => !x.run_id) ? [{ value: 'none', label: 'Без прогона' }] : [])];
      const langs = [...new Set(list.map((x) => x.language))].sort();
      const totals = list.map((x) => x.total).filter((x) => x != null);
      const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
      const cost = list.reduce((a, x) => a + (x.cost_usd || 0), 0);
      return html`
        <div class="page-head"><h1>${CQA.isOperator() ? 'Мои звонки' : 'Оценки'} <span class="count">· ${CQA.isOperator() ? list.filter((x) => !CQA.state.runs.pending[x.conversation_id]).length : list.length}</span></h1>
          ${CQA.isOperator() ? '' : html`<button class="btn secondary" data-act="ev-export">Экспорт results.json</button>`}</div>
        <div class="grid k3">
          <div class="kpi"><span class="lbl">Средний итог</span><span class="val">${CQA.scoreHtml(avg == null ? null : Math.round(avg * 100) / 100)}</span><span class="sub">${perCall() ? `по ${totals.length} звонкам` : `по ${totals.length} оценкам · звонков ${new Set(list.map((x) => x.conversation_id)).size}`}</span></div>
          <div class="kpi"><span class="lbl">Грубые ошибки</span><span class="val" style="color:var(--danger-text)">${list.filter((x) => x.gross_error).length}</span></div>
          ${CQA.isOperator() ? html`<div class="kpi"><span class="lbl">Без замечаний</span><span class="val">${list.filter((x) => x.total === 100).length}</span><span class="sub">звонков на 100 баллов</span></div>`
            : html`<div class="kpi"><span class="lbl">Апелляции</span><span class="val">${list.reduce((a, x) => a + x.appeals.total, 0)}</span><span class="sub">${list.reduce((a, x) => a + x.appeals.pending, 0)} ожидают решения</span></div>`}
        </div>
        <div class="card tight">
          <div class="ev-filters">
            ${CQA.dd({ value: S.checklist, onChange: 'ev-cl', label: 'Чек-лист', cls: 'fixed w-cl', options: cls.map((c) => ({ value: c.id, label: c.title || c.id })) })}
            ${perCall() ? '' : CQA.dd({ value: S.run, onChange: 'ev-f', data: { k: 'run' }, label: 'Прогон', cls: 'fixed w-run', options: runOpts })}
            <label class="search"><span class="sr">Поиск</span>${icon('search', 16)}<input class="input" type="search" placeholder="ID звонка" value="${S.q}" data-on-input="ev-q"></label>
            ${CQA.dd({ value: S.lang, onChange: 'ev-f', data: { k: 'lang' }, label: 'Язык', cls: 'fixed w-sm', options: [{ value: '', label: 'Все языки' }, ...langs] })}
            ${CQA.dd({ value: S.channel, onChange: 'ev-f', data: { k: 'channel' }, label: 'Канал', cls: 'fixed w-ch', options: [{ value: '', label: 'Все каналы' }, 'Чат', 'Звонок'] })}
            ${CQA.dd({ value: S.status, onChange: 'ev-f', data: { k: 'status' }, label: 'Статус', cls: 'fixed w-st', options: [{ value: '', label: 'Все статусы' }, { value: 'ai', label: 'Оценено ИИ' }, { value: 'review', label: 'Нужна проверка' }, { value: 'pending', label: 'На апелляции' }, { value: 'changed', label: 'Проверено человеком · исправлено' }, { value: 'rejected', label: 'Проверено человеком · без изменений' }] })}
            <button type="button" class="ftog" data-act="ev-tog" data-k="gross" aria-pressed="${S.gross ? 'true' : 'false'}" data-tip="Только оценки с грубыми ошибками">${icon('flag', 13)}Грубые</button>
            ${perCall() ? '' : html`<button type="button" class="ftog" data-act="ev-tog" data-k="latestOnly" aria-pressed="${S.latestOnly ? 'true' : 'false'}" data-tip="Только последняя оценка каждого звонка">Последние</button>`}
          </div>
          <div id="ev-table">${table()}</div>
        </div>`;
    },
  });

  CQA.actions['ev-q'] = (el) => { S.q = el.value; paint(); };
  CQA.actions['ev-f'] = (el) => { S[el.dataset.k] = el.value; paint(); };
  CQA.actions['ev-gross'] = (el) => { S.gross = el.checked; paint(); };
  CQA.actions['ev-latest'] = (el) => { S.latestOnly = el.checked; paint(); };
  CQA.actions['ev-tog'] = (el) => { const k = el.dataset.k; S[k] = !S[k]; el.setAttribute('aria-pressed', String(S[k])); paint(); };
  CQA.actions['ev-reset'] = () => { Object.assign(S, { q: '', lang: '', channel: '', status: '', gross: false, latestOnly: false, run: '' }); CQA.render(); };
  CQA.actions['ev-cl'] = (el) => { S.checklist = el.value; CQA.render(); };
  CQA.actions['ev-sort'] = (el, e) => { e.stopPropagation(); const k = el.dataset.k; S.dir = S.sort === k ? -S.dir : 1; S.sort = k; paint(); };
  CQA.actions['ev-open'] = (el, e) => { if (e.target.closest('a,button,.no-open')) return; CQA.go(el.dataset.href); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-act="ev-open"]')) CQA.go(e.target.dataset.href);
  });

  CQA.actions['ev-export'] = () => {
    CQA.modal({
      title: 'Экспорт results.json',
      body: html`        <div class="field"><label for="exp-team">Название команды</label><input id="exp-team" name="team" class="input" value="${localStorage.getItem('cqa.team') || 'VibeTeam'}" required autocomplete="off"></div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">${icon('download', 16)}Скачать</button>`,
      async onSubmit(fd) {
        const team = fd.get('team').trim();
        try { localStorage.setItem('cqa.team', team); } catch (e) {}
        const doc = await api(`/export?checklist_id=${encodeURIComponent(S.checklist)}&team=${encodeURIComponent(team)}`);
        const problems = doc._check || [];
        delete doc._check;
        CQA.downloadJson(doc, 'results.json');
        CQA.toast(problems.length ? `Скачано, но есть замечания: ${problems.slice(0, 3).join('; ')}` : `Скачано: ${doc.results.length} записей, проверка формата пройдена`, problems.length ? 'err' : 'ok');
      },
    });
  };
})();
