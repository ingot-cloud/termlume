// Isolated UI fixture: no SSH, filesystem, keychain or Git operations.
const previewHosts = [
  {id:'api',name:'API 生产',address:'api.example.test',username:'ops',port:22,auth:'agent',group:'生产环境',tags:['api','production']},
  {id:'stage',name:'API 预发',address:'stage.example.test',username:'ops',port:2222,auth:'agent',group:'预发环境',tags:['api','staging']},
  {id:'db',name:'数据库',address:'db.example.test',username:'admin',port:22,auth:'agent',group:'生产环境',tags:['database']},
  {id:'jump',name:'运维跳板',address:'jump.example.test',username:'ops',port:22,auth:'agent',tags:['ops']}
];
const previewCalls = [];
const previewResizes = [];
let previewListener;
const previewProtected = { enabled: true, locked: false, fileTransfers: true, startupUnlockSupported: true,
  startupUnlockRequired: true, autoLockMinutes: 15, remote: 'https://example.test/personal/termlume.git',
  branch: 'termlume-vault', lastSynced: 1794272400000, gitSettings: { paused: false, intervalMinutes: 0 } };
const previewKeySecrets = new Map();
const previewKeys = [
  {name:'id_ed25519',path:'/preview/key',type:'Ed25519',private:true,encrypted:true,publicKey:'ssh-ed25519 fixture',fingerprint:'SHA256:fixture'},
  {name:'id_rsa',path:'/preview/second-key',type:'RSA',private:true,encrypted:false,fingerprint:'SHA256:second'},
  {name:'id_ed25519.pub',path:'/preview/key.pub',type:'Ed25519',private:false,publicKey:'ssh-ed25519 fixture'}
];
let previewPreferences = {theme:'dark',terminalTheme:'dark',fontFamily:'Menlo, monospace',fontSize:14,recordCommands:false};
const previewIdentities = [{id:'ops',name:'运维登录配置',username:'ops',auth:'agent',hosts:[],groups:[]}];
const previewLayouts = [];
const previewSnippets = [
  {id:'disk',name:'磁盘巡检',command:'df -h',tags:['ops','disk']},
  {id:'multi',name:'服务检查',command:'pwd\nuptime',tags:['ops']}
];
window.termlume = {
  chrome: { startDragging: async () => previewCalls.push(['window-drag']),
    toggleMaximize: async () => previewCalls.push(['window-maximize']) },
  vault:{state:async()=>({enabled:false,locked:false,fileTransfers:true}),activity(){},touchIdAvailable:async()=>false,
    disable: async () => ({ enabled: false, locked: false, fileTransfers: true }),
    setStartupUnlockRequired: async value => ({ ...vaultStatus, startupUnlockRequired: value }),
    setAutoLockMinutes: async value => ({ ...vaultStatus, autoLockMinutes: value }),
    setTouchId: async value => ({ ...vaultStatus, touchIdEnabled: value }),
    setGitSettings: async value => ({ ...vaultStatus, gitSettings: value }),
    sync: async request => {
      previewCalls.push(['git-sync', request]);
      return { state: { ...vaultStatus, lastFetched: 1794272500000 } };
    }},
  hosts:{list:async()=>previewHosts,recent:async()=>({api:3,stage:2,jump:1}),touch:async()=>{},hasPassword:async()=>false,hasKeyPassphrase:async id=>previewKeySecrets.has(id),revealPassword:async()=>'',pickKey:async()=>'/preview/key',csvPreview:async()=>null,
    save:async value=>{previewCalls.push(['save-host',value]);const {localKeyPassphrase,clearKeyPassphrase,...fields}=value;const host={...fields,id:value.id||'new-host'};if(localKeyPassphrase)previewKeySecrets.set(host.id,localKeyPassphrase);const i=previewHosts.findIndex(h=>h.id===host.id);if(i>=0)previewHosts.splice(i,1);previewHosts.push(host);return previewHosts;}},
  groups:{list:async()=>[{id:'prod',name:'生产环境',path:'生产环境',hosts:[]},{id:'stage',name:'预发环境',path:'预发环境',hosts:[]}]},
  identities:{list:async()=>previewIdentities,save:async request=>{
    previewCalls.push(['save-identity',request]);
    const identity = { ...request.identity, id: request.identity.id || 'saved-identity', hosts: [], groups: [] };
    const index = previewIdentities.findIndex(item => item.id === identity.id);
    if (index < 0) previewIdentities.push(identity);
    else previewIdentities[index] = identity;
    return { identityId: identity.id, hosts: previewHosts };
  }},
  keys:{scan:async()=>({directory:'/preview/.ssh',keys:previewKeys}),agent:async()=>({available:true,keys:[]})},
  snippets:{list:async()=>previewSnippets,run:async value=>previewCalls.push(['run',value])},
  ssh:{jumpHosts:true,connect:async value=>{previewCalls.push(['connect',value]);queueMicrotask(()=>previewListener({type:'session',id:value.id,status:'ready'}));},input:async value=>previewCalls.push(['input',value]),resize:value=>previewResizes.push(value),ack(){},close:async()=>{},directory:async()=>'/srv/app'},
  commands:{preview:async()=> 'df -h',close:async()=>{},stop:async()=>{}},
  files:{
    directoryDownloads:true,directoryUploads:true,mutations:true,history:async()=>[],
    list:async value=>{previewCalls.push(['list',value]);return {directory:value.directory||'/var/log/应用',entries:[{name:'nginx',kind:'directory'},{name:'error.log',kind:'file',size:1240},{name:'access.log',kind:'file',size:28000},{name:'.env',kind:'file',size:40}]};},
    inspect:async ({path})=>({path,kind:path.endsWith('.json')?'file':'directory',downloadable:true}),
    readText:async ({path})=>({path,text:'{\r\n  "port": 22\r\n}\r\n',revision:'original'}),
    saveText:async value=>{previewCalls.push(['save-text',value]);return {revision:'saved'};},
    prepare:async value=>{previewCalls.push(['prepare',value]);return null;}
  },
  layouts:{list:async()=>previewLayouts,save:async request=>{
    previewCalls.push(['save-layout', request]);
    const layout = structuredClone({ ...request.layout, id: request.layout.id || 'saved-layout' });
    const index = previewLayouts.findIndex(item => item.id === layout.id);
    if (index < 0) previewLayouts.push(layout);
    else previewLayouts[index] = layout;
    return [...previewLayouts];
  },remove:async request=>{
    previewCalls.push(['remove-layout', request]);
    const index = previewLayouts.findIndex(item => item.id === request.layout.id);
    if (index >= 0) previewLayouts.splice(index, 1);
    return [...previewLayouts];
  }},
  preferences:{get:async()=>previewPreferences,fonts:async()=>['JetBrains Mono','Menlo','Monaco'],save:async value=>(previewPreferences=value)},
  logs:{list:async()=>[]},history:{list:async()=>[]},
  trust:{list:async()=>[]},
  forwards:{list:async()=>({rules:[],running:[]})},
  onEvent(listener){previewListener=listener;}
};
