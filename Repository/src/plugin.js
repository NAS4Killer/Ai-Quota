import WebSocket from 'ws';
import { ChatGptDesktopQuotaClient, normalizeQuota, mergeQuotaUpdate } from './quota.js';
import { ClaudeQuotaClient, normalizeClaudeQuota } from './claude.js';
import { normalizeSettings, normalizeInitialSettings, renderKey, selectAvailableWindow } from './render.js';
import { dirname, join, resolve } from 'node:path';
import { UpdateChecker, GITHUB_REPOSITORY_URL } from './update.js';

const ACTIONS=new Map([['de.ai-quota.quota','chatgpt'],['de.ai-quota.claude','claude']]);
// Resolve from the running plugin, independent of install drive or user profile.
const runtimeDirectory=dirname(resolve(process.argv[1]));
const bundledClaude=join(runtimeDirectory,'claude','claude.exe');
const bundledClaudeSdk=join(runtimeDirectory,'claude-sdk','sdk.mjs');
function settingsFor(provider,raw={}){return normalizeSettings({...raw,...(provider==='claude'&&raw.title===undefined?{title:'Claude'}:{})});}
function sourceId(key){return JSON.stringify(key.provider==='claude'?['claude',key.settings.claudePath,key.settings.claudeConfigDir]:['chatgpt','desktop']);}
const args=new Map();
for(let i=2;i<process.argv.length-1;i+=2)args.set(process.argv[i],process.argv[i+1]);
const port=args.get('-port'),uuid=args.get('-pluginUUID'),registerEvent=args.get('-registerEvent');
if(!/^\d+$/.test(port??'')||!uuid||registerEvent!=='registerPlugin')throw new Error('Ai-Quota wird durch Stream Deck gestartet.');
const socket=new WebSocket(`ws://127.0.0.1:${port}`);
const keys=new Map(),sources=new Map();
const updates=new UpdateChecker({onChange:()=>{for(const context of keys.keys())render(context);}});
function checkUpdates(){if([...keys.values()].some(key=>key.settings.showUpdateInfo))updates.check();}
let inspectorContext=null;
const send=(event,context,payload)=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({event,...(context?{context}:{}),...(payload===undefined?{}:{payload})}));};
function sourceFor(key) {
  const path=sourceId(key);
  if(sources.has(path))return sources.get(path);
  const client=key.provider==='claude'?new ClaudeQuotaClient(key.settings.claudePath,{bundledExecutable:bundledClaude,sdkPath:bundledClaudeSdk,configDir:key.settings.claudeConfigDir}):new ChatGptDesktopQuotaClient();
  const source={client,result:null,error:null,lastAttempt:0,lastSuccess:0,busy:null,login:null,loginBusy:false};
  sources.set(path,source);
  client.on('limits',result=>{source.result=mergeQuotaUpdate(source.result,result);source.error=null;source.lastSuccess=Date.now();renderSource(path);});
  client.on('unavailable',message=>{source.error=message;renderSource(path);});
  client.on('login',state=>{source.login=state;renderSource(path);});
  return source;
}
function view(key) {
  const source=sources.get(sourceId(key));
  let data=null,error=source?.error??null;
  try {if(source?.result)data=key.provider==='claude'?normalizeClaudeQuota(source.result):normalizeQuota(source.result,key.settings.bucket);} catch(e){error=e.message;}
  const stale=!!data&&(!!error||Date.now()-source.lastSuccess>Math.max(120,key.settings.refreshSeconds*2)*1000);
  return {data,status:{error,stale,updateAvailable:updates.available},lastSuccess:source?.lastSuccess??0,login:source?.login??null};
}
function render(context) {
  const key=keys.get(context);if(!key)return;
  const {data,status}=view(key);
  const selected=selectAvailableWindow(key.settings.window,data);
  if(selected!==key.settings.window){
    key.settings={...key.settings,window:selected};
    send('setSettings',context,key.settings);
  }
  const image='data:image/svg+xml;base64,'+Buffer.from(renderKey(key.settings,data,status)).toString('base64');
  if(image!==key.lastImage){send('setImage',context,{image,target:0});key.lastImage=image;}
  if(context===inspectorContext)notifyInspector(context);
}
function notifyInspector(context) {
  const key=keys.get(context);if(!key)return;
  const v=view(key);
  send('sendToPropertyInspector',context,{...v,buckets:Object.keys(sources.get(sourceId(key))?.result?.rateLimitsByLimitId??{}),settings:key.settings});
}
function renderSource(path){for(const [context,key] of keys)if(sourceId(key)===path)render(context);}
async function refresh(path,force=false) {
  const source=sources.get(path);if(!source)return;
  if(source.loginBusy)return;
  if(source.busy)return source.busy;
  const relevant=[...keys.values()].filter(k=>sourceId(k)===path);
  if(!relevant.length)return;
  const interval=Math.min(...relevant.map(k=>k.settings.refreshSeconds))*1000;
  if(!force&&Date.now()-source.lastAttempt<interval)return;
  // Also debounce repeated physical key presses and inspector requests.
  if(force&&Date.now()-source.lastAttempt<2000)return;
  source.lastAttempt=Date.now();
  source.busy=(async()=>{
    try{source.result=await source.client.read();source.lastSuccess=Date.now();source.error=null;source.login=null;}
    catch(error){source.error=error.message;}
    finally{source.busy=null;renderSource(path);}
  })();
  return source.busy;
}
async function login(path){
  const source=sources.get(path);if(!source||source.loginBusy)return;
  source.loginBusy=true;source.loginCancelled=false;
  source.login={phase:'waiting',message:'Claude-Anmeldung wird gestartet.',url:null};
  renderSource(path);
  // Finish any poll before switching accounts; do not retain another account's values.
  source.client.stop();
  await source.busy;
  if(sources.get(path)!==source)return;
  source.result=null;source.lastSuccess=0;source.error=null;
  let completed=false;
  try{
    if(source.loginCancelled)throw new Error('Claude-Anmeldung abgebrochen.');
    await source.client.login();completed=true;
  }
  catch(error){source.error=error.message;source.login={phase:'error',message:error.message,url:null};}
  finally{source.loginBusy=false;renderSource(path);}
  if(completed&&sources.get(path)===source){source.lastAttempt=0;await refresh(path,true);}
}
function releaseUnused() {
  for(const [path,source]of sources)if(![...keys.values()].some(k=>sourceId(k)===path)){source.client.stop();sources.delete(path);}
}
// Registration requires UUID on the envelope, unlike action commands.
socket.on('open',()=>socket.send(JSON.stringify({event:registerEvent,uuid})));
socket.on('message',buffer=>{
  let message;try{message=JSON.parse(buffer.toString());}catch{return;}
  if(!ACTIONS.has(message.action))return;
  const {event,context,payload={}}=message;
  if(event==='willAppear'){
    const provider=ACTIONS.get(message.action);
    const raw=payload.settings??{};
    const settings=normalizeInitialSettings({...raw,...(provider==='claude'&&raw.title===undefined?{title:'Claude'}:{})});
    keys.set(context,{provider,settings,lastImage:null});
    if(raw.startTemplateVersion!==1)send('setSettings',context,settings);
    sourceFor(keys.get(context));render(context);refresh(sourceId(keys.get(context)));checkUpdates();
  } else if(event==='willDisappear'){
    keys.delete(context);if(inspectorContext===context)inspectorContext=null;releaseUnused();
  } else if(event==='didReceiveSettings'&&keys.has(context)){
    const incoming=settingsFor(keys.get(context).provider,payload.settings);
    if(incoming.settingsRevision<keys.get(context).settings.settingsRevision)return;
    keys.get(context).settings=incoming;releaseUnused();sourceFor(keys.get(context));render(context);refresh(sourceId(keys.get(context)));checkUpdates();
  } else if(event==='keyDown'&&keys.has(context)){
    const key=keys.get(context);
    if(key.settings.showUpdateInfo&&updates.available)send('openUrl',null,{url:GITHUB_REPOSITORY_URL});
    else refresh(sourceId(key),true);
  }
  else if(event==='propertyInspectorDidAppear'){inspectorContext=context;notifyInspector(context);}
  else if(event==='propertyInspectorDidDisappear'&&inspectorContext===context)inspectorContext=null;
  else if(event==='sendToPlugin'&&keys.has(context)){
    if(payload.command==='settings'&&payload.settings){
      const incoming=settingsFor(keys.get(context).provider,payload.settings);
      if(incoming.settingsRevision>=keys.get(context).settings.settingsRevision){
        keys.get(context).settings=incoming;send('setSettings',context,incoming);releaseUnused();sourceFor(keys.get(context));render(context);refresh(sourceId(keys.get(context)));checkUpdates();
      }
      send('sendToPropertyInspector',context,{command:'settingsApplied',requestId:payload.requestId,settings:keys.get(context).settings});
      return;
    }
    if(payload.settings&&(payload.command==='refresh'||payload.command==='login')){
      const key=keys.get(context),incoming=settingsFor(key.provider,payload.settings);
      if(incoming.settingsRevision>=key.settings.settingsRevision){
        key.settings=incoming;releaseUnused();sourceFor(key);render(context);checkUpdates();
      }
    }
    if(payload.command==='state') {inspectorContext=context;notifyInspector(context);}
    else if(payload.command==='refresh')refresh(sourceId(keys.get(context)),true);
    else if(payload.command==='login'){
      const key=keys.get(context),source=sourceFor(key);
      if(key.provider==='claude')login(sourceId(key));
      else source.client.openDesktop().then(()=>notifyInspector(context)).catch(error=>{source.error=error.message;render(context);});
    }else if(payload.command==='cancelLogin'){
      const key=keys.get(context);
      if(key.provider==='claude'){
        const source=sourceFor(key);source.loginCancelled=true;source.client.cancelLogin();
      }
    }
  }
});
const timer=setInterval(()=>{
  for(const path of sources.keys())refresh(path);
  for(const context of keys.keys())render(context);
},15000);
function cleanup(){clearInterval(timer);updates.dispose();for(const source of sources.values())source.client.stop();sources.clear();}
socket.on('close',cleanup);
socket.on('error',()=>{cleanup();process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{cleanup();socket.close();});
