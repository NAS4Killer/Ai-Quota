import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

// T3 Code: ClaudeProvider.ts, Drivers/ClaudeExecutable.ts and ClaudeHome.ts
// at ec80933ac8cd02fec5c97b342462ccc9567cdb1e.
const sdkPackage='@anthropic-ai/claude-agent-sdk';
const wrappers=new Set(['.cmd','.bat','.ps1']);
const failure=()=>new Error('Claude-Verbindungsanfrage fehlgeschlagen.');

export function resolveClaudeExecutable(executable,bundledExecutable,exists=existsSync,env=process.env,home=homedir()) {
  const requested=String(executable||'claude').trim().replace(/^~(?=$|[\\/])/,home);
  const path=Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
  const nativeName=process.platform==='win32'?'claude.exe':'claude';
  const bare=!/[\\/]/.test(requested);
  let resolved=requested;
  if(bare){
    const names=/^claude(?:\.exe)?$/i.test(requested)?[nativeName,...(process.platform==='win32'?['claude.cmd','claude.bat','claude.ps1']:[])]:[requested];
    search:for(const directory of path.split(delimiter)){
      const clean=directory.trim().replace(/^"(.*)"$/,'$1');
      if(!clean)continue;
      for(const name of names){const candidate=join(clean,name);if(exists(candidate)){resolved=candidate;break search;}}
    }
  }
  if(wrappers.has(extname(resolved).toLowerCase())){
    // Follow the npm launcher's known package entry, as T3 does. No shell.
    for(const entry of [['bin','claude.exe'],['cli.js']]){
      const candidate=join(dirname(resolved),'node_modules','@anthropic-ai','claude-code',...entry);
      if(exists(candidate))return candidate;
    }
    throw new Error('Claude-Starter gefunden, aber der zugehörige Programmeinstieg fehlt.');
  }
  if(resolved!==requested||!/^claude(?:\.exe)?$/i.test(requested))return resolved;
  const native=join(home,'.local','bin',nativeName);
  if(exists(native))return native;
  if(bundledExecutable&&exists(bundledExecutable))return bundledExecutable;
  return requested;
}

export function claudeAuthentication(account) {
  // This is T3's initialization-account check. A completed handshake alone
  // must not turn an explicit tokenSource:none into a successful sign-in.
  if(!account)return 'unknown';
  if(account.apiProvider&&account.apiProvider!=='firstParty')return 'authenticated';
  if(account.tokenSource!=='none')return 'authenticated';
  return (account.apiKeySource&&account.apiKeySource!=='none')||account.email||account.subscriptionType?'authenticated':'unauthenticated';
}

function untilAbort(signal){
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolveWait=>signal.addEventListener('abort',resolveWait,{once:true}));
}

export class ClaudeConnection {
  constructor(executable='claude',{bundledExecutable=null,sdkPath=null,configDir='',env=process.env,home=homedir(),cwd=home,exists=existsSync,timeoutMs=25000,loginTimeoutMs=600000,spawnProcess=spawn,loadSdk=null}={}) {
    Object.assign(this,{executable,bundledExecutable,configDir,env,home,cwd,exists,timeoutMs,loginTimeoutMs,spawnProcess});
    this.loadSdk=loadSdk??(()=>import(sdkPath?pathToFileURL(sdkPath).href:sdkPackage));
    this.active=new Set();
    this.loginAttempt=null;
  }
  environment(){
    const environment={...this.env};
    const configDir=String(this.configDir||'').trim();
    if(configDir)environment.CLAUDE_CONFIG_DIR=resolve(configDir.replace(/^~(?=$|[\\/])/,this.home));
    return environment;
  }
  authCommand(args,{signal,timeoutMs=this.timeoutMs,capture=false,onOutput=()=>{}}={}){
    return new Promise((done,reject)=>{
      let child,timer,output='',settled=false,exited=false;
      const finish=(error,result)=>{
        if(settled)return;
        settled=true;clearTimeout(timer);this.active.delete(state);
        signal?.removeEventListener('abort',abort);
        // Only the exact helper owned by this request is ever stopped.
        if(error&&!exited){try{child?.kill();}catch{}}
        if(error)reject(error);else done(result);
      };
      const state={close:(error=new Error('Claude-Anmeldung abgebrochen.'))=>finish(error)};
      const abort=()=>state.close();
      if(signal?.aborted){reject(new Error('Claude-Anmeldung abgebrochen.'));return;}
      this.active.add(state);signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>state.close(new Error('Claude hat die Anmeldung nicht rechtzeitig bestätigt. Bitte erneut anmelden.')),timeoutMs);
      try{
        const executable=resolveClaudeExecutable(this.executable,this.bundledExecutable,this.exists,this.env,this.home);
        const javascript=/\.[cm]?js$/i.test(executable);
        child=this.spawnProcess(javascript?process.execPath:executable,javascript?[executable,...args]:args,{
          cwd:this.cwd,env:this.environment(),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']
        });
        child.once('error',()=>finish(new Error('Claude konnte für die Anmeldung nicht gestartet werden. Programmeinstellung prüfen.')));
        child.once('exit',()=>{exited=true;});
        child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
        child.stdout.on('data',text=>{
          if(settled)return;
          if(capture){
            output+=text;
            if(output.length>65536){state.close(new Error('Claude lieferte einen ungültigen Anmeldestatus.'));return;}
          }
          onOutput(text);
        });
        child.stderr.on('data',text=>{if(!settled)onOutput(text);});
        child.once('close',code=>{exited=true;finish(null,{code,output});});
      }catch{finish(new Error('Claude konnte für die Anmeldung nicht gestartet werden. Programmeinstellung prüfen.'));}
    });
  }
  login(onUpdate=()=>{}){
    if(this.loginAttempt)return this.loginAttempt.promise;
    const controller=new AbortController(),attempt={controller,promise:null};
    this.loginAttempt=attempt;
    attempt.promise=(async()=>{
      let buffer='',loginUrl=null;
      onUpdate({phase:'waiting',message:'Bitte die Claude-Anmeldung im Browser bestätigen.',url:null});
      const result=await this.authCommand(['auth','login','--claudeai'],{
        signal:controller.signal,timeoutMs:this.loginTimeoutMs,
        onOutput:text=>{
          buffer=stripVTControlCharacters(buffer+text).slice(-16384);
          // Only expose a complete official authorization URL, never CLI output.
          for(const match of buffer.matchAll(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s<>"']+(?=[\s<>"'])/g)){
            try{
              const url=new URL(match[0]);
              if(url.hostname!=='claude.ai'||url.username||url.password||url.port||
                !url.searchParams.has('client_id')||!url.searchParams.has('state')||
                url.searchParams.get('response_type')!=='code'||url.href===loginUrl)continue;
              loginUrl=url.href;
              onUpdate({phase:'waiting',message:'Bitte die Claude-Anmeldung im Browser bestätigen.',url:loginUrl});
            }catch{}
          }
        }
      });
      if(result.code!==0)throw new Error('Claude-Anmeldung nicht abgeschlossen. Bitte erneut versuchen.');
      if(controller.signal.aborted)throw new Error('Claude-Anmeldung abgebrochen.');
      onUpdate({phase:'checking',message:'Claude-Anmeldung wird geprüft.',url:null});
      const status=await this.authCommand(['auth','status'],{signal:controller.signal,capture:true});
      let account;try{account=JSON.parse(status.output);}catch{}
      if(status.code!==0||account?.loggedIn!==true)throw new Error('Claude hat keine erfolgreiche Anmeldung bestätigt. Bitte erneut anmelden.');
      if(account.authMethod!=='claude.ai')throw new Error('Ein anderer Claude-Zugang ist aktiv. Programmeinstellung und Konfigurationsordner prüfen.');
      onUpdate({phase:'complete',message:'Claude-Konto verbunden.',url:null});
      return {connected:true,authentication:'authenticated'};
    })().catch(error=>{
      onUpdate({phase:'error',message:error.message,url:null});
      throw error;
    }).finally(()=>{if(this.loginAttempt===attempt)this.loginAttempt=null;});
    return attempt.promise;
  }
  cancelLogin(){
    this.loginAttempt?.controller.abort();
  }
  async run(callback){
    const abortController=new AbortController();
    const state={query:null,closed:false,error:null,cancel:null};
    const cancelled=new Promise((_,reject)=>{state.cancel=reject;});
    // A cancellation can happen while the SDK module is still loading.
    cancelled.catch(()=>{});
    state.close=(error=new Error('Claude-Verbindung beendet.'))=>{
      if(state.closed)return;
      state.closed=true;state.error=error;state.cancel(error);
      abortController.abort();
      try{state.query?.close();}catch{}
      this.active.delete(state);
    };
    this.active.add(state);
    let timer=setTimeout(()=>state.close(new Error('Claude-Verbindung hat nicht rechtzeitig geantwortet.')),this.timeoutMs);
    try{
      const executable=resolveClaudeExecutable(this.executable,this.bundledExecutable,this.exists,this.env,this.home);
      const sdk=await Promise.race([this.loadSdk(),cancelled]);
      if(state.closed)throw state.error;
      const environment=this.environment();
      state.query=sdk.query({
        prompt:(async function*(){await untilAbort(abortController.signal);})(),
        options:{
          persistSession:false,pathToClaudeCodeExecutable:executable,abortController,
          settingSources:['user','project','local'],settings:{disableAllHooks:true},
          allowedTools:[],mcpServers:{},strictMcpConfig:true,
          env:{...environment,ENABLE_CLAUDEAI_MCP_SERVERS:'false',FORCE_CODE_TERMINAL:undefined,
            CLAUDE_CODE_AUTO_CONNECT_IDE:'0',CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL:'1'},
          cwd:this.cwd,stderr:()=>{}
        }
      });
      const initialized=await Promise.race([state.query.initializationResult(),cancelled]);
      clearTimeout(timer);
      timer=setTimeout(()=>state.close(new Error('Claude-Verbindung hat nicht rechtzeitig geantwortet.')),this.timeoutMs);
      return await Promise.race([Promise.resolve().then(()=>callback(state.query,initialized)),cancelled]);
    }catch(error){
      if(state.error)throw state.error;
      // Do not relay SDK diagnostics containing account or environment data.
      if(error?.aiQuotaPublic===true)throw error;
      throw failure();
    }finally{clearTimeout(timer);state.close();}
  }
  check(){
    return this.run((_query,initialized)=>({connected:true,authentication:claudeAuthentication(initialized?.account)}));
  }
  stop(){this.cancelLogin();for(const state of [...this.active])state.close();}
}
