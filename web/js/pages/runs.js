/* Прогоны: every «Оценить» click is a run that waits in a queue, runs in the background and keeps
   its own snapshot of results. Routes: #/runs, #/runs/<id> */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt } = CQA;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const promptName = (r) => `${CQA.promptTitles[r.prompt_id] || r.prompt_id} · v${r.prompt_version}`;
  const price = (r) => (r.cost_usd ? html`<span class="row" style="gap:6px;flex-wrap:nowrap">${r.cost_estimated ? '≈ ' : ''}${fmt.usd(r.cost_usd)}${r.cost_estimated ? CQA.hint('Модель на своём сервере — расходов нет. Для сравнения: столько стоил бы прогон по цене OpenRouter') : ''}</span>` : html`<span class="muted">—</span>`);
  const elapsed = (r) => (r.started_at ? (r.finished_at || Date.now() / 1000) - r.started_at : null);

  function progress(r) {
    const n = (r.n_done || 0) + (r.n_failed || 0);
    const pct = r.n_total ? (100 * n) / r.n_total : 0;
    return html`<div class="run-progress"><div class="progress"><i style="width:${pct}%;background:${r.status === 'running' ? 'var(--warn)' : r.n_failed ? 'var(--warn)' : 'var(--ok)'}"></i></div>
      <span class="small nowrap">${n} / ${r.n_total}</span></div>`;
  }
  const statusPill = (r) => { const s = CQA.runStatus(r); return html`<span class="pill ${s[1]}">${r.status === 'running' ? raw('<span class="spinner sm"></span>') : ''}${s[0]}</span>`; };

  CQA.route('runs', {
    title: 'Прогоны',
    onRuns() { CQA.render(); },            // live progress while something is queued or running
    async render(r) {
      await CQA.loadPrompts().catch(() => []);
      return r.args[0] ? detail(Number(r.args[0])) : list();
    },
  });

  async function list() {
    const runs = await api('/runs');
    const active = runs.filter((x) => x.status === 'queued' || x.status === 'running');
    const last = runs.find((x) => x.status === 'done' && x.n_done);
    return html`
      <div class="page-head"><h1>Прогоны <span class="count">· ${runs.length}</span></h1>
        ${CQA.can('evaluate') ? html`<a class="btn primary" href="#/new">Новый прогон</a>` : ''}</div>
      <div class="grid k4">
        <div class="kpi"><span class="lbl">Прогонов</span><span class="val">${runs.length}</span></div>
        <div class="kpi"><span class="lbl">Сейчас в работе</span><span class="val" style="color:${active.length ? 'var(--warn-text)' : 'inherit'}">${active.length}</span>
          <span class="sub">${active.length ? active.map((x) => `№${x.id}`).join(', ') : 'очередь пуста'}</span></div>
        <div class="kpi"><span class="lbl">Последний средний итог</span><span class="val">${CQA.scoreHtml(last ? last.avg_total : null)}</span><span class="sub">${last ? `прогон №${last.id}` : ''}</span></div>
        <div class="kpi"><span class="lbl">Оценено диалогов</span><span class="val">${runs.reduce((a, x) => a + (x.n_done || 0), 0)}</span><span class="sub">во всех прогонах</span></div>
      </div>
      <div class="card tight">${runs.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>№</th><th>Запущен ↓</th><th>Статус</th><th>Диалоги</th><th class="num">Средний итог</th><th class="num">Грубые</th><th>Модель</th><th>Промпт</th><th>Чек-лист</th><th class="num">Время</th><th class="num">Цена</th></tr></thead>
        <tbody>${runs.map((x) => html`<tr class="click" tabindex="0" data-act="run-open" data-id="${x.id}">
          <td class="muted">${x.id}</td>
          <td class="nowrap"><a href="#/runs/${x.id}"><b style="font-weight:500">${fmt.date(x.created_at)}</b></a>${x.source === 'import' ? html`<div class="muted small">импорт прежних оценок</div>` : ''}</td>
          <td>${statusPill(x)}</td>
          <td>${progress(x)}</td>
          <td class="num">${CQA.scoreHtml(x.avg_total)}</td>
          <td class="num">${x.gross ? html`<span style="color:var(--danger-text)">${x.gross}</span>` : html`<span class="muted">0</span>`}</td>
          <td class="nowrap">${CQA.modelName(x.model)}</td>
          <td class="nowrap">${promptName(x)}</td>
          <td style="max-width:220px"><div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${x.checklist_title || x.checklist_id}">${x.checklist_title || x.checklist_id}</div><span class="muted small">версия ${x.checklist_version}</span></td>
          <td class="num nowrap">${x.status === 'queued' || x.source === 'import' ? '—' : CQA.duration(elapsed(x))}</td>
          <td class="num nowrap">${price(x)}</td>
        </tr>`)}</tbody></table></div>` : CQA.empty('Прогонов пока нет', 'Выберите диалоги в «Диалогах» и нажмите «Оценить».')}</div>`;
  }

  async function detail(id) {
    const r = await api(`/runs/${id}`);
    const rows = r.rows.slice().sort((a, b) => (a.total ?? 101) - (b.total ?? 101));
    const totals = rows.map((x) => x.total).filter((x) => x != null);
    const cl = await CQA.checklist(r.checklist_id, r.checklist_version).catch(() => null);
    const stats = cl && CQA.anx ? CQA.anx.critStats(cl, rows) : [];
    const failed = Object.entries(r.failed || {});
    const pend = (r.conversation_ids || []).filter((c) => !rows.some((x) => x.conversation_id === c) && !(c in (r.failed || {})));
    return html`
      <div class="page-head"><a class="back-link" href="#/runs">${icon('back', 16)}Прогоны</a>
        <h1>Прогон №${r.id}</h1>${statusPill(r)}
        ${rows.length ? html`<a class="btn secondary" href="#/analytics?cl=${encodeURIComponent(r.checklist_id)}&run=${r.id}">Аналитика по прогону</a>` : ''}</div>
      ${r.status === 'queued' || r.status === 'running' ? html`<div class="card">${progress(r)}<p class="muted small" style="margin:8px 0 0">${r.status === 'queued' ? 'Ждёт своей очереди' : 'Диалоги оцениваются в фоне — страница обновляется сама'}</p></div>` : ''}
      <div class="grid k4">
        <div class="kpi"><span class="lbl">Средний итог</span><span class="val">${CQA.scoreHtml(r2(mean(totals)))}</span><span class="sub">медиана ${fmt.score(r2(median(totals)))}</span></div>
        <div class="kpi"><span class="lbl">Диалоги</span><span class="val">${r.n_done}<span class="muted" style="font-size:16px"> / ${r.n_total}</span></span><span class="sub">${r.n_failed ? `ошибок ${r.n_failed}` : 'без ошибок'}</span></div>
        <div class="kpi"><span class="lbl">Грубые ошибки</span><span class="val" style="color:${r.gross ? 'var(--danger-text)' : 'inherit'}">${r.gross}</span><span class="sub">${rows.length ? `${fmt.pct(r.gross / rows.length, 0)} диалогов` : ''}</span></div>
        <div class="kpi"><span class="lbl">Время</span><span class="val">${r.status === 'queued' || r.source === 'import' ? '—' : CQA.duration(elapsed(r))}</span><span class="sub">${r.cost_usd ? html`цена ${price(r)}` : 'без расходов на API'}</span></div>
      </div>
      <div class="grid k2" style="align-items:start">
        <section class="card"><div class="card-head"><h2>Параметры</h2></div>
          <dl class="kv left" style="margin:0">
            <dt>Модель</dt><dd>${CQA.modelName(r.model)}</dd>
            <dt>Промпт</dt><dd>${promptName(r)}</dd>
            <dt>Чек-лист</dt><dd>${r.checklist_title || r.checklist_id} · v${r.checklist_version}</dd>
            <dt>Запущен</dt><dd>${fmt.date(r.created_at)}</dd>
            <dt>Завершён</dt><dd>${r.finished_at ? fmt.date(r.finished_at) : '—'}</dd>
            ${r.source === 'import' ? html`<dt>Источник</dt><dd>импорт оценок, сделанных до появления прогонов</dd>` : ''}
          </dl></section>
        <section class="card"><div class="card-head"><h2>По критериям</h2></div>
          ${stats.length ? html`<div class="stack" style="gap:10px">${stats.filter((s) => s.n).map((s) => html`<div class="stack" style="gap:4px">
            <div class="row small"><span class="grow">${s.c.title}</span>${s.c.critical ? html`<span class="muted">нарушений ${s.zero}</span>` : CQA.scoreHtml(s.avg == null ? null : r2(s.avg * 100))}</div>
            ${CQA.anx.stackBar(s)}</div>`)}</div>` : html`<p class="muted small" style="margin:0">Появится, когда будут результаты</p>`}
        </section>
      </div>
      <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>Диалоги · ${rows.length + failed.length + pend.length}</h2><span class="muted small">сначала самые низкие итоги</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Звонок</th><th class="num">Итог</th><th>Грубые ошибки</th><th class="num">Время</th><th></th></tr></thead>
          <tbody>
            ${failed.map(([cid, err]) => html`<tr><td><b style="font-weight:500">${cid}</b></td><td class="num">—</td><td colspan="2"><span class="pill danger" data-tip="${err}">ошибка оценки</span></td><td></td></tr>`)}
            ${pend.map((cid) => html`<tr><td><b style="font-weight:500">${cid}</b></td><td class="num">—</td><td colspan="2"><span class="pill ${r.status === 'running' ? 'warn' : 'outline'}">${r.status === 'running' ? 'оценивается' : 'в очереди'}</span></td><td></td></tr>`)}
            ${rows.map((x) => html`<tr>
              <td>${CQA.objCell(x)}</td>
              <td class="num">${CQA.scoreHtml(x.total)}</td>
              <td>${x.gross_error ? html`<span class="pill danger">${icon('flag', 12)}выявлены</span>` : html`<span class="muted small">нет</span>`}</td>
              <td class="num muted small">${x.wall_s != null ? CQA.duration(x.wall_s) : '—'}</td>
              <td class="num"><a class="btn link chev" href="#/eval/${encodeURIComponent(x.conversation_id)}?cl=${encodeURIComponent(r.checklist_id)}">Открыть</a></td>
            </tr>`)}
          </tbody></table></div></section>`;
  }

  CQA.actions['run-open'] = (el, e) => { if (!e.target.closest('a')) CQA.go(`#/runs/${el.dataset.id}`); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-act="run-open"]')) CQA.go(`#/runs/${e.target.dataset.id}`); });
})();
