/* Чек-листы: list, versioned editor, apply to dialogs. Route: #/checklists/<id>?v=<version> */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.cl = { list: [], draft: null, versions: [], viewing: null, open: new Set(), dirty: false, prompts: [] });

  const blankCriterion = (n) => ({ id: `criterion_${n}`, section: '', title: 'Новый критерий', description: '', type: 'binary', scale: null,
    weight: 10, na_allowed: false, na_rule: '', critical: false, flag_on: 'no', requires_audio: false, deep_check: false });

  const weightSum = (cl) => cl.criteria.filter((c) => !c.critical).reduce((a, c) => a + (Number(c.weight) || 0), 0);

  function critEditor(c, i, n, ro) {
    const p = `c${i}.`;
    const s = c.scale || { min: 0, max: 2, steps: null, labels: {} };
    const labels = Object.entries(s.labels || {}).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `${k} = ${v}`).join('\n');
    const open = S.open.has(i);
    return html`<details class="crit-edit" ${open ? raw('open') : ''} data-i="${i}">
      <summary data-act="cl-toggle" data-i="${i}">
        <span class="idx">${i + 1}</span>
        <span class="grow"><b style="font-weight:600">${c.title || '—'}</b> <span class="muted small mono">${c.id}</span></span>
        <span class="pill">${c.type === 'scale' ? `шкала ${(s.steps && s.steps.length ? s.steps : [s.min, s.max]).join('/')}` : 'да / нет'}</span>
        ${c.na_allowed ? html`<span class="pill outline">N/A</span>` : ''}
        ${c.critical ? html`<span class="pill danger">грубая ошибка</span>` : html`<span class="pill accent">вес ${c.weight}</span>`}
        ${ro ? '' : html`<span class="row" style="gap:2px">
          <button type="button" class="btn ghost sm icon" data-act="cl-move" data-i="${i}" data-d="-1" aria-label="Выше" ${i === 0 ? raw('disabled') : ''}>${icon('up', 14)}</button>
          <button type="button" class="btn ghost sm icon" data-act="cl-move" data-i="${i}" data-d="1" aria-label="Ниже" ${i === n - 1 ? raw('disabled') : ''}>${icon('down', 14)}</button>
          <button type="button" class="btn ghost sm icon" data-act="cl-del" data-i="${i}" aria-label="Удалить критерий">${icon('trash', 14)}</button></span>`}
      </summary>
      <div class="body">
        <div class="field span2"><label for="${p}title">Название</label><input id="${p}title" name="${p}title" class="input" value="${c.title}" required></div>
        <div class="field"><label for="${p}id">Код (criterion_id)</label><input id="${p}id" name="${p}id" class="input mono" value="${c.id}" required pattern="[A-Za-z0-9_\\-]+" title="латиница, цифры, _ и -"></div>
        <div class="field"><label for="${p}section">Секция</label><input id="${p}section" name="${p}section" class="input" value="${c.section || ''}" list="cl-sections"></div>
        <div class="field span4"><label for="${p}description">Формулировка</label><textarea id="${p}description" name="${p}description" class="textarea">${c.description || ''}</textarea></div>
        <div class="field"><label for="${p}type">Тип ответа</label>${CQA.dd({ name: p + 'type', id: p + 'type', full: true, value: c.type, onChange: 'cl-type', options: [{ value: 'binary', label: 'Да / Нет' }, { value: 'scale', label: 'Шкала (число)' }] })}</div>
        <div class="field"><label for="${p}weight">Вес</label><input id="${p}weight" name="${p}weight" type="number" min="0" step="any" class="input" value="${c.weight}" data-on-input="cl-sum"></div>
        <div class="field span2"><span class="lbl">Особые свойства</span><div class="row">
          <label class="check"><input type="checkbox" name="${p}deep_check" ${c.deep_check ? raw('checked') : ''}>Проверять факты</label>
          <label class="check"><input type="checkbox" name="${p}requires_audio" ${c.requires_audio ? raw('checked') : ''}>Нужна запись</label></div></div>
        ${c.type === 'scale' ? html`
          <div class="field"><label for="${p}min">Шкала: от</label><input id="${p}min" name="${p}min" type="number" class="input" value="${s.min}"></div>
          <div class="field"><label for="${p}max">до</label><input id="${p}max" name="${p}max" type="number" class="input" value="${s.max}"></div>
          <div class="field span2"><label for="${p}steps">Значения шкалы</label><input id="${p}steps" name="${p}steps" class="input" value="${(s.steps || []).join(', ')}" placeholder="0, 5, 10, 15, 20"></div>
          <div class="field span4"><label for="${p}labels">Описание уровней</label><textarea id="${p}labels" name="${p}labels" class="textarea" placeholder="20 = все вопросы закрыты&#10;10 = закрыта часть">${labels}</textarea></div>` : ''}
        <div class="field span2"><label class="check"><input type="checkbox" name="${p}na_allowed" ${c.na_allowed ? raw('checked') : ''}>Разрешить N/A</label>
          <input name="${p}na_rule" class="input" value="${c.na_rule || ''}" placeholder="Когда критерий неприменим" aria-label="Условие N/A"></div>
        <div class="field span2"><label class="check"><input type="checkbox" name="${p}critical" ${c.critical ? raw('checked') : ''}>Грубая ошибка</label>
          ${CQA.dd({ name: p + 'flag_on', full: true, value: c.flag_on === 'yes' ? 'yes' : 'no', label: 'Какой ответ означает нарушение', options: [{ value: 'yes', label: 'Нарушение = ответ «Да»' }, { value: 'no', label: 'Нарушение = ответ «Нет»' }] })}</div>
      </div></details>`;
  }

  function editor() {
    const cl = S.draft;
    const latest = S.versions.length ? S.versions[0].version : cl.version;
    const ro = !CQA.can('edit_checklist') || (S.viewing && S.viewing !== latest);
    const sum = weightSum(cl);
    const sections = [...new Set(cl.criteria.map((c) => c.section).filter(Boolean))];
    return html`<form id="cl-form" class="stack" data-on-submit="cl-save" data-on-input="cl-dirty" novalidate>
      <section class="card"><div class="card-head"><h2>Параметры</h2></div>
        ${ro ? html`<div class="notice" style="margin-bottom:14px">${icon('info', 16)}<div>${!CQA.can('edit_checklist') ? `Редактирует ${CQA.whoCan('edit_checklist')}` : 'Архивная версия'}</div></div>` : ''}
        <fieldset ${ro && !(S.viewing && S.viewing !== latest && CQA.can('edit_checklist')) ? raw('disabled') : ''} style="border:0;padding:0;margin:0;min-width:0" class="stack">
          <div class="grid k4">
            <div class="field" style="grid-column:span 2"><label for="cl-title">Название</label><input id="cl-title" name="title" class="input" value="${cl.title || ''}"></div>
            <div class="field"><label for="cl-lang">Язык объяснений</label>${CQA.dd({ name: 'explain_language', id: 'cl-lang', full: true, value: cl.explain_language, options: [{ value: 'ru', label: 'Русский' }, { value: 'kk', label: 'Қазақша' }, { value: 'en', label: 'English' }] })}</div>
            <div class="field"><label for="cl-dec">Округление итога</label><div class="row" style="flex-wrap:nowrap">
              <input id="cl-dec" name="decimals" type="number" min="0" max="4" class="input" style="width:72px" value="${cl.rounding.decimals}" aria-label="Знаков после запятой">
              ${CQA.dd({ name: 'mode', full: true, value: cl.rounding.mode, label: 'Режим округления', options: [{ value: 'half_up', label: '0,5 вверх' }, { value: 'half_even', label: 'банковское' }, { value: 'floor', label: 'вниз' }, { value: 'ceil', label: 'вверх' }] })}</div></div>
            <div class="field" style="grid-column:span 2"><label for="cl-na">Правило N/A</label>${CQA.dd({ name: 'na_policy', id: 'cl-na', full: true, value: cl.na_policy, options: [{ value: 'redistribute', label: 'Вес N/A перераспределяется между применимыми' }, { value: 'full_credit', label: 'N/A засчитывается полным весом' }] })}</div>
            <div class="field" style="grid-column:span 2"><label for="cl-gross">Грубая ошибка</label>${CQA.dd({ name: 'gross_error_policy', id: 'cl-gross', full: true, value: cl.gross_error_policy, options: [{ value: 'flag', label: 'Отмечается отдельно, итог не меняется' }, { value: 'zero_total', label: 'Обнуляет итог' }] })}</div>
            ${CQA.can('view_prompt') ? html`<div class="field" style="grid-column:span 2"><label for="cl-prompt">Системный промпт</label><div class="field-row">
              ${CQA.dd({ name: 'prompt_id', id: 'cl-prompt', full: true, value: cl.prompt_id || 'strict', options: S.prompts.map((p) => ({ value: p.id, label: `${p.title} · v${p.active_version}` })) })}
              <button type="button" class="btn secondary" data-act="cl-prompt-show">Показать</button></div></div>` : ''}
            <div class="field" style="grid-column:1/-1"><label for="cl-ctx">Контекст для модели</label><textarea id="cl-ctx" name="context" class="textarea">${cl.context || ''}</textarea></div>
          </div>
          <div class="stack" style="gap:6px">
            <div class="row"><span class="small muted grow">Сумма весов: <b id="cl-sum" style="color:${Math.abs(sum - 100) < 1e-9 ? 'var(--ok-text)' : 'var(--warn-text)'}">${fmt.num(sum, 2)}</b> из 100</span>
              <span class="small muted">${cl.criteria.length} критериев</span></div>
            <div class="weight-bar" aria-hidden="true">${cl.criteria.filter((c) => !c.critical && c.weight > 0).map((c) => html`<i style="width:${(100 * c.weight) / Math.max(sum, 100)}%" data-tip="${c.title}: ${c.weight}"></i>`)}</div>
          </div>
          <datalist id="cl-sections">${sections.map((s) => html`<option value="${s}">`)}</datalist>
          <div class="stack" style="gap:8px">${cl.criteria.map((c, i) => critEditor(c, i, cl.criteria.length, ro))}</div>
          ${ro ? '' : html`<button type="button" class="btn secondary sm" style="align-self:flex-start" data-act="cl-add">${icon('plus', 16)}Добавить критерий</button>`}
        </fieldset>
      </section>
      <div class="actionbar">
          <span class="msg" id="cl-dirty">${S.dirty ? 'Есть несохранённые изменения' : 'Сохраняется как новая версия'}</span>
          ${CQA.can('edit_checklist') ? html`<button type="submit" class="btn primary">${S.viewing && S.viewing !== latest ? 'Сохранить как новую версию' : 'Сохранить версию'}</button>` : ''}
      </div>
    </form>`;
  }

  /** read the form back into S.draft (keeps the order of criteria) */
  function collect() {
    const form = document.getElementById('cl-form');
    if (!form) return S.draft;
    const fd = new FormData(form);
    const g = (k) => (fd.has(k) ? String(fd.get(k)) : null);
    const cl = S.draft;
    if (g('title') != null) cl.title = g('title');
    if (g('explain_language')) cl.explain_language = g('explain_language');
    if (g('decimals') != null) cl.rounding = { decimals: Number(g('decimals')) || 0, mode: g('mode') || 'half_up' };
    if (g('na_policy')) cl.na_policy = g('na_policy');
    if (g('gross_error_policy')) cl.gross_error_policy = g('gross_error_policy');
    if (g('context') != null) cl.context = g('context');
    if (g('prompt_id')) cl.prompt_id = g('prompt_id');
    cl.criteria = cl.criteria.map((c, i) => {
      const p = `c${i}.`;
      if (g(p + 'title') == null) return c;
      const n = { ...c, id: g(p + 'id').trim(), title: g(p + 'title').trim(), section: g(p + 'section').trim(), description: g(p + 'description'),
        type: g(p + 'type'), weight: Number(g(p + 'weight')) || 0, na_allowed: fd.has(p + 'na_allowed'), na_rule: g(p + 'na_rule') || '',
        critical: fd.has(p + 'critical'), flag_on: g(p + 'flag_on') || 'no', deep_check: fd.has(p + 'deep_check'), requires_audio: fd.has(p + 'requires_audio') };
      if (n.type === 'scale') {
        const steps = (g(p + 'steps') || '').split(/[,;\s]+/).filter(Boolean).map(Number).filter((x) => !isNaN(x));
        const labels = {};
        (g(p + 'labels') || '').split('\n').forEach((line) => { const m = line.match(/^\s*(-?\d+)\s*[=:—-]\s*(.+)$/); if (m) labels[m[1]] = m[2].trim(); });
        const min = g(p + 'min') != null ? Number(g(p + 'min')) : (c.scale ? c.scale.min : 0);
        const max = g(p + 'max') != null ? Number(g(p + 'max')) : (c.scale ? c.scale.max : 2);
        n.scale = { min: steps.length ? Math.min(min, ...steps) : min, max: steps.length ? Math.max(max, ...steps) : max, steps: steps.length ? [...new Set(steps)].sort((a, b) => a - b) : null, labels };
      } else n.scale = null;
      if (n.critical) n.weight = 0;
      return n;
    });
    return cl;
  }

  function validate(cl) {
    const errs = [];
    const ids = cl.criteria.map((c) => c.id);
    ids.forEach((id, i) => { if (!/^[A-Za-z0-9_-]+$/.test(id)) errs.push(`Критерий ${i + 1}: код «${id}» — только латиница, цифры, _ и -`); });
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) errs.push(`Коды повторяются: ${[...new Set(dup)].join(', ')}`);
    cl.criteria.forEach((c, i) => {
      if (!c.title) errs.push(`Критерий ${i + 1}: нет названия`);
      if (c.type === 'scale' && !(c.scale && c.scale.max > c.scale.min)) errs.push(`«${c.title}»: у шкалы «до» должно быть больше «от»`);
      if (c.weight < 0) errs.push(`«${c.title}»: отрицательный вес`);
    });
    if (!cl.criteria.some((c) => c.weight > 0)) errs.push('Нужен хотя бы один критерий с весом');
    return errs;
  }

  function paint() {
    const host = document.getElementById('cl-editor');
    if (host) host.innerHTML = toStr(editor());
  }

  function editorHead() {
    const cl = S.draft;
    const latest = S.versions.length ? S.versions[0].version : cl.version;
    const archived = S.viewing && S.viewing !== latest;
    const crit = cl.criteria.filter((c) => c.critical).length;
    return html`<div class="xl-head">
        <h2>${cl.title || cl.id}</h2>
        <span class="pill ${archived ? 'outline' : 'ok'}">${archived ? 'Архив' : 'Действует'}</span>
        <span class="grow"></span>
        ${S.versions.length > 1 ? CQA.dd({ value: cl.version, onChange: 'cl-ver', label: 'Версия', size: 'sm', options: S.versions.map((v) => ({ value: v.version, label: `Версия ${v.version} · ${fmt.date(v.created_at)}` })) }) : html`<span class="pill outline">Версия ${cl.version}</span>`}
        <button type="button" class="icon-btn" data-act="cl-close" aria-label="Закрыть">${icon('x', 16)}</button>
      </div>
      <div class="cl-sum">
        <div class="sum-cell"><span class="pane-title">Сумма весов</span><span class="v">${fmt.num(weightSum(cl), 2)}</span></div>
        <div class="sum-cell"><span class="pane-title">Критериев</span><span class="v">${cl.criteria.length}</span></div>
        <div class="sum-cell"><span class="pane-title">Грубых</span><span class="v" style="color:${crit ? 'var(--danger-text)' : 'inherit'}">${crit}</span></div>
        <div class="sum-cell"><span class="pane-title">Промпт</span><span class="v">${CQA.can('view_prompt') ? html`<button type="button" class="btn link" data-act="cl-prompt-show" style="height:auto;padding:0">${CQA.promptTitles[cl.prompt_id || 'strict'] || cl.prompt_id}</button>` : CQA.promptTitles[cl.prompt_id || 'strict'] || cl.prompt_id}</span></div>
      </div>`;
  }

  function openEditor() {
    closeEditor(true);
    const d = document.createElement('dialog');
    d.className = 'modal xl';
    d.id = 'cl-dialog';
    d.setAttribute('aria-label', `Чек-лист ${S.draft.title || S.draft.id}`);
    d.innerHTML = toStr(html`${editorHead()}<div class="xl-body" id="cl-editor">${editor()}</div>`);
    document.body.appendChild(d);
    d.addEventListener('cancel', (e) => { if (S.dirty && !confirm('Закрыть без сохранения?')) e.preventDefault(); });
    d.addEventListener('close', () => {
      d.remove();
      if (!d.dataset.silent && /^#\/checklists\/./.test(location.hash)) location.hash = '#/checklists';
    });
    d.showModal();
  }
  function closeEditor(silent) {
    const d = document.getElementById('cl-dialog');
    if (!d) return;
    if (silent) d.dataset.silent = '1';
    d.close();
  }

  CQA.route('checklists', {
    title: 'Чек-листы',
    async render(r) {
      const [list, prompts] = await Promise.all([api('/checklists'), CQA.loadPrompts()]);
      S.list = list;
      S.prompts = prompts;
      const [versions, counts] = await Promise.all([
        Promise.all(list.map((c) => api(`/checklists/${encodeURIComponent(c.id)}/versions`).catch(() => []))),
        Promise.all(list.map((c) => api(`/evaluations?checklist_id=${encodeURIComponent(c.id)}`).then((x) => x.length).catch(() => 0))),
      ]);
      {   // newest change first
        const idx = list.map((_, i) => i).sort((x, y) => ((versions[y][0] || {}).created_at || 0) - ((versions[x][0] || {}).created_at || 0));
        const [l, v, n] = [list.slice(), versions.slice(), counts.slice()];
        idx.forEach((k, j) => { list[j] = l[k]; versions[j] = v[k]; counts[j] = n[k]; });
      }
      const id = r.args[0];
      if (id) {
        const [vs, body] = await Promise.all([api(`/checklists/${encodeURIComponent(id)}/versions`), api(`/checklists/${encodeURIComponent(id)}${r.query.v ? `?version=${r.query.v}` : ''}`)]);
        S.versions = vs;
        S.viewing = r.query.v ? Number(r.query.v) : null;
        S.draft = JSON.parse(JSON.stringify(body));
        S.dirty = false;
        S.open = new Set();
      } else S.draft = null;
      return html`
        <div class="page-head"><h1>Чек-листы <span class="count">· ${list.length}</span></h1>
          ${CQA.can('edit_checklist') ? html`<button class="btn primary" data-act="cl-new">Новый чек-лист</button>` : ''}</div>
        <div class="card tight">${list.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Название</th><th class="num">Версия</th><th class="num">Критериев</th><th class="num">Сумма весов</th><th>Грубая ошибка</th><th>Промпт</th><th class="num">Оценок</th><th>Изменён</th></tr></thead>
          <tbody>${list.map((c, i) => html`<tr class="click" tabindex="0" data-act="cl-open" data-id="${c.id}">
            <td><div class="obj"><b>${c.title || c.id}</b><span class="mono">${c.id}</span></div></td>
            <td class="num">${c.version}</td>
            <td class="num">${c.criteria.length}</td>
            <td class="num">${fmt.num(weightSum(c), 2)}</td>
            <td>${c.criteria.some((x) => x.critical) ? html`<span class="pill danger">есть</span>` : html`<span class="muted">нет</span>`}</td>
            <td>${CQA.promptTitles[c.prompt_id || 'strict'] || c.prompt_id}</td>
            <td class="num">${counts[i]}</td>
            <td class="muted nowrap">${versions[i][0] ? fmt.date(versions[i][0].created_at) : '—'}</td>
          </tr>`)}</tbody></table></div>` : CQA.empty('Чек-листов нет')}</div>`;
    },
    mounted(r) { if (r.args[0] && S.draft) openEditor(); },
    leave() { closeEditor(true); },
  });

  CQA.actions['cl-prompt-show'] = () => CQA.showPrompt(collect()).catch(CQA.fail);
  CQA.actions['cl-open'] = (el) => CQA.go(`#/checklists/${encodeURIComponent(el.dataset.id)}`);
  CQA.actions['cl-close'] = () => {
    if (S.dirty && !confirm('Закрыть без сохранения?')) return;
    closeEditor();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-act="cl-open"]')) CQA.go(`#/checklists/${encodeURIComponent(e.target.dataset.id)}`); });

  CQA.actions['cl-toggle'] = (el, e) => {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    const i = Number(el.dataset.i);
    setTimeout(() => { const d = el.parentElement; d.open ? S.open.add(i) : S.open.delete(i); });
  };
  CQA.actions['cl-dirty'] = () => { if (!S.dirty) { S.dirty = true; const el = document.getElementById('cl-dirty'); if (el) el.textContent = 'Есть несохранённые изменения'; } };
  CQA.actions['cl-sum'] = () => {
    const sum = weightSum(collect());
    const el = document.getElementById('cl-sum');
    if (el) { el.textContent = fmt.num(sum, 2); el.style.color = Math.abs(sum - 100) < 1e-9 ? 'var(--ok-text)' : 'var(--warn-text)'; }
  };
  CQA.actions['cl-type'] = (el) => {
    collect();
    const i = Number(el.name.slice(1, el.name.indexOf('.')));
    const c = S.draft.criteria[i];
    c.type = el.value;
    if (c.type === 'scale' && !c.scale) c.scale = { min: 0, max: 10, steps: null, labels: {} };
    S.open.add(i); S.dirty = true; paint();
  };
  CQA.actions['cl-add'] = () => { collect(); S.draft.criteria.push(blankCriterion(S.draft.criteria.length + 1)); S.open.add(S.draft.criteria.length - 1); S.dirty = true; paint(); };
  CQA.actions['cl-del'] = (el, e) => {
    e.preventDefault(); collect();
    const i = Number(el.dataset.i);
    // no confirmation: nothing is saved until «Сохранить версию», and the toast can undo it
    const [gone] = S.draft.criteria.splice(i, 1); S.open = new Set(); S.dirty = true; paint();
    CQA.toast(`Критерий «${gone.title}» удалён`, 'ok', 5000, { label: 'Вернуть', run: () => { S.draft.criteria.splice(i, 0, gone); S.dirty = true; paint(); } });
  };
  CQA.actions['cl-move'] = (el, e) => {
    e.preventDefault(); collect();
    const i = Number(el.dataset.i), j = i + Number(el.dataset.d);
    const a = S.draft.criteria;
    [a[i], a[j]] = [a[j], a[i]];
    S.open = new Set(); S.dirty = true; paint();
  };
  CQA.actions['cl-ver'] = (el) => CQA.go(`#/checklists/${encodeURIComponent(S.draft.id)}?v=${el.value}`);
  CQA.actions['cl-save'] = async () => {
    const cl = collect();
    const errs = validate(cl);
    if (errs.length) throw new Error(errs.join(' · '));
    const saved = await api(`/checklists/${encodeURIComponent(cl.id)}`, { method: 'PUT', body: cl });
    CQA.dropChecklistCache();
    S.dirty = false;
    CQA.toast(`Сохранена версия v${saved.version}. Оценить диалоги по ней — в разделе «Диалоги»`, 'ok', 6000);
    CQA.go(`#/checklists/${encodeURIComponent(cl.id)}`);
  };
  CQA.actions['cl-new'] = () => {
    CQA.modal({
      title: 'Новый чек-лист',
      body: html`<div class="field"><label for="new-title">Название</label><input id="new-title" name="title" class="input" required placeholder="Чек-лист звонков" autocomplete="off"></div>
        <div class="field"><label for="new-id">Код чек-листа</label><input id="new-id" name="id" class="input mono" required pattern="[A-Za-z0-9_\\-]+" title="Только латиница, цифры, _ и -" placeholder="calls_v2" autocomplete="off">
          <span class="field-hint">Латиница, цифры, _ и -</span></div>
        <div class="field"><label for="new-from">Критерии</label>${CQA.dd({ name: 'from', id: 'new-from', full: true, value: S.draft ? S.draft.id : ((S.list.find((c) => c.id === 'official') || S.list[0] || {}).id || ''), options: [{ value: '', label: 'Пустой чек-лист' }, ...S.list.map((c) => ({ value: c.id, label: `Скопировать из «${c.title || c.id}»` }))] })}</div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">Создать</button>`,
      async onSubmit(fd) {
        const id = String(fd.get('id')).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Код: латиница, цифры, _ и -');
        if (S.list.some((c) => c.id === id)) { CQA.markInvalid(document.getElementById('new-id'), 'Такой код уже есть'); return true; }
        const src = S.list.find((c) => c.id === fd.get('from'));
        const base = src ? JSON.parse(JSON.stringify(src)) : { explain_language: 'ru', rounding: { decimals: 2, mode: 'half_up' }, na_policy: 'redistribute', gross_error_policy: 'flag', context: '', criteria: [blankCriterion(1)] };
        await api(`/checklists/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...base, id, version: 1, title: String(fd.get('title')).trim() } });
        CQA.toast('Чек-лист создан');
        CQA.go(`#/checklists/${encodeURIComponent(id)}`);
      },
    });
  };
})();
