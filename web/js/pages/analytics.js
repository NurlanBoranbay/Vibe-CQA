/* Аналитика качества: totals distribution, per-criterion breakdown, segments, weakest dialogs. */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt } = CQA;
  const S = (CQA.state.analytics = { checklist: 'official', run: '' });

  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

  function histogram(totals) {
    const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, n: 0 }));
    totals.forEach((t) => { bins[Math.min(9, Math.floor(t / 10))].n++; });
    const max = Math.max(1, ...bins.map((b) => b.n));
    return html`<div class="bars" role="img" aria-label="Распределение итоговых баллов по интервалам 10 баллов">${bins.map((b) => html`
      <div class="bar-row" data-tip="${b.lo}–${b.lo + 10}%: ${b.n} диалог(ов), ${fmt.pct(totals.length ? b.n / totals.length : 0, 0)}">
        <span>${b.lo}–${b.lo + 10}%</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(100 * b.n) / max}%"></div></div>
        <span class="v">${b.n}</span></div>`)}</div>`;
  }

  function critStats(cl, rows) {
    return cl.criteria.map((c) => {
      let full = 0, part = 0, zero = 0, na = 0, fsum = 0, fn = 0;
      rows.forEach((r) => {
        const a = r.answers[c.id];
        if (a === undefined) return;
        const f = CQA.fraction(c, a);
        if (f == null) { na++; return; }
        fn++; fsum += f;
        if (c.critical) { (CQA.answerView(c, a).tone === 'danger' ? zero++ : full++); return; }
        f >= 1 ? full++ : f <= 0 ? zero++ : part++;
      });
      const n = full + part + zero + na;
      return { c, full, part, zero, na, n, avg: fn ? fsum / fn : null };
    });
  }
  function stackBar(s) {
    if (!s.n) return '';
    const seg = (k, cls, label) => (s[k] ? html`<i class="${cls}" style="width:${(100 * s[k]) / s.n}%" data-tip="${label}: ${s[k]} (${fmt.pct(s[k] / s.n, 0)})"></i>` : '');
    return s.c.critical
      ? html`<div class="stack-bar">${seg('full', 's-ok', 'Нет нарушений')}${seg('zero', 's-bad', 'Нарушение')}</div>`
      : html`<div class="stack-bar">${seg('full', 's-ok', 'Полностью')}${seg('part', 's-part', 'Частично')}${seg('zero', 's-bad', 'Нет / 0')}${seg('na', 's-na', 'N/A')}</div>`;
  }

  function segments(rows) {
    const groups = {};
    rows.forEach((r) => {
      for (const k of [`Язык · ${r.language}`, `Канал · ${CQA.channelName(r.channel)}`]) (groups[k] = groups[k] || []).push(r);
    });
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => {
      const t = list.map((r) => r.total).filter((x) => x != null);
      return { k, n: list.length, avg: r2(mean(t)), med: r2(median(t)), gross: list.filter((r) => r.gross_error).length };
    });
  }

  CQA.route('analytics', {
    title: 'Аналитика качества',
    crumbs: () => [{ label: 'Аналитика качества' }],
    async render(r) {
      if (r.query.cl) S.checklist = r.query.cl;
      if (r.query.run !== undefined) S.run = r.query.run;
      const [cur, cl, cls, runs] = await Promise.all([api(`/evaluations?checklist_id=${encodeURIComponent(S.checklist)}`), CQA.checklist(S.checklist), api('/checklists'),
        api(`/runs?checklist_id=${encodeURIComponent(S.checklist)}`)]);
      const done = runs.filter((x) => x.n_done);
      if (S.run && !done.some((x) => String(x.id) === String(S.run))) S.run = '';
      const run = S.run ? await api(`/runs/${S.run}`) : null;
      const rows = run ? run.rows : cur;
      const runPick = html`<span class="tb-group"><span class="toolbar-lbl">Прогон</span>${CQA.dd({ value: S.run, onChange: 'an-run', label: 'Прогон', cls: 'fixed', options: [{ value: '', label: 'Текущие оценки' },
        ...done.map((x) => ({ value: String(x.id), label: `№${x.id} · ${fmt.date(x.created_at)} · ${CQA.modelName(x.model)} · ${CQA.promptTitles[x.prompt_id] || x.prompt_id}` }))] })}</span>`;
      if (!rows.length) return html`<div class="page-head"><h1>Аналитика качества</h1>${runPick}</div><div class="card">${CQA.empty('Пока нет оценок', 'Оцените диалоги в разделе «Диалоги».')}</div>`;
      const totals = rows.map((x) => x.total).filter((x) => x != null);
      const avg = mean(totals), med = median(totals);
      const gross = rows.filter((x) => x.gross_error).length;
      const naItems = rows.reduce((a, x) => a + Object.values(x.answers).filter((v) => v === 'na').length, 0);
      const items = rows.reduce((a, x) => a + Object.keys(x.answers).length, 0);
      const changed = rows.filter((x) => x.total !== x.original_total).length;
      const stats = critStats(cl, rows);
      const weakest = rows.filter((x) => x.total != null).sort((a, b) => a.total - b.total).slice(0, 6);
      return html`
        <div class="page-head"><h1>Аналитика качества</h1>
          ${runPick}<span class="toolbar-lbl">Чек-лист</span>${CQA.dd({ value: S.checklist, onChange: 'an-cl', label: 'Чек-лист', cls: 'fixed',  options: cls.map((c) => ({ value: c.id, label: c.title || c.id })) })}</div>
        <div class="grid k4">
          <div class="kpi"><span class="lbl">Оценок</span><span class="val">${rows.length}</span><span class="sub">${[...new Set(rows.map((x) => x.language))].map((l) => `${l} ${rows.filter((x) => x.language === l).length}`).join(' · ')}</span></div>
          <div class="kpi"><span class="lbl">Средний балл</span><span class="val">${CQA.scoreHtml(r2(avg))}</span><span class="sub">медиана ${fmt.score(r2(med))}</span></div>
          <div class="kpi"><span class="lbl">Грубые ошибки</span><span class="val" style="color:var(--danger-text)">${gross}</span><span class="sub">${fmt.pct(rows.length ? gross / rows.length : 0)} диалогов</span></div>
          <div class="kpi"><span class="lbl">N/A</span><span class="val">${fmt.pct(items ? naItems / items : 0)}</span><span class="sub">${naItems} из ${items} пунктов</span></div>
        </div>
        <div class="grid k2" style="align-items:start">
          <section class="card"><div class="card-head"><h2>Распределение итогов</h2><span class="muted small">${totals.length} диалогов</span></div>${histogram(totals)}</section>
          <section class="card"><div class="card-head"><h2>Над чем поработать</h2></div>
            <div class="stack" style="gap:6px">${weakest.map((x) => html`<a class="row" href="#/eval/${encodeURIComponent(x.conversation_id)}?cl=${S.checklist}" style="padding:8px 10px;border-radius:10px;background:var(--sunken);color:var(--text)">
              <span class="grow"><b style="font-weight:500">${x.conversation_id}</b> <span class="muted small">${CQA.channelName(x.channel)} · ${x.language}</span></span>
              ${x.gross_error ? html`<span class="pill danger">${icon('flag', 12)}грубая</span>` : ''}${CQA.scoreHtml(x.total)}</a>`)}</div></section>
        </div>
        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>По критериям</h2>
            <div class="legend"><span><i style="background:var(--ok)"></i>Полностью</span><span><i style="background:var(--warn)"></i>Частично</span><span><i style="background:var(--danger)"></i>Нет / 0 / нарушение</span><span><i style="background:var(--surface-3)"></i>N/A</span></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Критерий</th><th class="num">Вес</th><th class="num">Средний %</th><th style="min-width:180px">Распределение</th><th class="num">Полностью</th><th class="num">Частично</th><th class="num">Нет</th><th class="num">N/A</th></tr></thead>
            <tbody>${stats.map((s) => html`<tr><td><b style="font-weight:500">${s.c.title}</b><div class="muted small">${s.c.section || ''}</div></td>
              <td class="num">${s.c.critical ? '—' : s.c.weight}</td>
              <td class="num">${s.c.critical ? html`<span class="muted">флаг</span>` : CQA.scoreHtml(s.avg == null ? null : r2(s.avg * 100))}</td>
              <td>${stackBar(s)}</td><td class="num">${s.full}</td><td class="num">${s.c.critical ? '—' : s.part}</td><td class="num">${s.zero}</td><td class="num">${s.na}</td></tr>`)}</tbody></table></div></section>
        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>По языкам и каналам</h2></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Срез</th><th class="num">Оценок</th><th class="num">Средний</th><th class="num">Медиана</th><th class="num">Грубые ошибки</th></tr></thead>
            <tbody>${segments(rows).map((g) => html`<tr><td>${g.k}</td><td class="num">${g.n}</td><td class="num">${CQA.scoreHtml(g.avg)}</td><td class="num">${fmt.score(g.med)}</td><td class="num">${g.gross ? html`<span style="color:var(--danger-text)">${g.gross}</span>` : 0}</td></tr>`)}</tbody></table></div></section>`;
    },
  });
  CQA.anx = { histogram, critStats, stackBar };   // reused by «Моя статистика»
  CQA.actions['an-cl'] = (el) => { S.checklist = el.value; S.run = ''; CQA.render(); };
  CQA.actions['an-run'] = (el) => { S.run = el.value; CQA.render(); };
})();
