import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  replaceAll, replaceNext, selectMatches, setSearchQuery } from '@codemirror/search';
import { runScopeHandlers } from '@codemirror/view';

export function fileSearchPanel(view) {
  const dom = document.createElement('div');
  dom.className = 'file-search-panel';
  const row = document.createElement('div');
  row.className = 'file-search-row';
  const details = document.createElement('div');
  details.className = 'file-search-details';
  details.hidden = true;
  const field = (name, label) => {
    const input = document.createElement('input');
    input.name = name;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    return input;
  };
  const action = (name, label, title, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.name = name;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.onclick = run;
    return button;
  };
  const term = field('search', '查找');
  term.type = 'search';
  term.setAttribute('main-field', 'true');
  const replacement = field('replace', '替换为');
  const count = document.createElement('output');
  count.setAttribute('aria-label', '匹配数');
  const more = action('options', '···', '查找选项', () => {
    details.hidden = !details.hidden;
    more.setAttribute('aria-expanded', String(!details.hidden));
  });
  more.setAttribute('aria-expanded', 'false');
  row.append(term, count, action('prev', '↑', '上一处', () => findPrevious(view)),
    action('next', '↓', '下一处', () => findNext(view)), more,
    action('close', '×', '关闭查找', () => closeSearchPanel(view)));
  const flags = {};
  for (const [name, title] of Object.entries({ caseSensitive: '区分大小写', wholeWord: '全词', regexp: '正则' })) {
    const label = document.createElement('label');
    const flag = document.createElement('input');
    flag.type = 'checkbox';
    flags[name] = flag;
    label.append(flag, title);
    details.append(label);
  }
  details.append(action('select', '全选匹配', '全选匹配', () => selectMatches(view)));
  if (!view.state.readOnly) {
    more.title = '替换及查找选项';
    more.setAttribute('aria-label', more.title);
    const replaceRow = document.createElement('div');
    replaceRow.className = 'file-search-row';
    replaceRow.append(replacement, action('replace', '替换', '替换', () => replaceNext(view)),
      action('replaceAll', '全部替换', '全部替换', () => replaceAll(view)));
    details.prepend(replaceRow);
  }
  dom.append(row, details);
  const sync = query => {
    term.value = query.search;
    replacement.value = query.replace;
    for (const [name, flag] of Object.entries(flags)) flag.checked = query[name];
  };
  dom.oninput = () => {
    const query = new SearchQuery({ search: term.value, replace: replacement.value,
      caseSensitive: flags.caseSensitive.checked, wholeWord: flags.wholeWord.checked, regexp: flags.regexp.checked });
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
  };
  dom.onkeydown = event => {
    if (event.isComposing) return;
    if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
    else if (event.key === 'Enter' && (event.target === term || event.target === replacement)) {
      event.preventDefault();
      if (event.target === replacement) replaceNext(view);
      else (event.shiftKey ? findPrevious : findNext)(view);
    }
  };
  let matches = [], overflow = false;
  function recount(state, query) {
    matches = [];
    overflow = false;
    if (!query.valid) return;
    for (const match of query.getCursor(state)) {
      if (matches.length === 1000) { overflow = true; break; }
      matches.push(match);
    }
  }
  function showCount(state) {
    const index = matches.findIndex(match => match.from >= state.selection.main.from);
    count.textContent = !term.value ? '' : overflow ? '1000+' : matches.length ? `${index < 0 ? 1 : index + 1}/${matches.length}` : '0/0';
  }
  const initial = getSearchQuery(view.state);
  sync(initial);
  recount(view.state, initial);
  showCount(view.state);
  return { dom, top: true, mount() { term.select(); }, update(update) {
    const query = getSearchQuery(update.state);
    const changed = !query.eq(getSearchQuery(update.startState));
    if (changed) sync(query);
    if (changed || update.docChanged) recount(update.state, query);
    if (changed || update.docChanged || update.selectionSet) showCount(update.state);
  } };
}
