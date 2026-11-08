/* Моя статистика (operator): own rating, what to improve, appeal outcomes. Route: #/me
   Prototype: one operator, so every evaluated dialog is "mine". */
(function () {
  'use strict';
  const { html, icon, api, fmt } = CQA;
  const CHECKLIST = 'official';
  const tone = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const bar = (pct) => html`<div class="progress"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${tone[CQA.scoreTone(pct)] || 'var(--text-3)'}"></i></div>`;
  const evLink = (cid) => `#/eval/${encodeURIComponent(cid)}?cl=${CHECKLIST}`;

  /** per criterion: average fulfilment and dialogs where points were lost (lowest-total example first) */
  function perCriterion(cl, rows) {
    return cl.criteria.filter((c) => !c.critical && c.weight > 0).map((c) => {
      const fs = [], lost = [];
      rows.forEach((r) => {
        const f = CQA.fraction(c, r.answers[c.id]);
        if (f == null) return;
        fs.push(f);
        if (f < 1) lost.push(r);
      });
      lost.sort((a, b) => (a.total ?? 0) - (b.total ?? 0));
      return { c, avg: fs.length ? mean(fs) * 100 : null, n: fs.length, lost };
    }).filter((x) => x.n);
  }

  CQA.route('me', {
    title: 'Моя статистика',
    async render() {
      const [rows, appeals, cl] = await Promise.all([api(`/evaluations?checklist_id=${CHECKLIST}`), api('/appeals'), CQA.checklist(CHECKLIST)]);
      if (!rows.length) return html`<div class="page-head"><h1>Моя статистика</h1></div><div class="card">${CQA.empty('Оценок пока нет')}</div>`;
      const totals = rows.map((r) => r.total).filter((x) => x != null);
      const avg = r1(mean(totals));
      const perfect = rows.filter((r) => r.total === 100).length;
      const gross = rows.filter((r) => r.gross_error).length;
      const st = (s) => appeals.filter((a) => a.status === s).length;
      const decided = st('changed') + st('confirmed');
      const crit = perCriterion(cl, rows);
      const improve = crit.slice().sort((a, b) => a.avg - b.avg).filter((x) => x.avg < 100).slice(0, 3);
      const strong = crit.slice().sort((a, b) => b.avg - a.avg).slice(0, 3);
      const worst = rows.filter((r) => r.total != null).sort((a, b) => a.total - b.total).slice(0, 5);
      const byChannel = Object.entries(rows.reduce((m, r) => { const k = CQA.channelName(r.channel); (m[k] = m[k] || []).push(r.total); return m; }, {}));
      const STATUS = CQA.APPEAL_STATUS;

      return html`
        <div class="page-head"><h1>Моя статистика</h1></div>
        <div class="grid k4">
          <div class="kpi"><span class="lbl">Средний балл</span><span class="val">${CQA.scoreHtml(avg)}</span><span class="sub">медиана ${fmt.score(r1(median(totals)))} · ${rows.length} оценок</span></div>
          <div class="kpi"><span class="lbl">Без замечаний</span><span class="val">${perfect}</span><span class="sub">${fmt.pct(perfect / rows.length, 0)} диалогов на 100 баллов</span></div>
          <div class="kpi"><span class="lbl">Грубые ошибки</span><span class="val" style="color:${gross ? 'var(--danger-text)' : 'inherit'}">${gross}</span><span class="sub">${fmt.pct(gross / rows.length, 0)} диалогов</span></div>
          <div class="kpi"><span class="lbl">Апелляции</span><span class="val">${appeals.length}</span><span class="sub">${decided ? `принято ${st('changed')} из ${decided}` : 'решений пока нет'}${st('pending') ? ` · ${st('pending')} ожидают` : ''}</span></div>
        </div>

        <div class="grid k2" style="align-items:start">
          <section class="card"><div class="card-head"><h2>Что улучшить</h2></div>
            ${improve.length ? html`<div class="stack" style="gap:14px">${improve.map((x) => html`<div class="stack" style="gap:6px">
              <div class="row"><b class="grow" style="font-weight:600">${x.c.title}</b>${CQA.scoreHtml(r1(x.avg))}</div>
              ${bar(x.avg)}
              <div class="row small muted"><span class="grow">Баллы потеряны в ${x.lost.length} из ${x.n} диалогов</span>
                <a class="chev" href="${evLink(x.lost[0].conversation_id)}">Пример</a></div></div>`)}</div>`
              : html`<p class="muted">Все критерии выполнены полностью</p>`}
          </section>
          <section class="card"><div class="card-head"><h2>Сильные стороны</h2></div>
            <div class="stack" style="gap:14px">${strong.map((x) => html`<div class="stack" style="gap:6px">
              <div class="row"><b class="grow" style="font-weight:600">${x.c.title}</b>${CQA.scoreHtml(r1(x.avg))}</div>${bar(x.avg)}</div>`)}</div>
            ${byChannel.length > 1 ? html`<dl class="kv" style="margin:18px 0 0">${byChannel.map(([k, t]) => html`<dt>${k}</dt><dd>${CQA.scoreHtml(r1(mean(t.filter((x) => x != null))))} <span class="muted small">· ${t.length}</span></dd>`)}</dl>` : ''}
          </section>
        </div>

        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>По критериям</h2></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Критерий</th><th class="num">Выполнение</th><th style="min-width:180px">Распределение</th><th class="num">Баллы потеряны</th><th>Пример</th></tr></thead>
            <tbody>${crit.map((x) => html`<tr><td><b style="font-weight:500">${x.c.title}</b><div class="muted small">${x.c.section || ''}</div></td>
              <td class="num">${CQA.scoreHtml(r1(x.avg))}</td>
              <td>${CQA.anx ? CQA.anx.stackBar(CQA.anx.critStats(cl, rows).find((s) => s.c.id === x.c.id)) : bar(x.avg)}</td>
              <td class="num">${x.lost.length} из ${x.n}</td>
              <td>${x.lost.length ? html`<a href="${evLink(x.lost[0].conversation_id)}">${x.lost[0].conversation_id}</a>` : html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div></section>

        <div class="grid k2" style="align-items:start">
          <section class="card"><div class="card-head"><h2>Мои апелляции</h2><a class="chev small" href="#/appeals">Все</a></div>
            <dl class="kv" style="margin:0 0 14px">${Object.entries(STATUS).map(([k, v]) => html`<dt>${v[0]}</dt><dd>${st(k)}</dd>`)}</dl>
            ${appeals.length ? html`<div class="stack" style="gap:6px">${appeals.slice(0, 5).map((a) => {
              const c = cl.criteria.find((x) => x.id === a.criterion_id);
              const s = STATUS[a.status] || [a.status, 'outline'];
              return html`<a class="row" href="#/appeal/${a.id}" style="padding:8px 10px;border-radius:var(--r-ctl);background:var(--surface-2);color:var(--text)">
                <span class="grow"><b style="font-weight:500">№${a.id} · ${c ? c.title : a.criterion_id}</b> <span class="muted small">${a.conversation_id}</span></span>
                <span class="pill ${s[1]}">${s[0]}</span></a>`;
            })}</div>` : html`<p class="muted small" style="margin:0">Апелляцию можно подать из карточки оценки</p>`}
          </section>
          <section class="card"><div class="card-head"><h2>Самые низкие оценки</h2><a class="chev small" href="#/evaluations">Все</a></div>
            <div class="stack" style="gap:6px">${worst.map((r) => html`<a class="row" href="${evLink(r.conversation_id)}" style="padding:8px 10px;border-radius:var(--r-ctl);background:var(--surface-2);color:var(--text)">
              <span class="grow"><b style="font-weight:500">${r.conversation_id}</b> <span class="muted small">${CQA.channelName(r.channel)} · ${r.language}</span></span>
              ${r.gross_error ? html`<span class="pill danger">${icon('flag', 12)}грубая</span>` : ''}${CQA.scoreHtml(r.total)}</a>`)}</div>
          </section>
        </div>`;
    },
  });
})();
