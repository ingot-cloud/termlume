'use strict';

// Block the workspace while leaving the native window's title bar available.
(() => {
  const stack = [];
  const previousInert = new Map();
  const backdrop = document.createElement('div');
  backdrop.className = 'overlay-backdrop';
  backdrop.hidden = true;
  document.body.append(backdrop);
  const controls = pane => [...pane.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.disabled && !control.closest('[inert]') && control.getClientRects().length);
  const focus = pane => (controls(pane)[0] || pane).focus({ preventScroll: true });
  const sync = () => {
    const top = stack.at(-1);
    document.body.classList.toggle('overlay-open', Boolean(top));
    backdrop.hidden = !top;
    if (top) {
      backdrop.style.zIndex = String(20 + (stack.length - 1) * 2);
      backdrop.dataset.light = String(top.pane.id === 'session-switcher' || top.pane.classList.contains('host-drawer'));
    }
    stack.forEach(({ pane }, index) => {
      pane.inert = pane !== top.pane;
      pane.style.zIndex = String(21 + index * 2);
    });
    if (!top) {
      for (const [element, inert] of previousInert) element.inert = inert;
      previousInert.clear();
    }
  };
  function show(pane) {
    if (pane.open) return;
    const previousFocus = document.activeElement;
    if (!stack.length) {
      for (const element of document.querySelectorAll('.titlebar > *, #workspace, body > footer, #vault-lock')) {
        previousInert.set(element, element.inert);
        element.inert = true;
      }
    }
    stack.push({ pane, previousFocus });
    pane.setAttribute('aria-modal', 'true');
    pane.tabIndex = -1;
    sync();
    pane.show();
  }
  document.addEventListener('close', event => {
    const index = stack.findIndex(entry => entry.pane === event.target);
    if (index < 0) return;
    const wasTop = index === stack.length - 1;
    const [{ pane, previousFocus }] = stack.splice(index, 1);
    pane.inert = false;
    pane.style.zIndex = '';
    pane.removeAttribute('aria-modal');
    sync();
    if (!wasTop) return;
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    else if (stack.length) focus(stack.at(-1).pane);
  }, true);
  document.addEventListener('keydown', event => {
    const pane = stack.at(-1)?.pane;
    if (!pane || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pane.dispatchEvent(new Event('cancel', { cancelable: true }))) pane.close();
    } else if (event.key === 'Tab') {
      const choices = controls(pane);
      const index = choices.indexOf(document.activeElement);
      if (!choices.length || (event.shiftKey ? index <= 0 : index < 0 || index === choices.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? choices.at(-1) || pane : choices[0] || pane).focus({ preventScroll: true });
      }
    }
  });
  document.addEventListener('focusin', event => {
    const pane = stack.at(-1)?.pane;
    if (pane?.open && !pane.contains(event.target)) focus(pane);
  });
  backdrop.addEventListener('click', () => {
    if (stack.at(-1)?.pane.id === 'session-switcher') stack.at(-1).pane.close();
  });
  window.overlays = { show };
})();
