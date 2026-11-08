/* Точность ИИ: AI answers vs reviewer decisions on appeals, plus benchmark results of the model. */
(function () {
  'use strict';
  const { html, icon, api, fmt } = CQA;

  // Measured offline on labelled sets (bench/RESULTS.md): 80 items per set, gross = gross-violation recall.
  const BENCH = [
    { model: 'Gemma 4 26B-A4B', role: 'используется', dev: 0.988, hold: 1.0, gross: '100%', cost: '≈ $0.0022', hint: 'Цена OpenRouter: $0.0675 / $0.225 за 1M токенов, ≈ 2.9k + 8.8k токенов на диалог. В работе 3 прохода с голосованием: ≈ $0.0065 за диалог', speed: '~28 с' },
    { model: 'DeepSeek Flash', role: 'сравнение', dev: 0.992, hold: 0.996, gross: '100%', cost: '≈ $0.0006', speed: '~12 с' },
    { model: 'Claude Sonnet 5.5', role: 'сравнение', dev: 0.988, hold: 1.0, gross: '100%', cost: '$0.022', speed: '~11 с' },
    { model: 'Qwen3.8 Flash-Next', role: 'сравнение', dev: 0.988, hold: 0.975, gross: '100%', cost: '≈ $0.0033', hint: 'Этой модели нет на OpenRouter: оценка по цене Qwen3.8 Flash ($0.15 / $0.47 за 1M токенов)', speed: '~23 с' },
    { model: 'DeepSeek Flash без рассуждений', role: 'отклонено', dev: 0.975, hold: 0.944, gross: '67%', cost: '≈ $0.0004', speed: '~7 с', hint: 'Пропускает грубые ошибки и неверные факты' },
  ];

  CQA.route('accuracy', {
    title: 'Точность ИИ',
    crumbs: () => [{ label: 'Точность ИИ' }],
    async render() {
      const [appeals, evals] = await Promise.all([api('/appeals'), api('/evaluations')]);
      const decided = appeals.filter((a) => a.decision);
      const cls = {};
      for (const a of appeals) { const k = `${a.checklist_id}@${a.checklist_version}`; if (!cls[k]) cls[k] = await CQA.checklist(a.checklist_id, a.checklist_version).catch(() => null); }
      const per = {};
      let over = 0, under = 0, appl = 0, changed = 0;
      for (const a of appeals) {
        const cl = cls[`${a.checklist_id}@${a.checklist_version}`];
        const c = cl && cl.criteria.find((x) => x.id === a.criterion_id);
        const k = c ? c.title : a.criterion_id;
        const row = (per[k] = per[k] || { title: k, section: c ? c.section : '', disputed: 0, decided: 0, confirmed: 0, changed: 0, over: 0, under: 0, appl: 0, pending: 0 });
        row.disputed++;
        if (!a.decision) { row.pending++; continue; }
        row.decided++;
        if (a.decision.action !== 'change') { row.confirmed++; continue; }
        row.changed++; changed++;
        const before = a.decision.answer_before, after = a.decision.answer_after;
        if (before === 'na' || after === 'na') { row.appl++; appl++; continue; }
        const fb = c ? CQA.fraction(c, before) : 0, fa = c ? CQA.fraction(c, isNaN(after) ? after : Number(after)) : 0;
        if (fb > fa) { row.over++; over++; } else if (fb < fa) { row.under++; under++; }
      }
      const rows = Object.values(per).sort((a, b) => b.disputed - a.disputed);
      const acc = decided.length ? (decided.length - changed) / decided.length : null;
      const review = evals.reduce((s, e) => s + (e.needs_review || 0), 0);
      return html`
        <div class="page-head"><h1>Точность ИИ</h1></div>
        <div class="grid k4">
          <div class="kpi"><span class="lbl">Проверено пунктов</span><span class="val">${decided.length}</span><span class="sub">ещё ${appeals.length - decided.length} ожидают</span></div>
          <div class="kpi"><span class="lbl">Точность по апелляциям</span><span class="val">${acc == null ? '—' : html`<span class="score ${CQA.scoreTone(acc * 100)}">${fmt.pct(acc)}</span>`}</span></div>
          <div class="kpi"><span class="lbl">Исправлено</span><span class="val">${changed}</span><span class="sub">завышал ${over} · занижал ${under}</span></div>
          <div class="kpi"><span class="lbl">Нужна проверка</span><span class="val">${review}</span><span class="sub">пунктов в ${evals.length} оценках</span></div>
        </div>
        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>По критериям</h2></div>
          ${rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Критерий</th><th class="num">Оспорено</th><th class="num">Решено</th><th class="num">Подтверждено</th><th class="num">Исправлено</th>
            <th class="num" data-tip="ИИ поставил лучше, чем проверяющий">Завышал</th><th class="num" data-tip="ИИ поставил хуже, чем проверяющий">Занижал</th><th class="num" data-tip="Ошибка в N/A: критерий применим или нет">Применимость</th><th class="num">Точность</th></tr></thead>
            <tbody>${rows.map((x) => html`<tr><td><b style="font-weight:500">${x.title}</b><div class="muted small">${x.section}</div></td><td class="num">${x.disputed}</td><td class="num">${x.decided}</td>
              <td class="num">${x.confirmed}</td><td class="num">${x.changed}</td><td class="num">${x.over}</td><td class="num">${x.under}</td><td class="num">${x.appl}</td>
              <td class="num">${x.decided ? html`<span class="score ${CQA.scoreTone((100 * x.confirmed) / x.decided)}">${fmt.pct(x.confirmed / x.decided, 0)}</span>` : html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>`
          : CQA.empty('Апелляций пока нет')}</section>
        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>Сравнение моделей</h2>
            </div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Модель</th><th></th><th class="num">Тест 1</th><th class="num">Тест 2</th><th class="num">Грубые ${CQA.hint('Доля найденных грубых ошибок')}</th><th class="num">Цена диалога</th><th class="num">Время</th></tr></thead>
            <tbody>${BENCH.map((b) => html`<tr><td><b style="font-weight:500">${b.model}</b></td>
              <td><span class="pill ${b.role === 'используется' ? 'ok' : b.role === 'отклонено' ? 'danger' : 'outline'}">${b.role}</span></td>
              <td class="num">${fmt.pct(b.dev)}</td><td class="num">${fmt.pct(b.hold)}</td><td class="num">${b.gross}</td><td class="num"><span class="row" style="gap:6px;flex-wrap:nowrap">${b.cost}${b.hint ? CQA.hint(b.hint) : ''}</span></td><td class="num">${b.speed}</td></tr>`)}</tbody></table></div>
        </section>`;
    },
  });
})();
