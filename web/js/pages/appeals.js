/* Апелляции: reviewer queue (#/appeals) and decision page (#/appeal/<id>). */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.appeals = { list: [], cls: {}, q: '', status: '', crit: '', sort: 'id', dir: -1, ap: null, ev: null, cl: null });

  // the operator's point of view: was my appeal accepted?
  const STATUS = { pending: ['На рассмотрении', 'warn'], changed: ['Оценка исправлена', 'ok'], confirmed: ['Отклонена', 'outline'] };
  CQA.APPEAL_STATUS = STATUS;
  const r2 = (v) => Math.round(v * 100) / 100;
  const ansPill = (c, v) => { const x = c ? CQA.answerView(c, v) : { label: String(v), tone: 'na' }; return html`<span class="ans ${x.tone}">${x.label}</span>`; };

  /** What happened, in one place: answer before → after, total before → after, a plain-language summary. */
  CQA.appealOutcome = (a, c) => {
    const d = a.decision;
    if (!d) return { answer: ansPill(c, a.disputed.answer), total: html`<span class="muted">—</span>`, text: 'Ждёт решения проверяющего' };
    const delta = r2((d.total_after ?? 0) - (d.total_before ?? 0));
    if (d.action === 'change') {
      return {
        answer: html`<span class="row" style="gap:6px;flex-wrap:nowrap">${ansPill(c, d.answer_before)}<span class="muted">→</span>${ansPill(c, d.answer_after)}</span>`,
        total: html`<span class="row" style="gap:6px;flex-wrap:nowrap">${CQA.scoreHtml(d.total_before)}<span class="muted">→</span>${CQA.scoreHtml(d.total_after)}${delta ? html`<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${fmt.score(Math.abs(delta))}</span>` : ''}</span>`,
        text: `Оценка исправлена${delta ? `, итог ${delta > 0 ? 'вырос' : 'снизился'} на ${fmt.score(Math.abs(delta))}` : ''}`,
      };
    }
    return {
      answer: html`<span class="row" style="gap:6px;flex-wrap:nowrap">${ansPill(c, d.answer_before)}<span class="muted small">оставлено</span></span>`,
      total: html`<span class="row" style="gap:6px;flex-wrap:nowrap">${CQA.scoreHtml(d.total_after)}<span class="muted small">без изменений</span></span>`,
      text: 'Оценка ИИ оставлена, итог не изменился',
    };
  };

  /** Client-side mirror of cqa/scoring.py, used only for the live "new total" preview. */
  CQA.previewTotal = (cl, answers) => {
    let applicable = 0, earned = 0, any = false;
    for (const c of cl.criteria) {
      if (!(c.weight > 0) || !(c.id in answers)) continue;
      const f = CQA.fraction(c, answers[c.id]);
      if (f == null) { if (cl.na_policy === 'full_credit') { applicable += c.weight; earned += c.weight; } continue; }
      any = true; applicable += c.weight; earned += c.weight * f;
    }
    if (!any || applicable <= 0) return null;
    const p = Math.pow(10, cl.rounding.decimals);
    return Math.round((100 * earned / applicable) * p + 1e-9) / p;
  };

  async function checklistFor(a) { return CQA.checklist(a.checklist_id, a.checklist_version); }

  /* ---------- list: like «Оценки» — KPIs, filters, every status stays in the table ---------- */
  function rows() {
    const q = S.q.trim().toLowerCase();
    const out = S.list.filter((a) => (!q || a.conversation_id.toLowerCase().includes(q) || String(a.id) === q)
      && (!S.status || a.status === S.status) && (!S.crit || a.criterion_id === S.crit));
    const key = { id: (a) => a.id, created: (a) => a.created_at || 0, decided: (a) => a.decided_at || 0 }[S.sort];
    return out.sort((x, y) => (key(x) > key(y) ? 1 : key(x) < key(y) ? -1 : 0) * S.dir);
  }
  const sortBtn = (k, label) => html`<button class="th-sort" data-act="ap-sort" data-k="${k}">${label}${S.sort === k ? (S.dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
  function table() {
    const list = rows();
    if (!list.length) return CQA.empty('Апелляций нет', S.list.length ? 'Измените фильтры.' : 'Апелляции подаются из карточки оценки');
    return html`<div class="table-wrap"><table class="table">
      <thead><tr><th>${sortBtn('id', '№')}</th><th>Звонок</th><th>Критерий</th><th>Комментарий</th><th>${sortBtn('created', 'Подана')}</th><th>${sortBtn('decided', 'Статус')}</th><th>Оценка</th><th>Итог диалога</th><th>Ответ проверяющего</th></tr></thead>
      <tbody>${list.map((a) => {
        const cl = S.cls[`${a.checklist_id}@${a.checklist_version}`];
        const c = cl && cl.criteria.find((x) => x.id === a.criterion_id);
        const st = STATUS[a.status] || [a.status, 'outline'];
        const o = CQA.appealOutcome(a, c);
        const reason = a.decision ? a.decision.reason : '';
        return html`<tr class="click" data-act="ap-open" data-id="${a.id}" tabindex="0">
          <td class="muted">${a.id}</td>
          <td class="nowrap"><a href="#/appeal/${a.id}"><b style="font-weight:500">${a.conversation_id}</b></a>
            ${a.eval_no ? html`<div class="muted small">оценка №${a.eval_no}${a.eval_latest ? '' : ' · не последняя'}</div>` : ''}</td>
          <td>${c ? c.title : a.criterion_id}</td>
          <td style="max-width:260px"><span class="small">${a.comment.length > 100 ? a.comment.slice(0, 100) + '…' : a.comment}</span></td>
          <td class="muted small nowrap">${fmt.date(a.created_at)}</td>
          <td class="nowrap"><span class="pill ${st[1]}">${st[0]}</span>${a.decided_at ? html`<div class="muted small" style="margin-top:4px">${fmt.date(a.decided_at)}</div>` : ''}</td>
          <td class="nowrap">${o.answer}</td>
          <td class="nowrap">${o.total}</td>
          <td style="max-width:280px"><span class="small ${reason ? '' : 'muted'}">${reason ? (reason.length > 100 ? reason.slice(0, 100) + '…' : reason) : '—'}</span></td>
        </tr>`;
      })}</tbody></table></div>`;
  }
  const paint = () => { const t = document.getElementById('ap-table'); if (t) t.innerHTML = toStr(table()); };

  CQA.route('appeals', {
    title: 'Апелляции',
    crumbs: () => [{ label: 'Апелляции' }],
    async render(r) {
      if (r.query.status !== undefined) S.status = r.query.status;
      const list = await api('/appeals');
      S.list = list;
      S.cls = {};
      for (const a of list) { const k = `${a.checklist_id}@${a.checklist_version}`; if (!S.cls[k]) S.cls[k] = await checklistFor(a).catch(() => null); }
      const n = (st) => list.filter((a) => a.status === st).length;
      const decided = n('changed') + n('confirmed');
      const crits = {};
      list.forEach((a) => { const cl = S.cls[`${a.checklist_id}@${a.checklist_version}`]; const c = cl && cl.criteria.find((x) => x.id === a.criterion_id); crits[a.criterion_id] = c ? c.title : a.criterion_id; });
      return html`
        <div class="page-head"><h1>${CQA.isOperator() ? 'Мои апелляции' : 'Апелляции'} <span class="count">· ${list.length}</span></h1></div>
        <div class="grid k4">
          <div class="kpi"><span class="lbl">Всего</span><span class="val">${list.length}</span></div>
          <div class="kpi"><span class="lbl">На рассмотрении</span><span class="val" style="color:${n('pending') ? 'var(--warn-text)' : 'inherit'}">${n('pending')}</span></div>
          <div class="kpi"><span class="lbl">Оценка исправлена</span><span class="val" style="color:${n('changed') ? 'var(--ok-text)' : 'inherit'}">${n('changed')}</span><span class="sub">${decided ? `${fmt.pct(n('changed') / decided, 0)} решённых · оценка исправлена` : ''}</span></div>
          <div class="kpi"><span class="lbl">Отклонены</span><span class="val">${n('confirmed')}</span><span class="sub">${decided ? `${fmt.pct(n('confirmed') / decided, 0)} решённых · оценка ИИ оставлена` : ''}</span></div>
        </div>
        <div class="card tight">
          <div class="toolbar" style="padding:14px 16px;border-bottom:1px solid var(--border)">
            <label class="search"><span class="sr">Поиск</span>${icon('search', 16)}<input class="input" type="search" placeholder="Поиск по ID или №" value="${S.q}" data-on-input="ap-q"></label>
            ${CQA.dd({ value: S.status, onChange: 'ap-f', data: { k: 'status' }, label: 'Статус', options: [{ value: '', label: 'Все статусы' }, ...Object.entries(STATUS).map(([k, v]) => ({ value: k, label: `${v[0]} · ${n(k)}` }))] })}
            ${CQA.dd({ value: S.crit, onChange: 'ap-f', data: { k: 'crit' }, label: 'Критерий', options: [{ value: '', label: 'Все критерии' }, ...Object.entries(crits).map(([k, v]) => ({ value: k, label: v }))] })}
          </div>
          <div id="ap-table">${table()}</div>
        </div>`;
    },
  });

  CQA.actions['ap-q'] = (el) => { S.q = el.value; paint(); };
  CQA.actions['ap-f'] = (el) => { S[el.dataset.k] = el.value; paint(); };
  CQA.actions['ap-sort'] = (el) => { const k = el.dataset.k; S.dir = S.sort === k ? -S.dir : -1; S.sort = k; paint(); };
  CQA.actions['ap-open'] = (el, e) => { if (!e.target.closest('a')) CQA.go(`#/appeal/${el.dataset.id}`); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-act="ap-open"]')) CQA.go(`#/appeal/${e.target.dataset.id}`); });

  function fragment(a, ev) {
    const turns = a.fragment && a.fragment.length ? a.fragment : [];
    if (!turns.length) return html`<p class="muted small">Реплики не указаны</p>`;
    const call = ev && (ev.dialog.audio_url || (ev.dialog.channel || '').includes('call'));
    const link = (t) => `#/eval/${encodeURIComponent(a.conversation_id)}?cl=${a.checklist_id}${a.eval_latest || !a.eval_id ? '' : `&e=${encodeURIComponent(a.eval_id)}`}&t=${t.idx + 1}`;
    return html`<div class="chat frag-chat">${turns.map((t) => html`<div class="msg ${t.speaker}">
      ${t.speaker !== 'system' ? html`<div class="mline"><b>${CQA.speakerName(t.speaker)}</b><span>#${t.idx + 1} · ${call ? fmt.mmss(t.offset_sec) : (/T\d\d:\d\d/.test(t.timestamp || '') ? t.timestamp.slice(11, 16) : t.timestamp)}</span>
        <a class="small" href="${link(t)}" aria-label="Открыть реплику #${t.idx + 1} в транскрипте">в транскрипте</a></div>` : ''}
      <div class="bubble">${t.text}</div></div>`)}</div>`;
  }

  function decisionForm(a, c, ev, cl) {
    const opts = CQA.answerOptions(c).filter((o) => String(o.value) !== String(a.disputed.answer));
    return html`<form class="stack" data-on-submit="ap-decide" data-on-change="ap-preview">
      <fieldset class="radio-cards" style="border:0;padding:0;margin:0"><legend class="sr">Решение</legend>
        <label class="radio-card"><input type="radio" name="action" value="confirm" checked><div><b>Подтвердить оценку</b><span>итог не меняется</span></div></label>
        <label class="radio-card"><input type="radio" name="action" value="change"><div><b>Изменить оценку</b><span>итог пересчитается</span></div></label>
      </fieldset>
      <div class="field" id="ap-new" hidden><label for="ap-ans">Новый ответ</label>
        ${CQA.dd({ name: 'new_answer', id: 'ap-ans', full: true, value: opts[0] && opts[0].value, options: opts })}</div>
      <div class="field"><label for="ap-reason">Причина решения</label>
        <textarea id="ap-reason" name="reason" class="textarea" required placeholder="Например: в реплике #67 оператор подвёл итог"></textarea></div>
      <div class="notice" id="ap-prev">${icon('info', 16)}<div>Итог: ${CQA.scoreHtml(ev.final.score.total)} — без изменений</div></div>
      <div class="row"><button class="btn primary" type="submit">Сохранить решение</button>
        <a class="btn link chev" href="#/eval/${encodeURIComponent(a.conversation_id)}?cl=${a.checklist_id}${a.eval_latest || !a.eval_id ? '' : `&e=${encodeURIComponent(a.eval_id)}`}">Открыть карточку</a></div>
    </form>`;
  }

  CQA.route('appeal', {
    title: 'Апелляция',
    crumbs: (r) => [{ label: 'Апелляции', href: '#/appeals' }, { label: `№${r.args[0]}` }],
    async render(r) {
      const id = Number(r.args[0]);
      const a = (await api('/appeals')).find((x) => x.id === id);
      if (!a) throw new Error(`Апелляция №${id} не найдена`);
      const [ev, cl] = await Promise.all([
        api(`/evaluations/${encodeURIComponent(a.conversation_id)}?checklist_id=${encodeURIComponent(a.checklist_id)}${a.eval_id ? `&eval_id=${encodeURIComponent(a.eval_id)}` : `&version=${a.checklist_version}`}`),
        checklistFor(a),
      ]);
      S.ap = a; S.ev = ev; S.cl = cl;
      const c = cl.criteria.find((x) => x.id === a.criterion_id);
      const v = CQA.answerView(c, a.disputed.answer);
      const st = STATUS[a.status] || [a.status, 'outline'];
      const d = a.decision;
      return html`
        <div class="page-head"><a class="back-link" href="#/appeals">${icon('back', 16)}Апелляции</a>
          <h1>Апелляция №${a.id}</h1><span class="pill ${st[1]}">${st[0]}</span></div>
        <div class="appeal-grid">
          <div class="stack">
            <section class="card"><div class="card-head"><h2>Спорная оценка</h2><span class="ans ${v.tone}">${v.label}</span></div>
              <div class="stack" style="gap:10px">
                <div><b style="font-weight:600">${c.title}</b><div class="muted small">${c.section || ''} · ${a.conversation_id}</div></div>
                <div class="small muted">${c.description}</div>
                <div class="small">${a.disputed.answer === 'na' ? html`<b style="font-weight:500">Причина N/A:</b> ${a.disputed.na_reason || a.disputed.explanation}` : a.disputed.explanation}</div>
                ${a.disputed.checked_range ? html`<span class="chip range" style="align-self:flex-start">Проверено #${a.disputed.checked_range[0] + 1}–#${a.disputed.checked_range[1] + 1}</span>` : ''}
              </div></section>
            <section class="card"><div class="card-head"><h2>Комментарий оператора</h2><span class="muted small">${fmt.date(a.created_at)}</span></div>
              <p style="white-space:pre-wrap">${a.comment}</p></section>
            <section class="card"><div class="card-head"><h2>Фрагмент диалога</h2></div>${fragment(a, ev)}</section>
          </div>
          <div class="stack">
            <section class="card"><div class="card-head"><h2>Итог диалога</h2></div>
              <div class="row"><span class="muted small">Исходная оценка ИИ</span>${CQA.scoreHtml(ev.original.score.total)}<span class="muted small">· текущий итог</span>${CQA.scoreHtml(ev.final.score.total)}
                ${ev.final.score.gross_error ? html`<span class="pill danger">${icon('flag', 12)}грубая ошибка</span>` : ''}</div></section>
            <section class="card ${a.status === 'pending' ? 'ai' : ''}"><div class="card-head"><h2>${d ? 'Результат' : 'Решение проверяющего'}</h2></div>
              ${d ? html`<div class="stack" style="gap:12px">
                  <div class="verdict ${a.status}"><b>${CQA.appealTag(a, c).label}</b><span>${CQA.appealOutcome(a, c).text}</span></div>
                  <dl class="kv left" style="margin:0">
                    <dt>Оценка</dt><dd>${CQA.appealOutcome(a, c).answer}</dd>
                    <dt>Итог диалога</dt><dd>${CQA.appealOutcome(a, c).total}</dd>
                    <dt>Решение</dt><dd>${fmt.date(a.decided_at)}${d.reviewer ? ` · ${d.reviewer}` : ''}</dd>
                  </dl>
                  <div class="qbox"><span class="pane-title">Ответ проверяющего</span><p style="margin:6px 0 0;white-space:pre-wrap">${d.reason}</p></div>
                  <a class="btn link chev" style="align-self:flex-start" href="#/eval/${encodeURIComponent(a.conversation_id)}?cl=${a.checklist_id}${a.eval_latest || !a.eval_id ? '' : `&e=${encodeURIComponent(a.eval_id)}`}">Карточка: исходная оценка, решение и итог</a></div>`
              : CQA.can('decide') ? decisionForm(a, c, ev, cl)
              : html`<div class="notice">${icon('info', 16)}<div>Решения принимает ${CQA.whoCan('decide')}</div></div>`}
            </section>
          </div>
        </div>`;
    },
  });

  CQA.actions['ap-preview'] = (form) => {
    const fd = new FormData(form);
    const change = fd.get('action') === 'change';
    form.querySelector('#ap-new').hidden = !change;
    const prev = form.querySelector('#ap-prev');
    const cur = S.ev.final.score.total;
    if (!change) { prev.innerHTML = toStr(html`${icon('info', 16)}<div>Итог: ${CQA.scoreHtml(cur)} — без изменений</div>`); return; }
    const answers = Object.fromEntries(S.ev.final.results.map((r) => [r.criterion_id, r.answer]));
    let nv = fd.get('new_answer');
    const c = S.cl.criteria.find((x) => x.id === S.ap.criterion_id);
    if (c.type === 'scale' && nv !== 'na') nv = Number(nv);
    answers[c.id] = nv;
    const next = CQA.previewTotal(S.cl, answers);
    const flagChange = c.critical ? html` · флаг грубой ошибки: ${CQA.answerView(c, nv).tone === 'danger' ? 'будет установлен' : 'будет снят'}` : '';
    prev.innerHTML = toStr(html`${icon('info', 16)}<div>Итог будет пересчитан: ${CQA.scoreHtml(cur)} → ${CQA.scoreHtml(next)}${flagChange}</div>`);
  };
  CQA.actions['ap-decide'] = async (form) => {
    const fd = new FormData(form);
    const body = { action: fd.get('action'), reason: fd.get('reason').trim(), reviewer: CQA.ROLES[CQA.role()].name };
    if (!body.reason) throw new Error('Укажите причину решения');
    if (body.action === 'change') {
      const c = S.cl.criteria.find((x) => x.id === S.ap.criterion_id);
      const nv = fd.get('new_answer');
      body.new_answer = c.type === 'scale' && nv !== 'na' ? Number(nv) : nv;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api(`/appeals/${S.ap.id}/decision`, { method: 'POST', body });
      CQA.toast(`Решение сохранено. Итог: ${fmt.score(res.original_total)} (ИИ) → ${fmt.score(res.final_total)}`);
      CQA.render();
    } finally { btn.disabled = false; }
  };
})();
