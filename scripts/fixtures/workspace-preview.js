// Isolated UI fixture: no SSH, filesystem, keychain or Git operations.
const previewHosts = [
  {id:'api',name:'API 生产',address:'api.example.test',username:'ops',port:22,auth:'agent',group:'生产环境',tags:['api','production']},
  {id:'stage',name:'API 预发',address:'stage.example.test',username:'ops',port:2222,auth:'agent',group:'预发环境',tags:['api','staging']},
  {id:'db',name:'数据库',address:'db.example.test',username:'admin',port:22,auth:'agent',group:'生产环境',tags:['database']},
  {id:'jump',name:'运维跳板',address:'jump.example.test',username:'ops',port:22,auth:'agent',tags:['ops']}
];
const previewCalls = [];
const previewGroups = [
  {id:'prod',name:'生产环境'}, {id:'stage',name:'预发环境'}
];
function previewGroupList() {
  const path = group => group.parentId ? `${path(previewGroups.find(g => g.id === group.parentId))} / ${group.name}` : group.name;
  return previewGroups.map(group => {
    const fullPath = path(group);
    return { ...group, path: fullPath, hosts: previewHosts.filter(h => h.group === fullPath || h.group?.startsWith(fullPath + ' / ')).map(h => ({id:h.id,name:h.name})) };
  });
}
const previewServerInfo = `
__TERMLUME_INFO__version
1
__TERMLUME_INFO__platform
Linux
__TERMLUME_INFO__hostname
api-production
__TERMLUME_INFO__os
PRETTY_NAME="Ubuntu 24.04 LTS"
__TERMLUME_INFO__kernel
6.8.0-51-generic
__TERMLUME_INFO__architecture
x86_64
__TERMLUME_INFO__cpuModel
Intel Xeon Platinum 8375C CPU @ 2.90GHz
__TERMLUME_INFO__cpuCount
4
__TERMLUME_INFO__memory
MemTotal:       8388608 kB
MemAvailable:   5242880 kB
SwapTotal:      0 kB
SwapFree:       0 kB
__TERMLUME_INFO__uptime
987654.32 123456.00
__TERMLUME_INFO__load
0.25 0.40 0.31 1/100 222
__TERMLUME_INFO__cpuBefore
cpu 100 0 100 800 0 0 0 0 0 0
__TERMLUME_INFO__cpuAfter
cpu 125 0 110 865 0 0 0 0 0 0
__TERMLUME_INFO__networkBeforeTime
100.00 500.00
__TERMLUME_INFO__networkDefault
eth0
__TERMLUME_INFO__networkBefore
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast |bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
  veth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
  eth0: 1071644672 1 0 0 0 0 0 0 536346624 1 0 0 0 0 0 0
__TERMLUME_INFO__networkAfterTime
101.00 504.00
__TERMLUME_INFO__networkAfter
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast |bytes    packets errs drop fifo colls carrier compressed
    lo: 200 2 0 0 0 0 0 0 200 2 0 0 0 0 0 0
  veth0: 200 2 0 0 0 0 0 0 400 2 0 0 0 0 0 0
  eth0: 1073741824 2 0 0 0 0 0 0 536870912 2 0 0 0 0 0 0
__TERMLUME_INFO__diskIoBeforeTime
100.00 500.00
__TERMLUME_INFO__diskIoBefore
vda 252:0:1 1000000 500000 1000 500 100000 20000 10000 400000
vdb 252:16:2 2000000 1000000 2000 1000 200000 10000 5000 300000
__TERMLUME_INFO__diskIoAfterTime
101.00 504.00
__TERMLUME_INFO__diskIoAfter
vda 252:0:1 1004096 501024 1016 508 100400 20320 10480 400800
vdb 252:16:2 2002048 1000512 2040 1020 200100 10080 5080 300160
__TERMLUME_INFO__disks
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 104857600 41943040 62914560 40% /
/dev/vdb1 209715200 52428800 157286400 25% /srv/application data
__TERMLUME_INFO__end
ok
`;
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
const previewCommandDefaults = /* COMMAND_DEFAULTS */ [];
const previewSnippets = [
  {id:'disk',name:'磁盘巡检',command:'df -h',tags:['ops','disk'],pinned:true,order:0},
  {id:'multi',name:'服务检查',command:'pwd\nuptime',tags:['ops'],pinned:false,order:5},
  ...structuredClone(previewCommandDefaults)
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
  groups:{list:async()=>structuredClone(previewGroupList()),save:async request=>{
    previewCalls.push(['save-group',request]);
    const oldPaths = new Map(previewGroupList().map(g => [g.path,g.id]));
    const group={...request.group,id:request.group.id||`group-${previewCalls.length}`};
    const index=previewGroups.findIndex(g=>g.id===group.id);
    if(index<0)previewGroups.push(group);else previewGroups[index]=group;
    const paths=new Map(previewGroupList().map(g=>[g.id,g.path]));
    for(const host of previewHosts) {
      const id=host.groupId||oldPaths.get(host.group);
      if(id) {host.groupId=id;host.group=paths.get(id);}
    }
    return {groups:structuredClone(previewGroupList()),hosts:previewHosts};
  },remove:async ({group})=>{
    if(previewGroups.some(g=>g.parentId===group.id)||previewGroupList().find(g=>g.id===group.id)?.hosts.length)throw new Error('请先移走主机与子分组。');
    previewGroups.splice(previewGroups.findIndex(g=>g.id===group.id),1);
    return {groups:structuredClone(previewGroupList()),hosts:previewHosts};
  }},
  identities:{list:async()=>previewIdentities,save:async request=>{
    previewCalls.push(['save-identity',request]);
    const identity = { ...request.identity, id: request.identity.id || 'saved-identity', hosts: [], groups: [] };
    const index = previewIdentities.findIndex(item => item.id === identity.id);
    if (index < 0) previewIdentities.push(identity);
    else previewIdentities[index] = identity;
    return { identityId: identity.id, hosts: previewHosts };
  }},
  keys:{scan:async()=>({directory:'/preview/.ssh',keys:previewKeys}),agent:async()=>({available:true,keys:[]})},
  snippets:{list:async()=>structuredClone(previewSnippets),run:async value=>previewCalls.push(['run',value]),
    save:async ({snippet,expected})=>{
      previewCalls.push(['save-snippet',snippet]);
      const index=previewSnippets.findIndex(s=>s.id===snippet.id);
      if(index>=0 && JSON.stringify(previewSnippets[index])!==JSON.stringify(expected)) throw new Error('命令已变化，请刷新后重试。');
      const saved={...snippet,id:snippet.id||`snippet-${previewCalls.length}`};
      if(index<0)previewSnippets.push(saved);else previewSnippets[index]=saved;
      return structuredClone(previewSnippets);
    },
    remove:async ({snippet})=>{const index=previewSnippets.findIndex(s=>s.id===snippet.id);const original=previewCommandDefaults.find(s=>s.id===snippet.id);if(original)previewSnippets[index]=structuredClone(original);else previewSnippets.splice(index,1);},
    reorder:async ({ids})=>{ids.forEach((id,index)=>{previewSnippets.find(s=>s.id===id).order=(index+1)*10;});previewSnippets.sort((a,b)=>a.order-b.order);}},
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
window.termlume.ssh.serverInfo = async id => { previewCalls.push(['server-info', id]); return previewServerInfo; };

function previewNetworkHistory(now = Date.now()) {
  let history = [];
  for (let i = 0; i <= 60; i++) {
    if (i >= 31 && i <= 34) continue;
    history = window.serverInfo.appendNetworkHistory(history, [
      { name: 'eth0', downloadRate: (0.5 + (1 + Math.sin(i * .23)) * .45 + (i === 48 ? 1.2 : 0)) * 1024 ** 2,
        uploadRate: (.1 + (1 + Math.cos(i * .18)) * .15) * 1024 ** 2 },
      { name: 'veth0', downloadRate: 100 + i * 2, uploadRate: 200 + i }
    ], now - 300000 + i * 5000);
  }
  return history;
}

function previewResourceHistory(now = Date.now()) {
  let history = [];
  for (let i = 0; i <= 60; i++) {
    if (i >= 31 && i <= 34) continue;
    history = window.serverInfo.appendResourceHistory(history, {
      cpuPercent: 20 + (1 + Math.sin(i * .23)) * 15 + (i === 48 ? 35 : 0),
      memory: { percent: 55 + (1 + Math.cos(i * .18)) * 8 }
    }, now - 300000 + i * 5000);
  }
  return history;
}

function previewDiskHistory(now = Date.now()) {
  let history = [];
  for (let i = 0; i <= 60; i++) {
    if (i >= 31 && i <= 34) continue;
    history = window.serverInfo.appendDiskHistory(history, [
      { name: 'vda', identity: '252:0:1', readRate: (1 + Math.sin(i * .23)) * 1024 ** 2,
        writeRate: (.1 + (1 + Math.cos(i * .18)) * .3) * 1024 ** 2,
        iops: (1 + Math.sin(i * .23)) * 300 + (i === 48 ? 1200 : 0), utilization: (1 + Math.cos(i * .18)) * 40,
        readLatency: .2 + (1 + Math.sin(i * .21)) * .4, writeLatency: .5 + (1 + Math.cos(i * .18)) * 1.5,
        queueLength: .2 + (1 + Math.sin(i * .17)) * .6 + (i === 48 ? 2 : 0) },
      { name: 'vdb', identity: '252:16:2', readRate: 1024 ** 2, writeRate: 512 * 1024, iops: 100, utilization: 25,
        readLatency: 2, writeLatency: 4, queueLength: .16 }
    ], now - 300000 + i * 5000);
  }
  return history;
}
