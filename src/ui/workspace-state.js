(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.workspaceState=api;})(typeof window!=='undefined'?window:globalThis,()=>({
  retryDelay(attempt){return [1000,3000,8000][attempt-1]??null;},
  automaticCredential(auth,saved){return auth==='agent'||(auth==='password'&&saved);},
  reorder(ids,moving,before){if(moving===before||!ids.includes(moving)||!ids.includes(before))return [...ids];const out=ids.filter(id=>id!==moving);out.splice(out.indexOf(before),0,moving);return out;}
}));
