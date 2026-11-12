const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');

// Exercise the actual renderer actions without a browser or a live SSH connection.
const renderer = fs.readFileSync(require.resolve('../src/ui/renderer.js'), 'utf8');
const extract = (from, to) => {
  const start = renderer.indexOf(from), end = renderer.indexOf(to, start);
  assert(start >= 0 && end > start, `Renderer test boundary missing: ${from} → ${to}`);
  return renderer.slice(start, end);
};
function fixture() {
  const session = {id:'production-session',status:'ready',attempts:1,host:{id:'production',name:'生产',username:'ops',address:'example.test',port:22}};
  const calls = [];
  session.terminal = {
    buffer: { active: { type: 'normal' } },
    modes: { mouseTrackingMode: 'none' },
    paste: data => calls.push(['input', { id: session.id, data }])
  };
  const scope = {
    tabs:new Map([[session.id, session]]), vaultStatus:{locked:false}, active: session,
    api:{snippets:{run:async value => calls.push(['run',value])}},
    confirm:async (...args) => { calls.push(['confirm',args]); return true; },
    endpoint:host=>`${host.username}@${host.address}`, sessionId:()=> 'command-output',
    attachTerminal:tab=> calls.push(['terminal',tab]), selectTab:tab=> calls.push(['select',tab]),
    updateSession:()=>{},focusTerminal:()=>{},status:()=>{},message:error=>String(error)
  };
  vm.createContext(scope);
  vm.runInContext([
    extract('function readySession(', '\nfunction renderTerminalBottom('),
    extract('function fillTerminalCommand(', '\nasync function configureCommand('),
    extract('async function useSnippet(', '\nasync function manageGroups(')
  ].join('\n'), scope);
  return {scope,session,calls,snippet:{id:'disk',name:'磁盘',command:'df -h',tags:[]}};
}

test('saved command paste targets only the selected SSH session and never appends Enter', async () => {
  const {scope,session,calls,snippet} = fixture();
  await scope.useSnippet(session,snippet,true,1);
  assert.equal(calls[0][0], 'input');
  assert.equal(calls[0][1].id, session.id);
  assert.equal(calls[0][1].data, 'df -h');
  assert.equal(calls.some(([type]) => type === 'run'), false);
  await assert.rejects(scope.useSnippet(session,{...snippet,command:'pwd\nuptime'},true,1), /多行命令/);
  session.terminal.buffer.active.type = 'alternate';
  await assert.rejects(scope.useSnippet(session,snippet,true,1), /交互程序/);
  assert.equal(calls.filter(([type])=>type==='input').length, 1);
});

test('commands captured before reconnect, close or vault lock cannot send input', async () => {
  for (const change of [
    ({session})=>{session.attempts++;},
    ({scope,session})=>scope.tabs.delete(session.id),
    ({scope})=>{scope.vaultStatus.locked=true;},
    ({session})=>{session.status='closed';}
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.scope.useSnippet(f.session,f.snippet,true,1), /会话已变化/);
    assert.deepEqual(f.calls, []);
  }
});

test('saved command execution previews the host and uses a separate output channel', async () => {
  const {scope,session,calls,snippet} = fixture();
  await scope.useSnippet(session,snippet,false,1);
  assert.match(calls[0][1][1], /生产.*ops@example.test[\s\S]*df -h/);
  const run = calls.find(([type])=>type==='run')[1];
  assert.equal(run.sessionId, session.id);
  assert.equal(run.id, 'command-output');
  assert.equal(run.expected, snippet);
  assert.equal(calls.some(([type])=>type==='input'), false);
});

test('canceling or reconnecting during command preview never starts the command', async () => {
  for (const reconnect of [false,true]) {
    const {scope,session,calls,snippet} = fixture();
    scope.confirm=async()=>{ if(reconnect) session.attempts++; return reconnect; };
    if(reconnect) await assert.rejects(scope.useSnippet(session,snippet,false,1), /会话已变化/);
    else await scope.useSnippet(session,snippet,false,1);
    assert.deepEqual(calls, []);
  }
});

test('the Tauri bridge sends a pending PTY resize before later terminal input', async () => {
  const calls = [];
  let finishResize;
  const window = { __TAURI__: {
    core: { invoke: async (_command, { name }) => {
      calls.push(name);
      if (name === 'ssh:resize') await new Promise(resolve => { finishResize = resolve; });
    } },
    window: { getCurrentWindow() {} }
  } };
  const bridge = fs.readFileSync(require.resolve('../src/ui/tauri-bridge.js'), 'utf8');
  vm.runInNewContext(bridge, { window, navigator: { platform: 'MacIntel' } });
  const { ssh } = window.termlume;
  const id = 'session';
  await ssh.connect({ id });
  ssh.resize({ id, size: { cols: 210, rows: 46 } });
  ssh.input({ id, data: 'ls\r' });
  await nextTurn();
  assert.deepEqual(calls, ['ssh:connect', 'ssh:resize']);
  finishResize();
  await nextTurn();
  assert.deepEqual(calls, ['ssh:connect', 'ssh:resize', 'ssh:input']);
});
