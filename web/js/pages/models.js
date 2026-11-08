/* Модели и ключи (admin), like OpenRouter's «Bring your own key»: pick a provider → paste its key
   (checked before saving) → choose which of its models can be used and which one is the default.
   Route: #/models */
(function () {
  'use strict';
  const { html, raw, icon, api, fmt } = CQA;
  const S = (CQA.state.models = { providers: [], models: [] });

  /** «бесплатно» / «≈ $0.002 за диалог» / «цена неизвестна» */
  CQA.priceNote = (p) => (p === 0 ? 'бесплатно' : p == null ? 'цена неизвестна' : `≈ ${fmt.usd(p)} за диалог`);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'model';

  function providerCard(p) {
    return html`<button type="button" class="prov-card ${p.connected ? 'on' : ''}" data-act="prov-open" data-id="${p.id}">
      <span class="prov-head"><b>${p.title}</b><span class="pill ${p.connected ? 'ok' : 'outline'}">${p.connected ? 'Подключён' : 'Не подключён'}</span></span>
      <span class="prov-hint">${p.hint}</span>
      <span class="prov-meta">${p.connected
        ? html`${p.key_masked ? html`<span class="mono">${p.key_masked}</span>` : p.key_optional ? 'без ключа' : ''}${p.base_url ? html` · <span class="mono">${p.base_url}</span>` : ''}${p.source === 'env' ? ' · из .env' : ''}`
        : html`<span class="link-like">${icon('plus', 14)}Добавить ключ</span>`}</span>
    </button>`;
  }

  function modelsTable() {
    if (!S.models.length) return CQA.empty('Моделей нет', 'Подключите провайдера и добавьте модель.');
    return html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Модель</th><th>Провайдер</th><th>Цена</th><th>В оценке</th><th>По умолчанию ${CQA.hint('Используется, если при запуске оценки модель не выбрана')}</th><th></th></tr></thead>
      <tbody>${S.models.map((m) => html`<tr>
        <td><b style="font-weight:500">${m.label}</b><div class="mono muted small">${m.model}</div></td>
        <td>${m.provider_title}${m.usable ? '' : html` <span class="pill warn" data-tip="Добавьте ключ провайдера">не подключён</span>`}</td>
        <td class="nowrap small">${CQA.priceNote(m.price)}</td>
        <td><label class="switch"><input type="checkbox" data-on-change="mdl-enable" data-id="${m.id}" ${m.enabled ? raw('checked') : ''} aria-label="Доступна в оценке: ${m.label}"><span></span></label></td>
        <td><label class="check"><input type="radio" name="mdl-default" data-on-change="mdl-default" data-id="${m.id}" ${m.default ? raw('checked') : ''} ${m.usable && m.enabled ? '' : raw('disabled')}>${m.default ? 'да' : ''}</label></td>
        <td class="num"><button class="btn ghost sm icon" data-act="mdl-del" data-id="${m.id}" aria-label="Удалить ${m.label}" ${m.default ? raw('disabled') : ''}>${icon('trash', 14)}</button></td>
      </tr>`)}</tbody></table></div>`;
  }

  CQA.route('models', {
    title: 'Модели и ключи',
    async render() {
      const [providers, models] = await Promise.all([api('/providers'), api('/models')]);
      S.providers = providers;
      S.models = models;
      return html`
        <div class="page-head"><h1>Модели и ключи</h1>
          <button class="btn primary" data-act="mdl-add">${icon('plus', 16)}Добавить модель</button></div>
        <section class="stack" style="gap:10px">
          <div class="row"><h2 class="grow" style="margin:0;font-size:16px">Провайдеры</h2><span class="muted small">Ключ проверяется до сохранения и хранится только на сервере</span></div>
          <div class="prov-grid">${providers.map(providerCard)}</div>
        </section>
        <section class="card tight"><div class="card-head" style="padding:16px 16px 0"><h2>Модели для оценки</h2><span class="muted small">включённые появятся в окне «Оценить»</span></div>
          ${modelsTable()}</section>`;
    },
  });

  /* ---------- provider: add / change key ---------- */
  CQA.actions['prov-open'] = (el) => {
    const p = S.providers.find((x) => x.id === el.dataset.id);
    CQA.modal({
      title: p.connected ? `${p.title} · ключ` : `Подключить ${p.title}`,
      body: html`<p class="muted small" style="margin:0 0 4px">${p.hint}</p>
        ${p.needs_url ? html`<div class="field"><label for="pv-url">Адрес сервера</label><input id="pv-url" name="base_url" class="input mono" required value="${p.base_url || ''}" placeholder="http://127.0.0.1:8000/v1" autocomplete="off">
          <span class="field-hint">OpenAI-совместимый адрес, заканчивается на /v1</span></div>` : ''}
        <div class="field"><label for="pv-key">API-ключ${p.key_optional ? ' (если нужен)' : ''}</label>
          <input id="pv-key" name="key" type="password" class="input mono" ${p.key_optional || p.connected ? '' : raw('required')} autocomplete="off" spellcheck="false"
            placeholder="${p.key_masked ? `сейчас ${p.key_masked} — оставьте пустым, чтобы не менять` : 'вставьте ключ'}">
          ${p.keys_url ? html`<span class="field-hint">Где взять: <a href="${p.keys_url}" target="_blank" rel="noopener">${p.keys_url.replace(/^https:\/\//, '')}</a></span>` : ''}</div>`,
      foot: html`${p.source === 'ui' ? html`<button class="btn" type="button" data-act="prov-del" data-id="${p.id}" style="margin-right:auto">Отключить</button>` : ''}
        <button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">Проверить и сохранить</button>`,
      async onSubmit(fd) {
        try {
          S.providers = await api(`/providers/${p.id}`, { method: 'PUT', body: { key: fd.get('key') || null, base_url: fd.get('base_url') || null } });
        } catch (e) {
          CQA.markInvalid(document.getElementById(p.needs_url && /адрес|отвечает/i.test(e.message) ? 'pv-url' : 'pv-key'), e.message);
          return true;                                   // keep the dialog open
        }
        CQA.toast(`${p.title}: подключено`, 'ok');
        CQA.render();
      },
    });
  };
  CQA.actions['prov-del'] = async (el) => {
    if (!confirm('Удалить сохранённый ключ?')) return;
    await api(`/providers/${el.dataset.id}`, { method: 'DELETE' });
    el.closest('dialog').close();
    CQA.toast('Ключ удалён');
    CQA.render();
  };

  /* ---------- models ---------- */
  async function saveModels(models, def) {
    S.models = await api('/models', { method: 'PUT', body: { models: models.map(({ id, provider, model, label, enabled, price }) => ({ id, provider, model, label, enabled, price })), default: def } });
    CQA.render();
  }
  const currentDefault = () => (S.models.find((m) => m.default) || {}).id || null;
  CQA.actions['mdl-enable'] = (el) => {
    const m = S.models.find((x) => x.id === el.dataset.id);
    if (m.default && !el.checked) { el.checked = true; return CQA.toast('Модель по умолчанию нельзя выключить — сначала выберите другую', 'err'); }
    saveModels(S.models.map((x) => (x.id === m.id ? { ...x, enabled: el.checked } : x)), currentDefault()).catch(CQA.fail);
  };
  CQA.actions['mdl-default'] = (el) => saveModels(S.models, el.dataset.id).then(() => CQA.toast('Модель по умолчанию изменена', 'ok')).catch(CQA.fail);
  CQA.actions['mdl-del'] = (el) => {
    const m = S.models.find((x) => x.id === el.dataset.id);
    if (!confirm(`Удалить «${m.label}» из списка?`)) return;
    saveModels(S.models.filter((x) => x.id !== m.id), currentDefault()).catch(CQA.fail);
  };

  /** add: provider → searchable list of its models */
  CQA.actions['mdl-add'] = () => {
    const conn = S.providers.filter((p) => p.connected);
    if (!conn.length) return CQA.toast('Сначала подключите провайдера', 'err');
    const dlg = CQA.modal({
      title: 'Добавить модель',
      wide: true,
      body: html`<div class="field"><label for="ma-prov">Провайдер</label>${CQA.dd({ name: 'provider', id: 'ma-prov', full: true, value: conn[0].id, onChange: 'ma-prov', options: conn.map((p) => ({ value: p.id, label: p.title })) })}</div>
        <div class="field"><label for="ma-q">Модель</label>
          <label class="search" style="flex:none;max-width:none"><span class="sr">Поиск</span>${icon('search', 16)}<input id="ma-q" class="input" type="search" placeholder="Поиск: gemma, qwen, deepseek…" data-on-input="ma-filter" autocomplete="off"></label>
          <div class="pick-list" id="ma-list" role="radiogroup" aria-label="Модели"><div class="muted small" style="padding:12px">Загрузка…</div></div></div>`,
      foot: html`<button class="btn" value="cancel">Отмена</button><button class="btn primary" value="ok">Добавить</button>`,
      async onSubmit(fd) {
        const pick = S.pickList.find((x) => x.model === fd.get('pick'));
        if (!pick) { CQA.toast('Выберите модель из списка', 'err'); return true; }
        const pid = fd.get('provider');
        if (S.models.some((m) => m.provider === pid && m.model === pick.model)) { CQA.toast('Эта модель уже в списке', 'err'); return true; }
        let id = slug(`${pick.label}-${pid}`);
        while (S.models.some((m) => m.id === id)) id += '-2';
        await saveModels([...S.models, { id, provider: pid, model: pick.model, label: pick.label.replace(/^[^:]+:\s*/, ''), enabled: true, price: pick.price }], currentDefault());
        CQA.toast(`«${pick.label}» добавлена`, 'ok');
      },
    });
    loadPick(conn[0].id, dlg.el);
  };
  async function loadPick(pid, root) {
    const box = root.querySelector('#ma-list');
    box.innerHTML = CQA.toStr(html`<div class="muted small" style="padding:12px">Загрузка…</div>`);
    try { S.pickList = await api(`/providers/${pid}/models`); } catch (e) { S.pickList = []; box.innerHTML = CQA.toStr(html`<div class="field-err" style="padding:12px">${e.message}</div>`); return; }
    paintPick(root);
  }
  function paintPick(root) {
    const q = (root.querySelector('#ma-q').value || '').trim().toLowerCase();
    const list = S.pickList.filter((m) => !q || m.model.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)).slice(0, 200);
    root.querySelector('#ma-list').innerHTML = CQA.toStr(list.length ? html`${list.map((m) => html`<label class="pick-row">
        <input type="radio" name="pick" value="${m.model}"><span class="grow"><b>${m.label}</b><span class="mono muted small">${m.model}</span></span>
        <span class="small nowrap ${m.price === 0 ? 'ok-text' : ''}">${CQA.priceNote(m.price)}</span></label>`)}`
      : html`<div class="muted small" style="padding:12px">Ничего не найдено</div>`);
  }
  CQA.actions['ma-prov'] = (el) => loadPick(el.value, el.closest('dialog'));
  CQA.actions['ma-filter'] = (el) => paintPick(el.closest('dialog'));
})();
