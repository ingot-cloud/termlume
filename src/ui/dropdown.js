'use strict';

(() => {
  let active;
  let nextId = 0;

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function close() {
    if (!active) return;
    const { anchor, panel } = active;
    active = undefined;
    panel.remove();
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    anchor.removeAttribute('aria-activedescendant');
  }

  function position() {
    if (!active) return;
    const { anchor, panel, wrapper } = active;
    if (!anchor.isConnected || !wrapper.getClientRects().length) { close(); return; }
    const rect = wrapper.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const width = Math.min(640, Math.max(active.config.searchable ? 380 : 208, rect.width), viewportWidth - 16);
    panel.style.width = `${width}px`;
    const below = viewportHeight - rect.bottom - 12;
    const titlebar = document.querySelector('.titlebar')?.getBoundingClientRect().bottom || 0;
    const above = rect.top - titlebar - 12;
    const aboveTrigger = below < (active.config.searchable ? 220 : Math.min(220, panel.scrollHeight)) && above > below;
    panel.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
    const height = Math.min(active.config.searchable ? 380 : 272, Math.max(36, aboveTrigger ? above : below));
    panel.style.maxHeight = `${height}px`;
    panel.style.height = active.config.searchable ? `${height}px` : '';
    panel.style.top = `${aboveTrigger ? Math.max(titlebar + 8, rect.top - panel.offsetHeight - 5) : rect.bottom + 5}px`;
  }

  function highlight(index, scroll = true) {
    if (!active) return;
    if (active.index >= 0) active.rows[active.index].removeAttribute('data-highlighted');
    active.index = index;
    const focusTarget = active.input || active.anchor;
    if (index < 0) {
      focusTarget.removeAttribute('aria-activedescendant');
      return;
    }
    const row = active.rows[index];
    row.dataset.highlighted = 'true';
    focusTarget.setAttribute('aria-activedescendant', row.id);
    if (scroll) {
      const scroller = active.scroller || active.panel;
      const bounds = scroller.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      if (rect.top < bounds.top + 4) scroller.scrollTop -= bounds.top + 4 - rect.top;
      else if (rect.bottom > bounds.bottom - 4) scroller.scrollTop += rect.bottom - bounds.bottom + 4;
    }
  }

  function move(delta) {
    if (!active) return;
    const { options, index } = active;
    const start = index < 0 && delta < 0 ? 0 : index;
    for (let step = 1; step <= options.length; step++) {
      const next = (start + delta * step + options.length) % options.length;
      if (!options[next].disabled) { highlight(next); break; }
    }
  }

  function choose(index) {
    const { options, config, anchor } = active;
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    config.select(option.value);
    anchor.focus({ preventScroll: true });
  }

  function optionRow(option, index, panel) {
    const row = element('div', 'dropdown-option');
    row.id = `${panel.id}-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(option.value === active.config.value()));
    if (option.disabled) row.setAttribute('aria-disabled', 'true');
    if (option.icon) {
      const icon = element('span', 'dropdown-icon', option.icon);
      icon.setAttribute('aria-hidden', 'true');
      row.append(icon);
    }
    const text = element('span', 'dropdown-text');
    text.append(element('span', '', option.label));
    if (option.description) text.append(element('small', 'dropdown-description', option.description));
    row.title = [option.label, option.description].filter(Boolean).join('\n');
    row.append(text, element('span', 'dropdown-check', '✓'));
    row.lastElementChild.setAttribute('aria-hidden', 'true');
    row.addEventListener('pointermove', () => { if (active?.panel === panel && !option.disabled) highlight(index, false); });
    row.addEventListener('pointerdown', event => event.preventDefault());
    row.addEventListener('click', () => { if (active?.panel === panel) choose(index); });
    return row;
  }

  function searchablePanel(config) {
    const { anchor, wrapper } = config;
    const panel = element('div', 'dropdown-panel dropdown-searchable');
    panel.id = config.id;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `选择${config.label}`);
    const search = element('input');
    search.type = 'search';
    search.placeholder = config.placeholder || '搜索名称、地址、分组或标签';
    search.setAttribute('aria-label', `搜索${config.label}`);
    search.autocomplete = 'off';
    const filters = element('div', 'dropdown-filters');
    const sources = element('div', 'dropdown-sources');
    sources.setAttribute('role', 'group');
    sources.setAttribute('aria-label', config.sourceLabel || '会话来源');
    sources.hidden = !config.sources?.length;
    let source = '';
    const group = element('select');
    group.setAttribute('aria-label', '筛选主机分组');
    group.hidden = !config.groups;
    group.append(new Option('全部分组', ''));
    for (const name of config.groups || []) group.append(new Option(name || '未分组', `group:${name}`));
    filters.append(sources, group);
    filters.hidden = sources.hidden && group.hidden;
    const list = element('div', 'dropdown-results');
    list.id = `${panel.id}-results`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', config.label);
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-controls', list.id);
    const count = element('small', 'dropdown-count');
    count.setAttribute('role', 'status');
    panel.append(element('div', 'dropdown-search', ''), list, count);
    panel.firstChild.append(search, filters);
    (wrapper.closest('dialog, #vault-lock') || document.body).append(panel);
    const render = () => {
      if (active?.panel !== panel) return;
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const options = config.options().filter(option => (!source || option.source === source) &&
        (!group.value || option.group === group.value.slice(6)) &&
        words.every(word => `${option.label} ${option.description || ''} ${option.search || ''}`.toLowerCase().includes(word)));
      Object.assign(active, { options, rows: options.map((option, index) => optionRow(option, index, panel)), index: -1 });
      list.replaceChildren(...active.rows);
      if (!options.length) list.append(element('p', 'dropdown-empty', config.emptyText || '没有匹配项，请调整搜索或筛选。'));
      count.textContent = `${options.length} 项匹配${config.hint ? ` · ${config.hint}` : ''}`;
      for (const control of sources.children) control.setAttribute('aria-pressed', String(control.dataset.source === source));
      position();
      const selected = options.findIndex(option => !option.disabled && option.value === config.value());
      if (selected >= 0) highlight(selected);
      else move(1);
    };
    active = { config, anchor, wrapper, panel, input: search, scroller: list, options: [], rows: [], index: -1, refresh: render };
    for (const [value, label] of config.sources || []) {
      const control = element('button', '', label);
      control.type = 'button';
      control.dataset.source = value;
      control.addEventListener('pointerdown', event => event.preventDefault());
      control.addEventListener('click', () => { source = value; render(); });
      sources.append(control);
    }
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', panel.id);
    search.addEventListener('input', render);
    group.addEventListener('change', render);
    search.addEventListener('keydown', event => {
      if (event.isComposing || active?.panel !== panel) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event.key === 'ArrowDown' ? 1 : -1);
      else if (event.key === 'Enter') { if (active.index >= 0) choose(active.index); }
      else if (event.key === 'Escape') { close(); anchor.focus({ preventScroll: true }); }
      else return;
      event.preventDefault();
      event.stopPropagation();
      if (active?.panel === panel && active.index >= 0) search.setAttribute('aria-activedescendant', active.rows[active.index].id);
    });
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      close(); anchor.focus({ preventScroll: true });
    });
    render();
    search.focus({ preventScroll: true });
  }

  function open(config, query, direction = 1) {
    close();
    if (config.searchable) { searchablePanel(config); return; }
    const { anchor, wrapper } = config;
    const panel = element('div', 'dropdown-panel');
    panel.id = config.id;
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', config.label);
    const options = config.options(query);
    active = { config, anchor, wrapper, panel, options, rows: [], index: -1 };
    const rows = options.map((option, index) => optionRow(option, index, panel));
    panel.append(...rows);
    if (!rows.length) panel.append(element('div', 'dropdown-empty', '没有匹配选项'));
    (wrapper.closest('dialog, #vault-lock') || document.body).append(panel);
    active = { config, anchor, wrapper, panel, options, rows, index: -1 };
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', panel.id);
    position();
    const selected = options.findIndex((option) => !option.disabled && option.value === config.value());
    if (selected >= 0) highlight(selected);
    else move(direction);
  }

  function configure(config) {
    const { anchor, label, editable } = config;
    config.id = `dropdown-${++nextId}`;
    anchor.setAttribute('role', 'combobox');
    anchor.setAttribute('aria-label', label);
    anchor.setAttribute('aria-haspopup', config.searchable ? 'dialog' : 'listbox');
    anchor.setAttribute('aria-expanded', 'false');
    if (editable) anchor.setAttribute('aria-autocomplete', 'list');
    let prefix = '';
    let lastKey = 0;
    anchor.addEventListener('keydown', (event) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const opened = active?.config === config;
      const { key } = event;
      if (key === 'Tab') { if (opened) close(); return; }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const direction = key === 'ArrowDown' ? 1 : -1;
        if (!opened) open(config, undefined, direction);
        else move(direction);
      } else if (opened && (key === 'Enter' || (!editable && key === ' '))) {
        if (active.index >= 0) choose(active.index);
        else close();
      } else if (opened && key === 'Escape') {
        close();
      } else if (opened && !editable && (key === 'Home' || key === 'End')) {
        const available = active.options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
        if (available.length) highlight(key === 'Home' ? available[0] : available.at(-1));
      } else if (!editable && key.length === 1 && key !== ' ') {
        if (config.searchable) {
          if (!opened) open(config);
          active.input.value += key;
          active.refresh();
          event.preventDefault(); event.stopPropagation();
          return;
        }
        const now = Date.now();
        prefix = (now - lastKey > 650 ? '' : prefix) + key.toLowerCase();
        lastKey = now;
        if (!opened) open(config);
        const match = active?.options.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(prefix)) ?? -1;
        if (match >= 0) highlight(match);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function selectControl(select, label = select.getAttribute('aria-label'), settings = {}) {
    const wrapper = element('div', 'dropdown');
    const trigger = element('button', 'dropdown-trigger');
    trigger.type = 'button';
    const icon = element('span', 'dropdown-icon');
    icon.setAttribute('aria-hidden', 'true');
    const value = element('span', 'dropdown-text text-ellipsis');
    const caret = element('span', 'dropdown-caret');
    caret.setAttribute('aria-hidden', 'true');
    trigger.append(icon, value, caret);
    const error = element('small', 'dropdown-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const description = element('small', 'dropdown-selected-description');
    description.hidden = true;
    if (select.parentNode) select.replaceWith(wrapper);
    select.hidden = true;
    wrapper.append(trigger, select, description, error);
    const refresh = () => {
      const selected = select.selectedOptions[0];
      icon.textContent = selected?.dataset.icon || '';
      icon.hidden = !icon.textContent;
      value.textContent = selected?.textContent || '请选择';
      value.title = [value.textContent, selected?.dataset.description].filter(Boolean).join('\n');
      description.textContent = selected?.dataset.description || '';
      description.hidden = !settings.showDescription || !description.textContent;
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-required', String(select.required));
      if (select.validity.valid) {
        error.hidden = true;
        trigger.removeAttribute('aria-invalid');
      }
      if (active?.anchor === trigger) { if (active.refresh) active.refresh(); else open(config); }
    };
    const config = { ...settings, anchor: trigger, wrapper, label, value: () => select.value,
      options: () => Array.from(select.options, (option) => ({
        value: option.value, label: option.textContent, icon: option.dataset.icon,
        description: option.dataset.description, search: option.dataset.search,
        source: option.dataset.source, group: option.dataset.group,
        disabled: option.disabled || (select.required && !option.value)
      })),
      select: (newValue) => {
        if (select.value === newValue) return;
        select.value = newValue;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    configure(config);
    trigger.addEventListener('click', () => {
      trigger.focus({ preventScroll: true });
      if (active?.anchor === trigger) close();
      else open(config);
    });
    select.addEventListener('change', refresh);
    select.addEventListener('input', refresh);
    select.addEventListener('invalid', (event) => {
      event.preventDefault();
      trigger.setAttribute('aria-invalid', 'true');
      error.textContent = `请选择${label}。`;
      error.hidden = false;
      if (!select.form?.querySelector('.dropdown-trigger[aria-invalid="true"]:focus')) trigger.focus();
    });
    new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
    refresh();
    return wrapper;
  }

  function editableControl(input, label, options) {
    const wrapper = element('div', 'dropdown dropdown-editable');
    const toggle = element('button', 'dropdown-toggle');
    toggle.type = 'button';
    toggle.tabIndex = -1;
    toggle.setAttribute('aria-label', `选择${label}`);
    const caret = element('span', 'dropdown-caret');
    caret.setAttribute('aria-hidden', 'true');
    toggle.append(caret);
    wrapper.append(input, toggle);
    const config = { anchor: input, wrapper, label, editable: true, options,
      value: () => input.value.trim(),
      select: (value) => {
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus({ preventScroll: true });
      }
    };
    configure(config);
    input.autocomplete = 'off';
    input.addEventListener('input', (event) => { if (!event.isComposing) open(config, input.value.trim()); });
    input.addEventListener('compositionend', () => open(config, input.value.trim()));
    toggle.addEventListener('pointerdown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      if (active?.anchor === input) close();
      else {
        input.focus({ preventScroll: true });
        open(config);
      }
    });
    return wrapper;
  }

  document.addEventListener('pointerdown', (event) => {
    if (active && !active.wrapper.contains(event.target) && !active.panel.contains(event.target)) close();
  }, true);
  document.addEventListener('focusin', (event) => {
    if (active && !active.wrapper.contains(event.target) && !active.panel.contains(event.target)) close();
  });
  document.addEventListener('close', (event) => { if (active && event.target.contains(active.anchor)) close(); }, true);
  document.addEventListener('scroll', (event) => { if (active && !active.panel.contains(event.target)) position(); }, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', position);

  window.dropdowns = { selectControl, editableControl, close };
})();
