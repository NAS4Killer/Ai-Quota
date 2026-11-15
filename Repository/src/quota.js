import { spawn, execFile } from 'node:child_process';
import { PLUGIN_VERSION } from './version.js';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

// The Windows app is displayed as ChatGPT; its registered package name is
// OpenAI.Codex. Query Windows, so app updates and other install drives work.
const DESKTOP_DISCOVERY=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$quotaProfile=[Environment]::GetFolderPath('UserProfile')
$quotaHome=[Environment]::GetEnvironmentVariable('CODEX_HOME','User')
if([string]::IsNullOrWhiteSpace($quotaHome)){$quotaHome=[Environment]::GetEnvironmentVariable('CODEX_HOME','Machine')}
if([string]::IsNullOrWhiteSpace($quotaHome)){$quotaHome=Join-Path $quotaProfile '.codex'}
$quotaApps=@(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | ForEach-Object {
  $quotaPackage=$_
  $quotaManifest=$quotaPackage | Get-AppxPackageManifest
  foreach($quotaApp in $quotaManifest.Package.Applications.Application){
    if($quotaApp.Id -eq 'App'){
      [pscustomobject]@{installLocation=$quotaPackage.InstallLocation;application=$quotaApp.Executable;applicationId=($quotaPackage.PackageFamilyName+'!'+$quotaApp.Id);authHome=$quotaHome;userProfile=$quotaProfile}
    }
  }
})
ConvertTo-Json -InputObject $quotaApps -Compress
`;

export async function discoverChatGptDesktop({run=promisify(execFile),exists=existsSync,env=process.env,platform=process.platform}={}) {
  if(platform!=='win32')throw new Error('Die ChatGPT-Desktop-Anbindung benötigt Windows.');
  const systemRoot=env.SystemRoot||env.SYSTEMROOT;
  if(!systemRoot||!win32.isAbsolute(systemRoot))throw new Error('Windows-Programmverzeichnis nicht verfügbar.');
  let applications;
  try{
    const {stdout}=await run(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(DESKTOP_DISCOVERY,'utf16le').toString('base64')],{windowsHide:true,shell:false,timeout:15000,maxBuffer:65536,encoding:'utf8'});
    applications=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
  }catch{throw new Error('Die installierte ChatGPT-Desktop-App konnte nicht ermittelt werden.');}
  for(const app of Array.isArray(applications)?applications:[]){
    if(!app||![app.installLocation,app.authHome,app.userProfile].every(value=>typeof value==='string'&&win32.isAbsolute(value)))continue;
    if(typeof app.application!=='string'||win32.isAbsolute(app.application)||!/^OpenAI\.Codex_[a-z0-9]+!App$/i.test(app.applicationId??''))continue;
    const applicationPath=win32.resolve(app.installLocation,app.application);
    const relative=win32.relative(app.installLocation,applicationPath);
    if(!relative||relative.startsWith('..')||win32.isAbsolute(relative)||!/^ChatGPT\.exe$/i.test(win32.basename(applicationPath)))continue;
    const executable=win32.join(win32.dirname(applicationPath),'resources','codex.exe');
    if(exists(applicationPath)&&exists(executable))return {...app,applicationPath,executable};
  }
  throw new Error('ChatGPT-Desktop-App nicht gefunden. Bitte ChatGPT für Windows installieren und dort anmelden.');
}

function normalizeWindow(raw) {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null;
  const mins = raw.windowDurationMins;
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return null;
  return {usedPercent:Math.max(0,Math.min(100,raw.usedPercent)),windowDurationMins:mins,resetsAt:typeof raw.resetsAt==='number'&&Number.isFinite(raw.resetsAt)?raw.resetsAt:null,label:mins===300?'5 h':mins===10080?'Woche':mins%1440===0?`${mins/1440} d`:mins%60===0?`${mins/60} h`:`${mins} min`};
}
export function normalizeQuota(result, bucket = 'codex') {
  // Never silently substitute a different metered bucket.
  const byId = result?.rateLimitsByLimitId;
  const raw = byId?.[bucket] ?? (result?.rateLimits && (result.rateLimits.limitId || 'codex') === bucket ? result.rateLimits : null);
  if (!raw) throw new Error(`Kontingent „${bucket}“ nicht verfügbar.`);
  const primary=normalizeWindow(raw.primary),secondary=normalizeWindow(raw.secondary);
  const windows=[primary,secondary].filter(Boolean);
  return {fiveHour:windows.find(w=>w.windowDurationMins===300)??null,week:windows.find(w=>w.windowDurationMins===10080)??null,windows,bucket,planType:raw.planType??null,fetchedAt:Date.now()};
}
export function mergeQuotaUpdate(previous, update) {
  if (!previous) return update;
  const merged={...previous,...update,rateLimitsByLimitId:{...previous.rateLimitsByLimitId}};
  for(const [id,raw] of Object.entries(update?.rateLimitsByLimitId??{}))merged.rateLimitsByLimitId[id]={...merged.rateLimitsByLimitId[id],...raw};
  if(update?.rateLimits){
    const id=update.rateLimits.limitId||'codex';
    merged.rateLimitsByLimitId[id]={...(previous.rateLimits?.limitId===id?previous.rateLimits:{}),...merged.rateLimitsByLimitId[id],...update.rateLimits};
    merged.rateLimits=merged.rateLimitsByLimitId[id];
  }
  return merged;
}
export class ChatGptDesktopQuotaClient extends EventEmitter {
  constructor({spawnProcess=spawn,timeoutMs=20000,discover=discoverChatGptDesktop,env=process.env}={}) {
    super(); this.spawnProcess=spawnProcess; this.timeoutMs=timeoutMs;this.discover=discover;this.env=env;
    this.pending=new Map(); this.nextId=1; this.child=null; this.starting=null; this.reading=null; this.closing=false;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting=this.boot();
    try {await this.starting;} finally {this.starting=null;}
  }
  async boot() {
    const desktop=await this.discover();
    // Use the installed app's own runtime and Windows login location. Do not
    // inherit a host-specific CODEX_HOME or look for another CLI installation.
    const child=this.spawnProcess(desktop.executable,['app-server','--listen','stdio://'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,cwd:desktop.userProfile,env:{...this.env,CODEX_HOME:desktop.authHome}});
    this.child=child; this.closing=false;
    const lines=createInterface({input:child.stdout});
    child.stdin.on('error',()=>{});
    // Drain stderr without forwarding potential account details to plugin logs.
    child.stderr.on('data',()=>{});
    lines.on('line',line=>{
      let message;try {message=JSON.parse(line);} catch {return;}
      if (message.id != null && this.pending.has(message.id)) {
        const p=this.pending.get(message.id);this.pending.delete(message.id);clearTimeout(p.timer);
        if (message.error) p.reject(new Error(`ChatGPT-Kontingentabfrage fehlgeschlagen (${message.error.code ?? 'RPC'}). Anmeldung in der Desktop-App prüfen.`));
        else p.resolve(message.result);
      } else if (message.method==='account/rateLimits/updated') this.emit('limits',message.params);
      else if (message.id != null && message.method) {
        child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Unsupported client request'}})+'\n');
      }
    });
    const failed=(error)=>{
      if (this.child!==child) return;
      this.child=null;lines.close();
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
      if(!this.closing)this.emit('unavailable',error.message);
    };
    child.on('error',()=>failed(new Error('Der Kontingentdienst der ChatGPT-Desktop-App konnte nicht gestartet werden.')));
    child.on('exit',()=>failed(new Error('Der Kontingentdienst der ChatGPT-Desktop-App wurde beendet.')));
    try {
      await this.request('initialize',{clientInfo:{name:'ai_quota_streamdeck',title:'Ai-Quota',version:PLUGIN_VERSION},capabilities:{experimentalApi:true}});
      child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    } catch(error) {this.stop();throw error;}
  }
  request(method,params) {
    return new Promise((resolve,reject)=>{
      if(!this.child?.stdin?.writable)return reject(new Error('ChatGPT-Desktop-Verbindung fehlt.'));
      const id=this.nextId++;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Zeitüberschreitung beim Kontingent-Abruf.'));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n',error=>{
        if(error&&this.pending.has(id)){clearTimeout(timer);this.pending.delete(id);reject(new Error('ChatGPT-Desktop-Verbindung unterbrochen.'));}
      });
    });
  }
  read() {
    if(this.reading)return this.reading;
    this.reading=this.readOnce().finally(()=>{this.reading=null;});
    return this.reading;
  }
  async connect() {
    try{
      await this.start();
      const result=await this.request('account/read',{});
      return {connected:true,authentication:result?.account?'authenticated':result?.requiresOpenaiAuth?'unauthenticated':'unknown',accountType:result?.account?.type??null};
    }finally{this.stop();}
  }
  async readOnce() {
    try{
      await this.start();
      const {account}=await this.request('account/read',{refreshToken:false});
      if(!account)throw new Error('ChatGPT-Anmeldung fehlt. Bitte in der ChatGPT-Desktop-App anmelden und aktualisieren.');
      if(account.type!=='chatgpt')throw new Error('Für das Abo-Kontingent bitte in der ChatGPT-Desktop-App mit deinem ChatGPT-Konto anmelden.');
      return await this.request('account/rateLimits/read');
    }finally{
      // A fresh app service for every poll follows account switches in Desktop.
      // Only our own child is stopped; no other application is addressed.
      this.stop();
    }
  }
  async openDesktop() {
    const desktop=await this.discover();
    const systemRoot=this.env.SystemRoot||this.env.SYSTEMROOT;
    if(!systemRoot)throw new Error('Windows-Programmverzeichnis nicht verfügbar.');
    await new Promise((resolve,reject)=>{
      const child=this.spawnProcess(win32.join(systemRoot,'explorer.exe'),['shell:AppsFolder\\'+desktop.applicationId],{stdio:'ignore',windowsHide:true,shell:false});
      child.once('error',()=>reject(new Error('ChatGPT-Desktop-App konnte nicht geöffnet werden.')));
      child.once('spawn',()=>{child.unref();resolve();});
    });
  }
  stop() {
    this.closing=true;
    const child=this.child;this.child=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Verbindung beendet.'));}this.pending.clear();
    if(child){child.stdin.end();child.kill();}
  }
}
