import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Resvg } from '@resvg/resvg-js';
import { DEFAULTS, renderKey, normalizeSettings, normalizeInitialSettings } from '../src/render.js';
import { normalizeClaudeQuota } from '../src/claude.js';
import { ChatGptDesktopQuotaClient, discoverChatGptDesktop } from '../src/quota.js';

const require=createRequire(import.meta.url);
test('title and both reset overlays are independent in all five layouts',()=>{
  const now=Date.UTC(2026,9,14,12),data={fiveHour:{usedPercent:20,resetsAt:now/1000+3600},week:{usedPercent:40,resetsAt:now/1000+172800}};
  const settings={title:'A & B',showTitle:true,resetFiveHourVisible:true,resetWeekVisible:true,resetFiveHourPosition:'middle-left',resetFiveHourOffsetX:13,resetFiveHourOffsetY:-5,resetFiveHourSize:16,resetFiveHourWeight:700,resetFiveHourColor:'#123456',resetWeekPosition:'bottom-right',resetWeekOffsetX:-7,resetWeekOffsetY:-22,resetWeekSize:18,resetWeekFormat:'absolute'};
  for(const style of ['dual','number','ring','fill','frame']){
    const dom=new JSDOM(renderKey({...settings,style},data,{},now),{contentType:'image/svg+xml'});
    try{
      const five=dom.window.document.querySelector('[data-element="resetFiveHour"]'),week=dom.window.document.querySelector('[data-element="resetWeek"]');
      assert.equal(five.textContent,'in 1 h 0 m');assert.equal(five.getAttribute('x'),'21');assert.equal(five.getAttribute('y'),'72.6');assert.equal(five.getAttribute('font-size'),'16');assert.equal(five.getAttribute('fill'),'#123456');assert.equal(five.getAttribute('font-weight'),'700');
      assert.equal(week.getAttribute('x'),'129');assert.equal(week.getAttribute('y'),'118');assert.equal(week.getAttribute('text-anchor'),'end');assert.equal(week.textContent,new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(data.week.resetsAt*1000)));
      assert.equal(dom.window.document.querySelector('[data-element="title"]').textContent,'A & B');
      assert(!renderKey({...settings,style,showTitle:false,resetFiveHourVisible:false,resetWeekVisible:false},data,{},now).includes('data-element='));
      assert(!renderKey({...settings,style},{week:{usedPercent:40}}, {},now).includes('data-element="reset'));
      assert(!renderKey({titlePosition:'none'},data,{},now).includes('data-element="title"'));
    }finally{dom.window.close();}
  }
});

test('shared text editor preserves separate title and reset settings through switching and reopening',async()=>{
  const html=await readFile('de.ai-quota.sdPlugin/ui/settings.html','utf8');
  for(const action of ['de.ai-quota.quota','de.ai-quota.claude']){
    const messages=[];
    function open(settings={}){
      let socket;
      class Socket{static OPEN=1;readyState=1;constructor(){socket=this;}send(message){messages.push(JSON.parse(message));}}
      const dom=new JSDOM(html,{runScripts:'dangerously',beforeParse(window){window.WebSocket=Socket;}});
      dom.window.connectElgatoStreamDeckSocket('1','inspector','registerPropertyInspector','{}',JSON.stringify({context:'key',action,payload:{settings}}));socket.onopen();
      return dom;
    }
    let dom=open({resetWeekVisible:false});
    const select=(value)=>{const el=dom.window.document.getElementById('textElement');el.value=value;el.dispatchEvent(new dom.window.Event('change'));};
    const edit=(id,value)=>{const el=dom.window.document.getElementById(id);el.value=value;el.dispatchEvent(new dom.window.Event('input'));};
    try{
      select('resetFiveHour');assert.equal(dom.window.document.getElementById('textVisible').checked,false);
      dom.window.document.getElementById('textVisible').click();edit('titleSize',16);edit('titlePosition','middle-left');edit('titleOffsetX',13);edit('titleOffsetY',-5);edit('titleWeight','700');edit('titleColor','#123456');edit('resetTextFormat','absolute');
      select('resetWeek');assert.equal(dom.window.document.getElementById('textVisible').checked,false);
      dom.window.document.getElementById('textVisible').click();edit('titleSize',18);edit('titlePosition','bottom-right');edit('titleOffsetX',-7);edit('titleOffsetY',-22);edit('titleWeight','900');edit('titleColor','#654321');
      select('title');assert.equal(dom.window.document.getElementById('titleSize').value,'24');assert.equal(dom.window.document.getElementById('title').value,action.endsWith('claude')?'Claude':'chatGPT');
      dom.window.document.getElementById('textVisible').click();await wait(150);
      const saved=messages.findLast(m=>m.payload?.command==='settings').payload.settings;
      assert.equal(saved.showTitle,false);assert.equal(saved.resetFiveHourVisible,true);assert.equal(saved.resetWeekVisible,true);assert.equal(saved.resetFiveHourFormat,'absolute');assert.equal(saved.resetWeekFormat,'relative');assert.equal(saved.resetFiveHourOffsetX,13);assert.equal(saved.resetWeekOffsetX,-7);assert.equal(saved.resetFiveHourWeight,700);assert.equal(saved.resetWeekWeight,900);
      dom.window.close();dom=open(saved);
      select('resetFiveHour');assert.equal(dom.window.document.getElementById('titleSize').value,'16');assert.equal(dom.window.document.getElementById('titleColor').value,'#123456');assert.equal(dom.window.document.getElementById('textVisible').checked,true);dom.window.document.getElementById('textVisible').click();
      select('resetWeek');assert.equal(dom.window.document.getElementById('titleSize').value,'18');assert.equal(dom.window.document.getElementById('titleColor').value,'#654321');assert.equal(dom.window.document.getElementById('textVisible').checked,true);dom.window.document.getElementById('textVisible').click();
      select('title');assert.equal(dom.window.document.getElementById('textVisible').checked,false);await wait(150);
      const none=messages.findLast(m=>m.payload?.command==='settings').payload.settings;assert.equal(none.showTitle,false);assert.equal(none.resetFiveHourVisible,false);assert.equal(none.resetWeekVisible,false);
    }finally{dom.window.close();}
  }
});

test('old factory appearance upgrades once while custom appearance and account settings survive',()=>{
  const old=normalizeSettings({title:'Claude',numberY:77,barY:120,titleSize:18,titleWeight:400,direction:'clockwise',showWindowLabels:true,window:'fiveHour',transparentBackground:false,textGood:'#b6df29',barGood:'#b6df29',claudePath:'custom-claude',claudeConfigDir:'selected-profile'});
  delete old.startTemplateVersion;
  const upgraded=normalizeInitialSettings(old);
  for(const key of ['numberY','barY','titleSize','titleWeight','direction','showWindowLabels','window','transparentBackground','textGood','barGood'])assert.equal(upgraded[key],DEFAULTS[key],key);
  assert.equal(upgraded.title,'Claude');assert.equal(upgraded.claudePath,'custom-claude');assert.equal(upgraded.claudeConfigDir,'selected-profile');
  assert.equal(upgraded.startTemplateVersion,1);assert(upgraded.settingsRevision>old.settingsRevision);
  const changedBack={...old,startTemplateVersion:1};assert.deepEqual(normalizeInitialSettings(changedBack),changedBack);
  const custom={...old,titleSize:29};assert.equal(normalizeInitialSettings(custom).titleSize,29);assert.equal(normalizeInitialSettings(custom).barY,120);
});
const claudeRaw={five_hour:{utilization:23,resets_at:'2026-10-14T12:00:00Z'},seven_day:{utilization:41,resets_at:'2026-10-20T12:00:00Z'}};
const codexRaw={rateLimitsByLimitId:{codex:{primary:{usedPercent:13,windowDurationMins:10080,resetsAt:1792478199}}}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const desktopPackage={installLocation:'F:\\Apps\\ChatGPT_26.1002.7124.0',application:'app/ChatGPT.exe',applicationId:'OpenAI.Codex_testpackage!App',authHome:'D:\\Profiles\\Test\\.codex',userProfile:'D:\\Profiles\\Test'};
const desktop={...desktopPackage,applicationPath:win32.join(desktopPackage.installLocation,'app','ChatGPT.exe'),executable:win32.join(desktopPackage.installLocation,'app','resources','codex.exe')};

function rpcChild(reply){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=0;child.kill=()=>{child.killed++;child.emit('exit',0);};
  child.stdin.on('data',buffer=>{for(const line of buffer.toString().trim().split('\n')){const request=JSON.parse(line);if(request.id!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,...reply(request)})+'\n'));}});
  return child;
}

test('ChatGPT Desktop discovery follows Windows registration on other drives and after updates',async()=>{
  for(const installLocation of ['F:\\Apps\\ChatGPT_26.1002.7124.0','G:\\Installed Apps\\ChatGPT_26.1101.1.0']){
    const result=await discoverChatGptDesktop({platform:'win32',env:{SystemRoot:'D:\\Windows'},exists:path=>path.startsWith(installLocation),run:async(exe,args,options)=>{
      assert.equal(exe,'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert(args.includes('-NoProfile'));assert.match(Buffer.from(args.at(-1),'base64').toString('utf16le'),/Get-AppxPackage -Name 'OpenAI.Codex'/);
      assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
      return {stdout:JSON.stringify([{...desktopPackage,installLocation}])};
    }});
    assert.equal(result.executable,win32.join(installLocation,'app','resources','codex.exe'));assert.equal(result.authHome,desktop.authHome);
  }
  for(const entries of [[],[{...desktopPackage,application:'../ChatGPT.exe'}],[{...desktopPackage,applicationId:'Unrelated.App!App'}]]){
    await assert.rejects(discoverChatGptDesktop({platform:'win32',env:{SystemRoot:'C:\\Windows'},exists:()=>true,run:async()=>({stdout:JSON.stringify(entries)})}),/nicht gefunden/);
  }
});

test('ChatGPT quota uses the desktop login location and reloads it for each poll',async()=>{
  const children=[],calls=[];let usage=13,discoveries=0;
  const client=new ChatGptDesktopQuotaClient({env:{SystemRoot:'C:\\Windows',CODEX_HOME:'E:\\unrelated-host-profile'},discover:async()=>{discoveries++;return desktop;},spawnProcess:(exe,args,options)=>{
    assert.equal(exe,desktop.executable);assert.deepEqual(args,['app-server','--listen','stdio://']);assert.equal(options.env.CODEX_HOME,desktop.authHome);assert.equal(options.cwd,desktop.userProfile);assert.equal(options.shell,false);
    const child=rpcChild(request=>{calls.push(request.method);return {result:request.method==='account/read'?{account:{type:'chatgpt'}}:request.method==='account/rateLimits/read'?{rateLimitsByLimitId:{codex:{primary:{usedPercent:usage,windowDurationMins:10080}}}}:{}};});children.push(child);return child;
  }});
  const first=await client.read();usage=47;const second=await client.read();
  assert.equal(first.rateLimitsByLimitId.codex.primary.usedPercent,13);assert.equal(second.rateLimitsByLimitId.codex.primary.usedPercent,47);
  assert.equal(discoveries,2);assert.deepEqual(children.map(c=>c.killed),[1,1]);
  assert.deepEqual(calls,['initialize','account/read','account/rateLimits/read','initialize','account/read','account/rateLimits/read']);
});

test('missing or API-only ChatGPT desktop login never starts a separate sign-in',async()=>{
  for(const account of [null,{type:'apiKey'}]){
    const methods=[];let child;
    const client=new ChatGptDesktopQuotaClient({discover:async()=>desktop,spawnProcess:()=>child=rpcChild(request=>{methods.push(request.method);return {result:request.method==='account/read'?{account}:{}};})});
    await assert.rejects(client.read(),/ChatGPT-Desktop-App anmelden|ChatGPT-Desktop-App mit deinem ChatGPT-Konto/);
    assert.deepEqual(methods,['initialize','account/read']);assert.equal(child.killed,1);
  }
});

test('ChatGPT account button activates the registered desktop app',async()=>{
  const calls=[];
  const client=new ChatGptDesktopQuotaClient({discover:async()=>desktop,env:{SystemRoot:'D:\\Windows'},spawnProcess:(exe,args,options)=>{
    calls.push({exe,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  await client.openDesktop();assert.equal(calls.length,1);assert.equal(calls[0].exe,'D:\\Windows\\explorer.exe');assert.deepEqual(calls[0].args,['shell:AppsFolder\\OpenAI.Codex_testpackage!App']);assert.equal(calls[0].options.shell,false);
});

test('ChatGPT connection check performs only the T3 handshake and account request',async()=>{
  const methods=[];
  const client=new ChatGptDesktopQuotaClient({discover:async()=>desktop,spawnProcess:()=>rpcChild(request=>{
    methods.push(request.method);
    return {result:request.method==='account/read'?{account:{type:'chatgpt'}}:{}};
  })});
  assert.deepEqual(await client.connect(),{connected:true,authentication:'authenticated',accountType:'chatgpt'});
  assert.deepEqual(methods,['initialize','account/read']);
});

test('bundled actions keep their settings and accounts separate through Claude login, refresh and cancellation',async()=>{
  const messages=[],children=[],authCalls=[];let socket,claudeSignedIn=true;
  class FakeSocket extends EventEmitter{static OPEN=1;readyState=1;constructor(){super();socket=this;}send(text){messages.push(JSON.parse(text));}close(){this.emit('close');}}
  function spawn(exe,args,options){
    if(args[0]==='auth'){
      assert.match(exe,/[\\/]test[\\/]bin[\\/]claude[\\/]claude\.exe$/);
      assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;
      child.finish=(code,text='')=>{if(text)child.stdout.write(text);child.emit('exit',code);child.emit('close',code);};
      child.kill=()=>{child.killed++;child.finish(null);};authCalls.push({args:Array.from(args),child});
      if(args[1]==='status')queueMicrotask(()=>child.finish(0,JSON.stringify({loggedIn:claudeSignedIn,authMethod:claudeSignedIn?'claude.ai':'none'})));
      else queueMicrotask(()=>child.stdout.write('https://claude.ai/oauth/authorize?client_id=test&response_type=code&state=test\n'));
      return child;
    }
    assert.deepEqual(Array.from(args),['app-server','--listen','stdio://']);assert.equal(exe,desktop.executable);assert.equal(options.env.CODEX_HOME,desktop.authHome);
    const child=rpcChild(request=>({result:request.method==='account/rateLimits/read'?codexRaw:request.method==='account/read'?{account:{type:'chatgpt'}}:{}}));children.push(child);return child;
  }
  function execFile(){throw new Error('Only mocked app discovery is allowed');}
  execFile[promisify.custom]=async()=>({stdout:JSON.stringify([desktopPackage])});
  const hostProcess=new EventEmitter();hostProcess.argv=['node','test/bin/plugin.js','-port','1','-pluginUUID','plugin','-registerEvent','registerPlugin'];hostProcess.env={SystemRoot:'C:\\Windows',CODEX_HOME:'E:\\unrelated-host-profile'};hostProcess.platform='win32';
  const sandbox={Buffer,URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,process:hostProcess,console,fetch:()=>assert.fail('Quota clients must use their native runtime'),module:{exports:{}},require:name=>{
    if(name==='ws')return FakeSocket;
    if(name==='node:child_process')return {spawn,execFile};
    if(name==='node:fs')return {...require(name),existsSync:path=>[desktop.applicationPath,desktop.executable].includes(path)||/[\\/]test[\\/]bin[\\/]claude[\\/]claude\.exe$/.test(path)};
    if(name==='node:fs/promises')return {...require(name),readFile:()=>assert.fail('Quota clients must not open credential files')};
    return require(name);
  }};
  const compiled=await build({entryPoints:['src/plugin.js'],bundle:true,platform:'node',target:'node20',format:'cjs',external:['ws'],write:false});
  const context=vm.createContext(sandbox);
  const sdkModule=new vm.SyntheticModule(['query'],function(){
    this.setExport('query',({options})=>{
      assert.deepEqual(Array.from(options.settingSources),['user','project','local']);
      const owned={killed:0};children.push(owned);
      return {
        initializationResult:async()=>({account:{tokenSource:claudeSignedIn?'claude-login':'none'}}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>({rate_limits_available:true,rate_limits:claudeRaw}),
        close:()=>{owned.killed++;}
      };
    });
  },{context});
  await sdkModule.link(()=>{});await sdkModule.evaluate();
  vm.runInContext(compiled.outputFiles[0].text,context,{importModuleDynamically:async specifier=>{
    assert.match(specifier,/\/claude-sdk\/sdk\.mjs$/);return sdkModule;
  }});
  const event=(action,context,event,payload={})=>socket.emit('message',Buffer.from(JSON.stringify({action,context,event,payload})));
  try{
    socket.emit('open');event('de.ai-quota.quota','chat','willAppear',{settings:{transparentBackground:false}});event('de.ai-quota.claude','claude','willAppear',{settings:{}});await wait(60);
    event('de.ai-quota.quota','chat','sendToPlugin',{command:'state'});event('de.ai-quota.claude','claude','sendToPlugin',{command:'state'});
    const state=context=>messages.findLast(m=>m.event==='sendToPropertyInspector'&&m.context===context&&m.payload.data);
    assert(state('chat'),JSON.stringify(messages.filter(m=>m.event==='sendToPropertyInspector')));assert.equal(state('chat').payload.data.week.usedPercent,13);assert(state('claude'),JSON.stringify(messages.filter(m=>m.event==='sendToPropertyInspector')));assert.equal(state('claude').payload.data.week.usedPercent,41);
    assert.equal(state('chat').payload.settings.title,'chatGPT');assert.equal(state('claude').payload.settings.title,'Claude');assert.equal(children.length,2);assert(children.every(child=>child.killed===1));
    const updated={...state('claude').payload.settings,style:'frame',transparentBackground:true,titleOffsetX:9,settingsRevision:100};
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'settings',requestId:1,settings:updated});
    event('de.ai-quota.quota','chat','sendToPlugin',{command:'state'});
    assert.equal(state('chat').payload.settings.style,'number');assert.equal(state('chat').payload.settings.transparentBackground,false);
    assert(messages.some(m=>m.event==='setSettings'&&m.context==='claude'&&m.payload.style==='frame'));
    event('de.ai-quota.claude','claude','didReceiveSettings',{settings:{...updated,settingsRevision:1,transparentBackground:false}});
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'state'});assert.equal(state('claude').payload.settings.transparentBackground,true);
    assert.equal(authCalls.length,0,'appearing and refreshing must not start a login');
    claudeSignedIn=false;
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'login'});
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'login'});
    await wait(20);assert.equal(authCalls.length,1);assert.deepEqual(authCalls[0].args,['auth','login','--claudeai']);
    const pendingState=messages.findLast(m=>m.event==='sendToPropertyInspector'&&m.context==='claude').payload;
    assert.equal(pendingState.login.phase,'waiting');assert.equal(pendingState.data,null);
    const before=children.length;
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'refresh'});await wait(10);
    assert.equal(children.length,before,'polling must pause during login');
    claudeSignedIn=true;authCalls[0].child.finish(0);await wait(60);
    assert.deepEqual(authCalls.map(call=>call.args[1]),['login','status']);
    assert(messages.some(m=>m.event==='sendToPropertyInspector'&&m.context==='claude'&&m.payload.login?.phase==='complete'));
    assert.equal(state('claude').payload.data.week.usedPercent,41);
    assert.equal(state('claude').payload.settings.style,'frame');assert.equal(state('claude').payload.settings.transparentBackground,true);
    assert.equal(state('chat').payload.data.week.usedPercent,13);
    assert(!messages.filter(m=>m.event==='setSettings').some(m=>JSON.stringify(m).includes('oauth/authorize')));
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'login'});await wait(10);
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'cancelLogin'});await wait(20);
    assert.equal(authCalls.length,3);assert.equal(authCalls[2].child.killed,1);
    assert.equal(authCalls[0].child.killed,0);assert.equal(authCalls[1].child.killed,0);
    const cancelled=messages.findLast(m=>m.event==='sendToPropertyInspector'&&m.context==='claude').payload;
    assert.match(cancelled.status.error,/abgebrochen/);assert.equal(cancelled.login.url,null);
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'login'});
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'cancelLogin'});
    await wait(10);assert.equal(authCalls.length,3,'cancellation before the helper starts must be respected');
    event('de.ai-quota.claude','claude','sendToPlugin',{command:'login'});await wait(10);
    socket.close();await wait(10);
    assert.equal(authCalls.length,4);assert.equal(authCalls[3].child.killed,1,'shutdown stops the owned sign-in helper');
  }finally{socket.close();}
});

test('Claude and ChatGPT share all visual controls and strict inspector context registration',async()=>{
  const html=await readFile('de.ai-quota.sdPlugin/ui/settings.html','utf8');
  for(const action of ['de.ai-quota.quota','de.ai-quota.claude']){
    const messages=[];let socket;
    class Socket{static OPEN=1;readyState=1;constructor(){socket=this;}send(message){const m=JSON.parse(message);if(m.event!=='registerPropertyInspector')assert.equal(m.context,'inspector');messages.push(m);}}
    const dom=new JSDOM(html,{runScripts:'dangerously',beforeParse(window){window.WebSocket=Socket;}});const window=dom.window;
    try{
      window.connectElgatoStreamDeckSocket('1','inspector','registerPropertyInspector','{}',JSON.stringify({context:'key',action,payload:{settings:{}}}));socket.onopen();
      assert.equal(window.document.getElementById('title').value,action.endsWith('claude')?'Claude':'chatGPT');
      for(const style of ['dual','number','ring','fill','frame']){window.document.getElementById('style-'+style).click();await wait(150);assert.equal(messages.findLast(m=>m.payload?.command==='settings').payload.settings.style,style);}
      const checkbox=window.document.getElementById('transparentBackground');checkbox.parentElement.querySelector('span').click();assert.equal(checkbox.checked,true);checkbox.click();assert.equal(messages.findLast(m=>m.payload?.command==='settings').payload.settings.transparentBackground,false);
      assert.equal(window.document.getElementById('claudeAdvanced').hidden,!action.endsWith('claude'));
      assert.equal(window.document.getElementById('codexPath'),null);
      assert.equal(window.document.getElementById('login').hidden,false);
      assert.equal(window.document.getElementById('login').textContent,action.endsWith('claude')?'Mit Claude anmelden':'ChatGPT öffnen');
      if(!action.endsWith('claude'))assert.match(window.document.getElementById('accountNote').textContent,/vorhandene Anmeldung der ChatGPT-Desktop-App/);
      socket.onmessage({data:JSON.stringify({event:'sendToPropertyInspector',context:'key',payload:{data:normalizeClaudeQuota(claudeRaw),status:{},buckets:[]}})});
      assert.equal(window.document.getElementById('status').textContent,'Verbunden');
    }finally{dom.window.close();}
  }
});

test('Claude inspector handles login progress, safe browser fallback, failure, retry and reconnect',async()=>{
  const html=await readFile('de.ai-quota.sdPlugin/ui/settings.html','utf8'),messages=[];let socket;
  class Socket{static OPEN=1;readyState=1;constructor(){socket=this;}send(text){messages.push(JSON.parse(text));}}
  const dom=new JSDOM(html,{runScripts:'dangerously',beforeParse(window){window.WebSocket=Socket;}}),window=dom.window;
  const element=id=>window.document.getElementById(id);
  const deliver=payload=>socket.onmessage({data:JSON.stringify({event:'sendToPropertyInspector',context:'key',payload})});
  const url='https://claude.ai/oauth/authorize?client_id=test&response_type=code&state=test';
  try{
    window.connectElgatoStreamDeckSocket('1','inspector','registerPropertyInspector','{}',JSON.stringify({context:'key',action:'de.ai-quota.claude',payload:{settings:{}}}));socket.onopen();
    assert(!messages.some(m=>m.payload?.command==='login'));
    element('login').click();element('login').click();
    assert.equal(messages.filter(m=>m.payload?.command==='login').length,1);
    assert.equal(element('login').disabled,true);
    deliver({data:null,status:{error:'previous error'},login:{phase:'waiting',message:'Bitte im Browser bestätigen.',url}});
    assert.equal(element('status').textContent,'Bitte im Browser bestätigen.');
    assert.equal(element('refresh').disabled,true);assert.equal(element('loginActions').hidden,false);
    element('style-frame').click();assert.equal(element('login').disabled,true);
    element('loginLink').click();assert.deepEqual(messages.at(-1),{event:'openUrl',payload:{url}});
    element('cancelLogin').click();assert.equal(messages.at(-1).payload.command,'cancelLogin');assert.equal(messages.at(-1).context,'inspector');
    deliver({data:null,status:{error:'Claude-Anmeldung abgebrochen.'},login:{phase:'error',message:'Claude-Anmeldung abgebrochen.',url:null}});
    assert.equal(element('login').disabled,false);assert.equal(element('loginActions').hidden,true);assert.equal(element('loginLink').hidden,true);
    element('login').click();assert.equal(messages.filter(m=>m.payload?.command==='login').length,2);
    deliver({data:null,status:{},login:{phase:'waiting',url:'https://untrusted.invalid/oauth/authorize'}});
    assert.equal(element('loginLink').hidden,true);
    deliver({data:null,status:{error:'Kein Abo-Kontingent verfügbar.'},login:{phase:'complete',message:'Claude-Konto verbunden.'}});
    assert.equal(element('status').textContent,'Claude-Konto verbunden. Kein Abo-Kontingent verfügbar.');
    deliver({data:normalizeClaudeQuota(claudeRaw),status:{},login:null});
    assert.equal(element('status').textContent,'Verbunden');
    assert(!messages.filter(m=>m.event==='setSettings').some(m=>JSON.stringify(m).includes('oauth/authorize')));
    socket.onclose();assert.equal(element('login').disabled,true);assert.match(element('status').textContent,/beendet/);
  }finally{dom.window.close();}
});

test('identical settings produce the same five layouts for either normalized provider',()=>{
  const data=normalizeClaudeQuota(claudeRaw);
  for(const style of ['dual','number','ring','fill','frame'])for(const transparentBackground of [false,true]){
    const settings=normalizeSettings({style,transparentBackground,title:'Quota',ringScale:70,titleOffsetX:7,titleOffsetY:-2});
    const svg=renderKey(settings,data);assert.equal(new Resvg(svg).render().width,144);assert(svg.includes('Quota'));
  }
});
