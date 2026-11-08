/* Системные промпты: admin edits and versions them, picks the active version;
   methodologist reads them (and picks one per checklist). Route: #/prompts/<id>?v=<version> */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt, toStr } = CQA;
  const S = (CQA.state.prompts = { list: [], cur: null, dirty: false });

  const canEdit = () => CQA.can('edit_prompt');

  function head() {
    const p = S.cur;
    const active = p.version === p.active_version;
    return html`<div class="xl-head">
        <h2>${p.title || p.id}</h2>
        <span class="pill ${active ? 'ok' : 'outline'}">${active ? 'Активная версия' : 'Не активна'}</span>
        <span class="grow"></span>
        ${p.versions.length > 1 ? CQA.dd({ value: p.version, onChange: 'pr-ver', label: 'Версия', size: 'sm', options: p.versions.map((v) => ({ value: v.version, label: `Версия ${v.version}${v.version === p.active_version ? ' · активна' : ''} · ${fmt.date(v.created_at)}` })) }) : html`<span class="pill outline">Версия ${p.version}</span>`}
        <button type="button" class="icon-btn" data-act="pr-close" aria-label="Закрыть">${icon('x', 16)}</button>
      </div>
      <div class="cl-sum">
        <div class="sum-cell"><span class="pane-title">Код</span><span class="v mono">${p.id}</span></div>
        <div class="sum-cell"><span class="pane-title">Активна</span><span class="v">v${p.active_version}</span></div>
        <div class="sum-cell"><span class="pane-title">Версий</span><span class="v">${p.versions.length}</span></div>
        <div class="sum-cell"><span class="pane-title">Чек-листы</span><span class="v">${p.used_by.length ? html`<div class="chips">${p.used_by.map((id) => html`<a class="chip-link" href="#/checklists/${encodeURIComponent(id)}" title="${S.titles[id] || id}">${S.titles[id] || id}</a>`)}</div>` : '—'}</span></div>
      </div>`;
  }

  function body() {
    const p = S.cur;
    const ro = !canEdit();
    const active = p.version === p.active_version;
    return html`<form id="pr-form" class="stack" data-on-submit="pr-save" data-on-input="pr-dirty" novalidate>
      <section class="card"><div class="card-head"><h2>Текст</h2></div>
        ${ro ? html`<div class="notice" style="margin-bottom:14px">${icon('info', 16)}<div>Редактирует ${CQA.whoCan('edit_prompt')}</div></div>` : ''}
        <fieldset ${ro ? raw('disabled') : ''} style="border:0;padding:0;margin:0;min-width:0" class="stack">
          <div class="grid k4">
            <div class="field"><label for="pr-title">Название</label><input id="pr-title" name="title" class="input" value="${p.title || ''}" required></div>
            <div class="field" style="grid-column:span 3"><label for="pr-desc">Описание</label><input id="pr-desc" name="description" class="input" value="${p.description || ''}"></div>
          </div>
          <div class="field"><label for="pr-text">Правила для модели ${CQA.hint('К ним добавляются язык пояснений и «Контекст для модели» из чек-листа')}</label>
            <textarea id="pr-text" name="text" class="prompt-text" spellcheck="false">${p.text}</textarea></div>
        </fieldset>
      </section>
      <div class="actionbar">
        <span class="msg" id="pr-msg">${S.dirty ? 'Есть несохранённые изменения' : 'Сохраняется как новая версия'}</span>
        ${canEdit() && !active ? html`<button type="button" class="btn secondary" data-act="pr-activate">Сделать активной</button>` : ''}
        ${canEdit() ? html`<label class="check"><input type="checkbox" name="activate" checked>Сразу активировать</label>
          <button type="submit" class="btn primary">Сохранить версию</button>` : ''}
      </div>
    </form>`;
  }

  function open() {
    close(true);
    const d = document.createElement('dialog');
    d.className = 'modal xl';
    d.id = 'pr-dialog';
    d.setAttribute('aria-label', `Системный промпт ${S.cur.title || S.cur.id}`);
    d.innerHTML = toStr(html`<div id="pr-head">${head()}</div><div class="xl-body" id="pr-body">${body()}</div>`);
    document.body.appendChild(d);
    d.addEventListener('cancel', (e) => { if (S.dirty && !confirm('Закрыть без сохранения?')) e.preventDefault(); });
    d.addEventListener('close', () => {
      d.remove();
      if (!d.dataset.silent && /^#\/prompts\/./.test(location.hash)) location.hash = '#/prompts';
    });
    d.showModal();
  }
  function close(silent) {
    const d = document.getElementById('pr-dialog');
    if (!d) return;
    if (silent) d.dataset.silent = '1';
    d.close();
  }

  CQA.route('prompts', {
    title: 'Системные промпты',
    async render(r) {
      const [list, cls] = await Promise.all([CQA.loadPrompts(), api('/checklists')]);
      list.sort((x, y) => ((y.versions[0] || {}).created_at || 0) - ((x.versions[0] || {}).created_at || 0));   // newest change first
      S.list = list;
      S.titles = Object.fromEntries(cls.map((c) => [c.id, c.title || c.id]));
      const id = r.args[0];
      S.cur = id ? await api(`/prompts/${encodeURIComponent(id)}${r.query.v ? `?version=${r.query.v}` : ''}`) : null;
      S.dirty = false;
      return html`
        <div class="page-head"><h1>Системные промпты <span class="count">· ${list.length}</span></h1>
          ${canEdit() ? html`<button class="btn primary" data-act="pr-new">Новый промпт</button>` : ''}</div>
        <div class="card tight"><div class="table-wrap"><table class="table">
          <thead><tr><th>Название</th><th>Описание</th><th class="num">Активная версия</th><th class="num">Версий</th><th>Чек-листы</th><th>Изменён</th></tr></thead>
          <tbody>${list.map((p) => html`<tr class="click" tabindex="0" data-act="pr-open" data-id="${p.id}">
            <td><div class="obj"><b>${p.title || p.id}</b><span class="mono">${p.id}</span></div></td>
            <td class="muted">${p.description || ''}</td>
            <td class="num">v${p.active_version}</td>
            <td class="num">${p.versions.length}</td>
            <td style="max-width:420px">${p.used_by.length ? html`<div class="chips">${p.used_by.map((id) => html`<a class="chip-link" href="#/checklists/${encodeURIComponent(id)}" title="${S.titles[id] || id}">${S.titles[id] || id}</a>`)}</div>` : html`<span class="muted">—</span>`}</td>
            <td class="muted nowrap">${p.versions[0] ? fmt.date(p.versions[0].created_at) : '—'}</td>
          </tr>`)}</tbody></table></div></div>`;
    },
    mounted(r) { if (r.args[0] && S.cur) open(); },
    leave() { close(true); },
  });

  const reopen = (id, v) => CQA.go(`#/prompts/${encodeURIComponent(id)}${v ? `?v=${v}` : ''}`);
  CQA.actions['pr-open'] = (el, e) => { if (!e.target.closest('a')) reopen(el.dataset.id); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-act="pr-open"]')) reopen(e.target.dataset.id); });
  CQA.actions['pr-close'] = () => { if (S.dirty && !confirm('Закрыть без сохранения?')) return; close(); };
  CQA.actions['pr-ver'] = (el) => { if (S.dirty && !confirm('Перейти без сохранения?')) return; reopen(S.cur.id, el.value); };
  CQA.actions['pr-dirty'] = () => {
    if (S.dirty) return;
    S.dirty = true;
    const m = document.getElementById('pr-msg');
    if (m) m.textContent = 'Есть несохранённые изменения';
  };
  CQA.actions['pr-save'] = async (form) => {
    const fd = new FormData(form);
    const text = String(fd.get('text') || '').trim();
    if (!text) throw new Error('Текст промпта пустой');
    const saved = await api(`/prompts/${encodeURIComponent(S.cur.id)}`, { method: 'PUT',
      body: { title: String(fd.get('title')).trim() || S.cur.id, description: String(fd.get('description') || ''), text, activate: fd.has('activate') } });
    S.dirty = false;
    CQA.toast(`Сохранена версия v${saved.version}${saved.active_version === saved.version ? ', активна' : ''}`, 'ok');
    reopen(S.cur.id);
  };
  CQA.actions['pr-activate'] = async () => {
    await api(`/prompts/${encodeURIComponent(S.cur.id)}/activate`, { method: 'POST', body: { version: S.cur.version } });
    CQA.toast(`Активна версия v${S.cur.version}`, 'ok');
    reopen(S.cur.id);
  };
  CQA.actions['pr-new'] = () => {
    CQA.modal({
      title: 'Новый промпт',
      body: html`<div class="field"><label for="np-id">Код</label><input id="np-id" name="id" class="input mono" required placeholder="lenient_calls" autocomplete="off"></div>
        <div class="field"><label for="np-title">Название</label><input id="np-title" name="title" class="input" required></div>
        <div class="field"><label for="np-from">Начать с текста</label>${CQA.dd({ name: 'from', id: 'np-from', full: true, value: S.list[0] ? S.list[0].id : '', options: S.list.map((p) => ({ value: p.id, label: p.title || p.id })) })}</div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">Создать</button>`,
      async onSubmit(fd) {
        const id = String(fd.get('id')).trim().toLowerCase();
        if (!/^[a-z0-9_-]{2,40}$/.test(id)) throw new Error('Код: 2–40 символов, латиница, цифры, _ и -');
        if (S.list.some((p) => p.id === id)) throw new Error('Такой код уже есть');
        const src = S.list.find((p) => p.id === fd.get('from'));
        await api(`/prompts/${encodeURIComponent(id)}`, { method: 'PUT', body: { title: String(fd.get('title')).trim(), description: '', text: src ? src.text : '-', activate: true } });
        reopen(id);
      },
    });
  };
})();
