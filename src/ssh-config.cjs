const path = require('node:path');

function tokens(text) {
  return [...text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s#]+)|(#.*$)/g)]
    .filter((match) => !match[4]).map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\\(["\\])/g, '$1'));
}

function importSSHConfig(text, home) {
  const blocks = [{ aliases: [], defaults: true, settings: {} }];
  const warnings = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([a-z][\w]*)\s*(?:=\s*|\s+)(.*)$/i.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const values = tokens(match[2]);
    if (keyword === 'host') {
      const aliases = values.filter((value) => !/[*?!]/.test(value));
      const defaults = values.length === 1 && values[0] === '*';
      const complex = aliases.length !== values.length && !defaults;
      if (complex) warnings.push('已跳过通配符或否定 Host 条目。');
      blocks.push({ aliases: complex ? [] : aliases, defaults, settings: {} });
    } else if (keyword === 'match') {
      warnings.push('已跳过 Match 条件块。');
      blocks.push({ aliases: [], defaults: false, settings: {} });
    } else if (keyword === 'include') {
      warnings.push('Include 文件需单独选择导入。');
    } else if (values.length) {
      blocks.at(-1).settings[keyword] ??= values[0];
    }
  }

  const rows = [];
  for (const alias of new Set(blocks.flatMap((block) => block.aliases))) {
    const settings = {};
    for (const block of blocks) {
      if (!block.defaults && !block.aliases.some((value) => value.toLowerCase() === alias.toLowerCase())) continue;
      for (const [key, value] of Object.entries(block.settings)) settings[key] ??= value;
    }
    const rawAddress = settings.hostname || alias;
    const rawKey = settings.identityfile?.replace(/^~\//, `${home}/`);
    const keyPath = rawKey && path.isAbsolute(rawKey) && !/[%$]/.test(rawKey) ? rawKey : '';
    const port = settings.port === undefined ? 22 : Number(settings.port);
    const unsupportedRoute = [settings.proxyjump, settings.proxycommand].some((value) => value && value.toLowerCase() !== 'none');
    const invalidAddress = !rawAddress || /[\s%@\\/]/.test(rawAddress);
    const issue = unsupportedRoute ? '需要跳板机或代理' : invalidAddress ? '主机地址含未解析参数' :
      !Number.isInteger(port) || port < 1 || port > 65535 ? '端口无效' : !settings.user ? '需要填写 SSH 用户名' : '';
    rows.push({ name: alias, address: rawAddress, username: settings.user || '', port, auth: keyPath ? 'key' : 'agent', keyPath, issue, editable: !settings.user && !unsupportedRoute && !invalidAddress && Number.isInteger(port) && port > 0 && port <= 65535 });
  }
  return { rows, warnings: [...new Set(warnings)] };
}

module.exports = { importSSHConfig };
