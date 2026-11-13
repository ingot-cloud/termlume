// Isolated, offline design previews using the real renderer and fictional fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const root = path.resolve(__dirname, '../../..');
const schemes = require('./schemes.json');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const script = source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`;
const sources = {
  '/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js',
  '/fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js',
  '/dropdown.js':'src/ui/dropdown.js', '/overlays.js':'src/ui/overlays.js',
  '/terminal-paths.js':'src/ui/terminal-paths.js', '/workspace-state.js':'src/ui/workspace-state.js',
  '/server-info.js':'src/ui/server-info.js', '/renderer.js':'src/ui/renderer.js'
};
const bundleFileEditor = require(path.join(root, 'scripts/bundle-file-editor.cjs'));
let html = read('src/ui/index.html').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
html = html.replace(/<script defer src="([^"]+)"><\/script>/g, (_, source) => source === '/renderer.js'
  ? script(read('scripts/fixtures/workspace-preview.js')) + script(bundleFileEditor()) + script(read(sources[source]))
  : script(read(sources[source])));
const scripts = html.match(/<script>[\s\S]*?<\/script>/g).join('\n');
html = html.replace(/<script>[\s\S]*?<\/script>/g, '');
html = html.replace('<link rel="stylesheet" href="/xterm.css">', `<style>${read('node_modules/@xterm/xterm/css/xterm.css')}</style>`)
  .replace('<link rel="stylesheet" href="/style.css">', `<style>${read('src/ui/style.css')}</style>`);
const output = path.join(root, 'dist/brand-concepts-20261113');
fs.mkdirSync(output, { recursive: true });
for (const scheme of schemes) {
  const css = fs.readFileSync(path.join(__dirname, scheme.id, 'theme-preview.css'), 'utf8')
    + '\n*,*::before,*::after{transition:none!important;animation:none!important;}';
  const setup = `(async()=>{try{
    const tick=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await tick(); await refreshHosts();
    const primary=await openHost(previewHosts[0]);
    await openHost(previewHosts[1]); selectTab(primary); await tick();
    const colors=getComputedStyle(document.documentElement);
    primary.view.style.setProperty('--terminal-background',colors.getPropertyValue('--terminal').trim());
    primary.terminal.options.theme={...primary.terminal.options.theme,
      background:colors.getPropertyValue('--terminal').trim(),
      foreground:colors.getPropertyValue('--terminal-text').trim(),
      cursor:colors.getPropertyValue('--accent').trim(),
      selectionBackground:colors.getPropertyValue('--terminal-selection').trim(),
      magenta:${JSON.stringify(scheme.accent)},brightBlack:colors.getPropertyValue('--muted').trim()};
    const lines=[
      '\\x1b[35mops@api-production\\x1b[0m \\x1b[90m/srv/app\\x1b[0m',
      '$ kubectl get pods -n production','',
      'NAME                         READY   STATUS      RESTARTS   AGE',
      'api-6b8d7f9c4-xk2pm           2/2     \\x1b[32mRunning\\x1b[0m     0          12d',
      'worker-7c5f84b9d-nq4rz        1/1     \\x1b[32mRunning\\x1b[0m     0          12d',
      'scheduler-5d8f76b4c-rt9xm     1/1     \\x1b[32mRunning\\x1b[0m     0          8d','',
      '\\x1b[35mops@api-production\\x1b[0m \\x1b[90m/srv/app\\x1b[0m',
      '$ git status --short --branch',
      '## \\x1b[35mmain\\x1b[0m...origin/main','',
      '\\x1b[90m# workspace ready · all services healthy\\x1b[0m','',
      '\\x1b[35mops@api-production\\x1b[0m \\x1b[90m/srv/app\\x1b[0m','$ '
    ];
    await new Promise(r=>primary.terminal.write('\\x1b[2J\\x1b[H'+lines.join('\\r\\n'),r));
    toggleFiles(); await tick(); await tick();
    window.brandPreviewReady=true;
  }catch(error){window.brandPreviewError=error.stack;}})();`;
  const themed = html.replace(/<svg class="brand-mark"[\s\S]*?<\/svg>/,
    () => `<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">${scheme.mark}</svg>`)
    .replace('</head>', () => `<style>${css}</style></head>`)
    .replace('</body>', () => scripts + script(setup) + '</body>');
  fs.writeFileSync(path.join(output, scheme.id + '.html'), themed);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-brand-preview-'));
const browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',
  '--remote-debugging-pipe',`--user-data-dir=${profile}`
], { stdio: ['ignore','ignore','pipe','pipe','pipe'] });
let index=0, buffer=Buffer.alloc(0), stderr=''; const pending=new Map();
browser.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
browser.on('error',error=>{for(const waiter of pending.values())waiter.reject(error);});
browser.on('exit',()=>{for(const waiter of pending.values())waiter.reject(new Error(`Browser exited: ${stderr}`));});
function request(method,params={},sessionId){return new Promise((resolve,reject)=>{
  const id=++index;pending.set(id,{resolve,reject});
  browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId&&{sessionId})})+'\0');
});}
browser.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.includes(0)){
  const at=buffer.indexOf(0);const message=JSON.parse(buffer.subarray(0,at));buffer=buffer.subarray(at+1);
  const waiter=pending.get(message.id);if(!waiter)continue;pending.delete(message.id);
  if(message.error)waiter.reject(new Error(message.error.message));else waiter.resolve(message.result);
}});
const deadline=setTimeout(()=>{browser.kill();process.exitCode=1;},60000);
(async()=>{
  const {targetId}=await request('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await request('Target.attachToTarget',{targetId,flatten:true});
  const run=(method,params)=>request(method,params,sessionId);
  await run('Emulation.setDeviceMetricsOverride',{width:1140,height:570,deviceScaleFactor:2,mobile:false});
  for(const scheme of schemes){
    await run('Page.navigate',{url:pathToFileURL(path.join(output,scheme.id+'.html')).href});
    let ready=false;
    for(let i=0;i<120;i++){
      const {result}=await run('Runtime.evaluate',{expression:'({ready:window.brandPreviewReady,error:window.brandPreviewError})',returnByValue:true});
      if(result.value?.error)throw new Error(result.value.error);
      if(result.value?.ready){ready=true;break;}
      await new Promise(r=>setTimeout(r,50));
    }
    if(!ready)throw new Error('Theme preview did not become ready: '+scheme.id);
    const {data}=await run('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(__dirname,scheme.id,'theme-preview.png'),Buffer.from(data,'base64'));
    console.log('Captured offline theme:',scheme.id);
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  clearTimeout(deadline);browser.kill();setTimeout(()=>fs.rmSync(profile,{recursive:true,force:true}),500);
});
