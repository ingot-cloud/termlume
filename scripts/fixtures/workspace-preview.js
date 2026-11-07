// Isolated UI fixture: no SSH, filesystem, keychain or Git operations.
const previewHosts = [
  {id:'api',name:'API 生产',address:'api.example.test',username:'ops',port:22,auth:'agent',group:'生产环境',tags:['api','production']},
  {id:'stage',name:'API 预发',address:'stage.example.test',username:'ops',port:2222,auth:'agent',group:'预发环境',tags:['api','staging']},
  {id:'db',name:'数据库',address:'db.example.test',username:'admin',port:22,auth:'agent',group:'生产环境',tags:['database']},
  {id:'jump',name:'运维跳板',address:'jump.example.test',username:'ops',port:22,auth:'agent',tags:['ops']}
];
const previewCalls = [];
let previewListener;
const previewSnippets = [
  {id:'disk',name:'磁盘巡检',command:'df -h',tags:['ops','disk']},
  {id:'multi',name:'服务检查',command:'pwd\nuptime',tags:['ops']}
];
window.termlume = {
  vault:{state:async()=>({enabled:false,locked:false,fileTransfers:true}),activity(){},touchIdAvailable:async()=>false},
  hosts:{list:async()=>previewHosts,recent:async()=>({api:3,stage:2,jump:1}),touch:async()=>{},hasPassword:async()=>false,csvPreview:async()=>null},
  groups:{list:async()=>[{id:'prod',path:'生产环境'},{id:'stage',path:'预发环境'}]},
  snippets:{list:async()=>previewSnippets,run:async value=>previewCalls.push(['run',value])},
  ssh:{jumpHosts:true,connect:async value=>{previewCalls.push(['connect',value]);queueMicrotask(()=>previewListener({type:'session',id:value.id,status:'ready'}));},input:async value=>previewCalls.push(['input',value]),resize(){},ack(){},close:async()=>{},directory:async()=>'/srv/app'},
  commands:{preview:async()=> 'df -h',close:async()=>{},stop:async()=>{}},
  files:{directoryDownloads:true,directoryUploads:true,mutations:true,history:async()=>[],list:async value=>{previewCalls.push(['list',value]);return {directory:value.directory||'/var/log/应用',entries:[{name:'nginx',kind:'directory'},{name:'error.log',kind:'file',size:1240},{name:'access.log',kind:'file',size:28000},{name:'.env',kind:'file',size:40}]};}},
  layouts:{list:async()=>[]},
  preferences:{get:async()=>({theme:'dark',terminalTheme:'dark',fontFamily:'Menlo, monospace',fontSize:14,recordCommands:false})},
  logs:{list:async()=>[]},history:{list:async()=>[]},
  forwards:{list:async()=>({rules:[],running:[]})},
  onEvent(listener){previewListener=listener;}
};
