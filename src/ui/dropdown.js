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
    const width = Math.min(Math.max(208, rect.width), viewportWidth - 16);
    panel.style.width = `${width}px`;
    const below = viewportHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const aboveTrigger = below < Math.min(220, panel.scrollHeight) && above > below;
    panel.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
    panel.style.maxHeight = `${Math.min(272, Math.max(36, aboveTrigger ? above : below))}px`;
    panel.style.top = `${aboveTrigger ? Math.max(8, rect.top - panel.offsetHeight - 5) : rect.bottom + 5}px`;
  }

  function highlight(index, scroll = true) {
    if (!active) return;
    if (active.index >= 0) active.rows[active.index].removeAttribute('data-highlighted');
    active.index = index;
    if (index < 0) {
      active.anchor.removeAttribute('aria-activedescendant');
      return;
    }
    const row = active.rows[index];
    row.dataset.highlighted = 'true';
    active.anchor.setAttribute('aria-activedescendant', row.id);
    if (scroll) {
      const panel = active.panel;
      const top = row.offsetTop - 4;
      const bottom = top + row.offsetHeight + 8;
      if (top < panel.scrollTop) panel.scrollTop = top;
      else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight;
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
    const { options, config } = active;
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    config.select(option.value);
  }

  function open(config, query, direction = 1) {
    close();
    const { anchor, wrapper } = config;
    const panel = element('div', 'dropdown-panel');
    panel.id = config.id;
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', config.label);
    const options = config.options(query);
    const rows = options.map((option, index) => {
      const row = element('div', 'dropdown-option');
      row.id = `${panel.id}-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.value === config.value()));
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      if (option.icon) {
        const icon = element('span', 'dropdown-icon', option.icon);
        icon.setAttribute('aria-hidden', 'true');
        row.append(icon);
      }
      row.append(element('span', 'dropdown-text', option.label), element('span', 'dropdown-check', '✓'));
      row.lastElementChild.setAttribute('aria-hidden', 'true');
      row.addEventListener('pointermove', () => { if (active?.panel === panel && !option.disabled) highlight(index, false); });
      row.addEventListener('pointerdown', (event) => event.preventDefault());
      row.addEventListener('click', () => { if (active?.panel === panel) choose(index); });
      return row;
    });
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
    anchor.setAttribute('aria-haspopup', 'listbox');
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

  function selectControl(select, label = select.getAttribute('aria-label')) {
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
    if (select.parentNode) select.replaceWith(wrapper);
    select.hidden = true;
    wrapper.append(trigger, select, error);
    const refresh = () => {
      const selected = select.selectedOptions[0];
      icon.textContent = selected?.dataset.icon || '';
      icon.hidden = !icon.textContent;
      value.textContent = selected?.textContent || '请选择';
      value.title = value.textContent;
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-required', String(select.required));
      if (select.validity.valid) {
        error.hidden = true;
        trigger.removeAttribute('aria-invalid');
      }
      if (active?.anchor === trigger) open(config);
    };
    const config = { anchor: trigger, wrapper, label, value: () => select.value,
      options: () => Array.from(select.options, (option) => ({
        value: option.value, label: option.textContent, icon: option.dataset.icon,
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
  document.addEventListener('scroll', (event) => { if (active && event.target !== active.panel) close(); }, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', position);

  window.dropdowns = { selectControl, editableControl, close };
})();
