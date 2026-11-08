/* Карточка оценки — рабочее место в три колонки: переписка | критерии по секциям | сведения о диалоге.
   Route: #/eval/<cid>?cl=<checklist>&e=<call>%23<n> (an earlier evaluation)&t=<turn №> */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.card = { ev: null, cl: null, sel: null, openAppeal: null });

  const turnNo = (idx) => idx + 1;                       // organizers number turns from 1
  const isCall = (d) => d && (d.audio_url || (d.channel || '').toLowerCase().includes('call'));
  const toneVar = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' };
  const hms = (sec) => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600); return h ? `${h}:${fmt.mmss(sec % 3600)}` : fmt.mmss(sec); };
  const turnTime = (d, t) => (isCall(d) ? fmt.mmss(t.offset_sec) : (t.timestamp || '').slice(-5));
  const link = (t) => `#/eval/${encodeURIComponent(S.ev.conversation_id)}?cl=${S.cl.id}${S.ev.is_latest ? '' : `&e=${encodeURIComponent(S.ev.eval_id)}`}&t=${turnNo(t)}`;
  /** «Оценка №2 · 07 нояб., 23:19 · Gemma 4 26B-A4B · Строгий» */
  /** picker label: just the run («Прогон №5»), marked when it is the call's latest evaluation */
  const evalName = (h) => (h.run_id ? `Прогон №${h.run_id}` : `Оценка №${h.eval_no}`);
  const evalLabel = (h) => `${evalName(h)}${h.latest ? ' · последняя' : ''}`;

  function status(ev) {
    const cur = ev.appeals;
    if (cur.some((a) => a.status === 'pending')) return ['На апелляции', 'warn'];
    if (cur.some((a) => a.status === 'changed')) return ['Проверено человеком · исправлено', 'ok'];
    if (cur.some((a) => a.status === 'confirmed')) return ['Проверено человеком · без изменений', ''];
    if (ev.decisions.length) return ['Проверено человеком', 'ok'];
    return ['Оценено ИИ', ''];
  }

  /* ---------- left: conversation ---------- */
  function conversation(d) {
    const call = isCall(d);
    const dur = Math.max(0, ...d.turns.map((t) => t.offset_sec || 0));
    let lastDay = '';
    return html`<aside class="pane sticky" aria-label="Переписка">
      <div class="pane-head"><span class="pane-title">${call ? 'Звонок' : 'Переписка'}</span><span class="small muted">${d.turns.length} реплик · ${hms(dur)}</span></div>
      ${call && d.audio_url ? html`<div style="padding:10px 16px;border-bottom:1px solid var(--border)"><audio id="card-audio" controls preload="none" src="${CQA.apiUrl(`/dialogs/${encodeURIComponent(d.conversation_id)}/audio`)}"></audio></div>` : ''}
      <div class="pane-body chat" id="tr-body">${d.turns.map((t) => {
        const day = /^\d{4}-\d{2}-\d{2}T/.test(t.timestamp || '') ? new Date(t.timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
        const sep = day && day !== lastDay ? html`<div class="day-sep">${day}</div>` : '';
        if (day) lastDay = day;
        return html`${sep}<div class="msg ${t.speaker}" id="turn-${t.idx}">
          ${t.speaker !== 'system' ? html`<div class="mline"><b>${CQA.speakerName(t.speaker)}</b><span>#${turnNo(t.idx)} · ${turnTime(d, t)}</span>
            ${call && d.audio_url ? html`<button class="seek" data-act="card-seek" data-sec="${t.offset_sec}" aria-label="Слушать с ${fmt.mmss(t.offset_sec)}">${icon('play', 10)}</button>` : ''}</div>` : ''}
          <div class="bubble">${t.text}</div></div>`;
      })}</div>
    </aside>`;
  }

  /* ---------- centre: summary + criteria grouped by section ---------- */
  function summary(ev, cl) {
    const sc = ev.final.score, d = ev.dialog;
    const tone = CQA.scoreTone(sc.total);
    const na = ev.final.results.filter((x) => x.answer === 'na').length;
    const changed = ev.original.score.total !== sc.total;
    return html`<section class="pane sum-strip">
      <div class="sum-cell"><span class="pane-title">Итог</span>
        <span class="big score ${tone}">${sc.total == null ? '—' : fmt.score(sc.total)}</span>
        <div class="progress"><i style="width:${Math.max(0, Math.min(100, sc.total || 0))}%;background:${toneVar[tone] || 'var(--text-3)'}"></i></div>
        <span class="sub">${changed ? html`ИИ: ${fmt.score(ev.original.score.total)} → после пересмотра` : 'из 100'}${na ? ` · N/A: ${na}` : ''}</span></div>
      <div class="sum-cell"><span class="pane-title">Грубые ошибки</span>
        <span class="v" style="color:${sc.gross_error ? 'var(--danger-text)' : 'var(--ok-text)'}">${sc.gross_error ? 'Выявлены' : 'Нет'}</span></div>
      <div class="sum-cell"><span class="pane-title">Диалог</span>
        <span class="v">${CQA.channelName(d.channel)} · ${d.language}</span><span class="sub">${d.turns.length} реплик</span></div>
      <div class="sum-cell"><span class="pane-title">Чек-лист</span>
        <span class="v" title="${cl.title || cl.id}">${cl.title || cl.id}</span><span class="sub">${cl.criteria.length} критериев</span></div>
    </section>`;
  }

  function quotes(r, d) {
    const turns = (r.evidence || []).filter((i) => d.turns[i]);
    if (turns.length) {
      return html`<div class="qbox"><span class="pane-title">Из ${isCall(d) ? 'разговора' : 'переписки'}</span>
        ${turns.map((i) => { const t = d.turns[i]; return html`<a class="qline" href="${link(i)}"><span class="tchip">${CQA.speakerName(t.speaker)} · ${turnTime(d, t)}</span><span class="qt">${t.text}</span></a>`; })}</div>`;
    }
    if (r.checked_range && r.checked_range.length === 2) {
      const [a, b] = r.checked_range;
      return html`<div class="qbox"><span class="pane-title">Проверено</span>
        <a class="qline" href="${link(a)}"><span class="tchip">#${turnNo(a)}–#${turnNo(b)}</span><span class="qt">Нужное действие на этом участке не найдено</span></a></div>`;
    }
    return '';
  }

  function critRow(c, n, ev) {
    const d = ev.dialog;
    const r = ev.final.results.find((x) => x.criterion_id === c.id) || { answer: 'na', evidence: [] };
    const o = ev.original.results.find((x) => x.criterion_id === c.id);
    const row = (ev.final.score.criteria || []).find((x) => x.criterion_id === c.id) || {};
    const v = CQA.answerView(c, r.answer);
    const f = CQA.fraction(c, r.answer);
    const appeals = ev.appeals.filter((a) => a.criterion_id === c.id);   // appeals of THIS evaluation
    const pending = appeals.find((a) => a.status === 'pending');
    const changed = o && String(o.answer) !== String(r.answer);
    const isNa = r.answer === 'na';
    const last = appeals[0];                       // newest appeal decides how the row is marked
    const tag = last && CQA.appealTag(last, c);
    const ov = o && CQA.answerView(c, o.answer);
    return html`<article class="crow t-${v.tone} ${S.sel === c.id ? 'sel' : ''} ${last ? `appealed ap-${last.status}` : ''}" id="crit-${c.id}" data-act="card-sel" data-id="${c.id}"
      aria-label="${c.title}${tag ? ` — оспорено: ${tag.label}` : ''}" ${tag ? raw(`data-tip="${CQA.esc(`Оспоренный пункт · ${tag.tip}`)}"`) : ''}>
      <div class="crow-top">
        <span class="num-dot" aria-hidden="true">${n}</span>
        <div class="t"><b>${c.title}</b>
          <div class="row">${c.weight ? html`<span class="pill outline">Вес ${c.weight}</span>` : html`<span class="pill outline">Без баллов</span>`}
            ${c.weight && f != null ? html`<span class="pill">${fmt.num(f * row.effective_weight, 1)} б.</span>` : ''}
            ${r.source === 'reviewer' ? html`<span class="pill accent">Проверяющий</span>` : ''}
            ${r.needs_review ? html`<span class="pill danger" data-tip="ИИ не уверен в ответе">нужна проверка</span>` : ''}
            ${tag ? html`<span class="pill ${tag.tone} ap-flag" data-tip="${tag.tip}">${CQA.icon('flag', 12)}Оспорено</span>` : ''}</div></div>
        ${changed ? html`<span class="ans-change" data-tip="Ответ ИИ «${ov.label}» исправлен проверяющим на «${v.label}»"><span class="ans was">${ov.label}</span><span class="muted">→</span><span class="ans ${v.tone}">${v.label}</span></span>`
          : html`<span class="ans ${v.tone}">${v.label}</span>`}
      </div>
      ${c.description ? html`<div class="def">${c.description.length > 220 ? c.description.slice(0, 220) + '…' : c.description}</div>` : ''}
      ${quotes(r, d)}
      <div class="qbox ai"><span class="pane-title">${isNa ? 'Почему N/A' : 'Комментарий ИИ'}</span>
        <div class="ai-text">${(isNa ? r.na_reason || r.explanation : r.explanation || r.reasoning) || '—'}</div>
        ${changed ? html`<div class="change-line">ИИ: <span class="ans ${CQA.answerView(c, o.answer).tone}">${CQA.answerView(c, o.answer).label}</span> → проверяющий: <span class="ans ${v.tone}">${v.label}</span></div>` : ''}</div>
      ${appeals.map((a) => { const t = CQA.appealTag(a, c); return html`<a class="ap-strip ${a.status}" href="#/appeal/${a.id}">
        <span class="ap-strip-head">${CQA.icon('flag', 14)}<b>Апелляция №${a.id}</b><span class="pill ${t.tone}">${t.label}</span><span class="grow"></span><span class="ap-open">Открыть ›</span></span>
        <span class="ap-strip-line"><span class="who">Оператор</span>${a.comment}</span>
        ${a.decision ? html`<span class="ap-strip-line"><span class="who">Проверяющий</span>${a.decision.reason}</span>` : ''}</a>`; })}
      ${S.openAppeal === c.id ? appealForm(c)
        : !pending && CQA.can('appeal') ? html`<div class="row"><button class="btn link chev" data-act="card-appeal" data-id="${c.id}">Оспорить оценку</button></div>`
        : pending && CQA.can('decide') ? html`<div class="row"><a class="btn secondary sm" href="#/appeal/${pending.id}">Рассмотреть апелляцию</a></div>` : ''}
    </article>`;
  }

  function sections(ev, cl) {
    const groups = [];
    cl.criteria.forEach((c, i) => {
      const name = c.section || 'Критерии';
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, items: [] }));
      g.items.push({ c, n: i + 1 });
    });
    const secScore = ev.final.score.sections || {};
    return groups.map((g) => html`<section class="pane sec">
      <div class="sec-head"><span class="sec-name">${g.name}<span class="sec-n">${g.items.length}</span></span>
        ${g.name in secScore ? html`<span class="sec-score">Итог секции <b class="score ${CQA.scoreTone(secScore[g.name])}">${secScore[g.name] == null ? 'N/A' : fmt.score(secScore[g.name])}</b></span>` : ''}</div>
      ${g.items.map((x) => critRow(x.c, x.n, ev))}
    </section>`);
  }

  function appealForm(c) {
    return html`<form class="appeal-box" data-on-submit="card-appeal-send" data-id="${c.id}">
      <label class="sr" for="ap-${c.id}">Комментарий к апелляции</label>
      <textarea id="ap-${c.id}" name="comment" class="textarea" required placeholder="Почему оценка неверна?"></textarea>
      <div class="row"><button class="btn primary sm" type="submit">Отправить апелляцию</button><button class="btn link" type="button" data-act="card-appeal-cancel">Отмена</button></div>
    </form>`;
  }

  /* ---------- right: dialog details + history ---------- */
  function details(ev, cl) {
    const d = ev.dialog;
    const dur = Math.max(0, ...d.turns.map((t) => t.offset_sec || 0));
    const by = Object.fromEntries(cl.criteria.map((c) => [c.id, c]));
    const first = d.turns.find((t) => /^\d{4}-/.test(t.timestamp || ''));
    return html`<aside class="pane sticky ws-side" aria-label="Сведения">
      <div class="pane-body" style="padding:0">
        <div class="side-sec"><span class="pane-title">Диалог</span>
          <dl class="kv" style="margin:0">
            <dt>ID</dt><dd title="${d.conversation_id}">${d.conversation_id}</dd>
            <dt>Канал</dt><dd>${CQA.channelName(d.channel)}</dd>
            <dt>Язык</dt><dd>${CQA.langName(d.language)}</dd>
            ${first ? html`<dt>Дата</dt><dd>${new Date(first.timestamp).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>` : ''}
            <dt>Длительность</dt><dd>${hms(dur)}</dd>
            <dt>Реплик</dt><dd>${d.turns.length}</dd>
          </dl></div>
        <div class="side-sec"><span class="pane-title">Итог</span>
          <dl class="kv" style="margin:0">
            <dt>Оценка ИИ</dt><dd>${CQA.scoreHtml(ev.original.score.total)}</dd>
            <dt>Финальный</dt><dd>${CQA.scoreHtml(ev.final.score.total)}</dd>
            ${CQA.can('view_prompt') ? html`<dt>Промпт</dt><dd>${CQA.promptLabel(ev.original.prompt)}</dd>` : ''}
          </dl></div>
        <div class="side-sec"><span class="pane-title">История · ${1 + ev.appeals.length}</span>
          <div class="timeline">
            <div class="tl-item"><span class="dot"></span><div class="small"><b style="font-weight:500">Оценено ИИ</b><div class="muted">итог ${fmt.score(ev.original.score.total)}</div></div></div>
            ${ev.appeals.map((a) => {
              const c = by[a.criterion_id] || { title: a.criterion_id };
              const dec = a.decision;
              return html`<div class="tl-item"><span class="dot ${a.status === 'pending' ? 'warn' : a.status === 'changed' ? 'ok' : ''}"></span><div class="small">
                <a href="#/appeal/${a.id}"><b style="font-weight:500">Апелляция №${a.id}</b></a> · ${c.title}
                <div class="muted">${CQA.appealTag(a, by[a.criterion_id]).label}${dec ? (dec.total_after !== dec.total_before ? ` · итог ${fmt.score(dec.total_before)} → ${fmt.score(dec.total_after)}` : ' · итог без изменений') : ''}</div>
                <div class="muted">${fmt.date(a.decided_at || a.created_at)}</div></div></div>`;
            })}
          </div></div>
      </div>
    </aside>`;
  }

  /* ---------- transcript highlighting / jumping ---------- */
  function highlight(cid) {
    const body = document.getElementById('tr-body');
    if (!body) return;
    body.querySelectorAll('.hl,.rng').forEach((e) => e.classList.remove('hl', 'rng'));
    if (!cid) return;
    const r = S.ev.final.results.find((x) => x.criterion_id === cid);
    if (!r) return;
    (r.evidence || []).forEach((i) => { const e = document.getElementById(`turn-${i}`); if (e) e.classList.add('hl'); });
    if (r.checked_range && !(r.evidence || []).length) for (let i = r.checked_range[0]; i <= r.checked_range[1]; i++) { const e = document.getElementById(`turn-${i}`); if (e) e.classList.add('rng'); }
    const first = (r.evidence && r.evidence[0]) ?? (r.checked_range && r.checked_range[0]);
    if (first != null) scrollTurn(first, false);
  }
  function scrollTurn(idx, flash = true) {
    const el = document.getElementById(`turn-${idx}`);
    const body = document.getElementById('tr-body');
    if (!el || !body) return;
    if (window.innerWidth <= 1000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else body.scrollTo({ top: el.offsetTop - body.offsetTop - body.clientHeight / 3, behavior: 'smooth' });
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  function seek(sec, play) {
    const a = document.getElementById('card-audio');
    if (!a) return;
    const go = () => { a.currentTime = Math.max(0, Number(sec) - 1); if (play) a.play().catch(() => {}); };
    if (a.readyState >= 1) go(); else { a.preload = 'metadata'; a.addEventListener('loadedmetadata', go, { once: true }); a.load(); }
  }
  function jumpToTurnNo(n) {
    const idx = Number(n) - 1;
    if (!S.ev || isNaN(idx) || !S.ev.dialog.turns[idx]) return;
    scrollTurn(idx);
    if (isCall(S.ev.dialog)) seek(S.ev.dialog.turns[idx].offset_sec, false);
  }

  CQA.route('eval', {
    title: 'Оценка',
    async render(r) {
      const cid = r.args[0];
      const clId = r.query.cl || 'official';
      const ev = await api(`/evaluations/${encodeURIComponent(cid)}?checklist_id=${encodeURIComponent(clId)}${r.query.e ? `&eval_id=${encodeURIComponent(r.query.e)}` : ''}`);
      const cl = await CQA.checklist(clId, ev.checklist_version);
      if (!S.ev || S.ev.eval_id !== ev.eval_id) { S.sel = null; S.openAppeal = null; }
      S.ev = ev; S.cl = cl;
      const st = status(ev);
      return html`
        <div class="page-head">
          <a class="back-link" href="#/evaluations">${icon('back', 16)}Оценки</a>
          <h1 style="flex:0 1 auto">${cid}</h1><span class="pill ${st[1]}">${st[0]}</span><span class="grow"></span>
          ${CQA.can('evaluate') ? html`<button class="btn secondary" data-act="card-reeval">Оценить заново</button>` : ''}
        </div>
        <nav class="ev-strip" aria-label="Оценки звонка"><span class="ev-strip-l">Оценки звонка · ${ev.history.length}</span>
          ${ev.history.map((h) => html`<a class="ev-item ${h.eval_id === ev.eval_id ? 'on' : ''}" href="#/eval/${encodeURIComponent(cid)}?cl=${clId}${h.latest ? '' : `&e=${encodeURIComponent(h.eval_id)}`}"
              ${h.eval_id === ev.eval_id ? raw('aria-current="true"') : ''} data-tip="${fmt.date(h.created_at)} · ${CQA.modelName(h.model)}${h.appeals ? ` · апелляций ${h.appeals}` : ''}">
            <b>${evalName(h)}</b>${CQA.scoreHtml(h.total)}${h.latest ? html`<span class="pill ok" style="height:18px">последняя</span>` : ''}
            <span class="muted small">${fmt.date(h.created_at)}</span></a>`)}</nav>
        ${ev.is_latest ? '' : html`<div class="notice warn" style="margin-bottom:16px">${icon('info', 16)}<div>Вы смотрите <b>оценку №${ev.eval_no}</b> — звонок оценён позже ещё раз.
          <a href="#/eval/${encodeURIComponent(cid)}?cl=${clId}">Открыть последнюю оценку</a></div></div>`}
        ${ev.partial ? html`<div class="notice" style="margin-bottom:16px">${icon('info', 16)}<div>От этой оценки сохранились только ответы и итог — без цитат и комментариев.</div></div>` : ''}
        <div class="ws">
          ${conversation(ev.dialog)}
          <div class="stack" style="gap:16px;min-width:0">${summary(ev, cl)}${sections(ev, cl)}</div>
          ${details(ev, cl)}
        </div>`;
    },
    mounted(r) {
      if (S.sel) highlight(S.sel);
      if (r.query.t) jumpToTurnNo(r.query.t);
    },
    onQuery(q) {
      // another evaluation of the same call → full re-render; only a turn number → just jump
      const shown = S.ev && !S.ev.is_latest ? S.ev.eval_id : undefined;
      if ((q.e || undefined) !== shown) return CQA.render();
      if (q.t) jumpToTurnNo(q.t);
    },
  });

  CQA.actions['card-sel'] = (el, e) => {
    if (e.target.closest('a,button,textarea,input,form')) return;
    S.sel = S.sel === el.dataset.id ? null : el.dataset.id;
    document.querySelectorAll('.crow.sel').forEach((x) => x.classList.remove('sel'));
    if (S.sel) el.classList.add('sel');
    highlight(S.sel);
  };
  CQA.actions['card-seek'] = (el) => seek(el.dataset.sec, true);
  CQA.actions['card-eval'] = (el) => {
    const h = S.ev.history.find((x) => x.eval_id === el.value);
    CQA.go(`#/eval/${encodeURIComponent(S.ev.conversation_id)}?cl=${S.cl.id}${h && h.latest ? '' : `&e=${encodeURIComponent(el.value)}`}`);
  };
  CQA.actions['card-appeal'] = (el) => { S.openAppeal = el.dataset.id; rerenderCrit(el.dataset.id, true); };
  CQA.actions['card-appeal-cancel'] = () => { const id = S.openAppeal; S.openAppeal = null; rerenderCrit(id); };
  CQA.actions['card-appeal-send'] = async (form) => {
    const comment = new FormData(form).get('comment').trim();
    if (!comment) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const a = await api('/appeals', { method: 'POST', body: { conversation_id: S.ev.conversation_id, criterion_id: form.dataset.id, comment, checklist_id: S.cl.id, eval_id: S.ev.eval_id } });
      S.openAppeal = null;
      CQA.toast(`Апелляция №${a.id} отправлена`);
      CQA.render();
    } finally { btn.disabled = false; }
  };
  CQA.actions['card-reeval'] = () => CQA.openEvaluate([S.ev.conversation_id], S.cl.id, 1);

  function rerenderCrit(id, focus) {
    const c = S.cl.criteria.find((x) => x.id === id);
    const el = document.getElementById(`crit-${id}`);
    if (!c || !el) return;
    el.outerHTML = toStr(critRow(c, S.cl.criteria.indexOf(c) + 1, S.ev));
    if (focus) { const t = document.getElementById(`ap-${id}`); if (t) t.focus(); }
  }
})();
