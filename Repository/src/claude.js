import { EventEmitter } from 'node:events';
import { ClaudeConnection, claudeAuthentication } from './claude-connection.js';
export { resolveClaudeExecutable } from './claude-connection.js';

const missingLogin='Claude-Anmeldung fehlt. Unter „Claude-Konto“ auf „Mit Claude anmelden“ klicken.';
const publicError=message=>Object.assign(new Error(message),{aiQuotaPublic:true});

export function normalizeClaudeQuota(raw) {
  const limits=raw?.rate_limits??raw;
  // Desktop's limits[] supersedes the legacy fields when it is present.
  // Scoped model limits must never replace the account-wide weekly window.
  const current=Array.isArray(limits?.limits)?limits.limits:null;
  const window=(legacy,kind,minutes,label)=>{
    const item=current?current.find(entry=>entry?.kind===kind):legacy;
    const percent=current?item?.percent:item?.utilization;
    if(typeof percent!=='number' || !Number.isFinite(percent))return null;
    const reset=typeof item.resets_at==='number'?item.resets_at:
      typeof item.resets_at==='string'?Date.parse(item.resets_at)/1000:NaN;
    return {usedPercent:Math.max(0,Math.min(100,percent)),windowDurationMins:minutes,resetsAt:Number.isFinite(reset)&&reset>0?reset:null,label};
  };
  const fiveHour=window(limits?.five_hour,'session',300,'5 h'),week=window(limits?.seven_day,'weekly_all',10080,'Woche');
  if(!fiveHour&&!week)throw new Error('Claude liefert derzeit kein 5-Stunden- oder Wochenkontingent.');
  return {fiveHour,week,windows:[fiveHour,week].filter(Boolean),bucket:'claude',planType:null,fetchedAt:Date.now()};
}

// The connection is created by the same official Agent SDK used by T3 Code.
export class ClaudeQuotaClient extends EventEmitter {
  constructor(executable='claude',options={}) {
    super();this.transport=new ClaudeConnection(executable,options);
    this.reading=null;this.connecting=null;
  }
  connect() {
    if(this.connecting)return this.connecting;
    this.connecting=this.transport.check().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  login(){return this.transport.login(state=>this.emit('login',state));}
  cancelLogin(){this.transport.cancelLogin();}
  read() {
    if(this.reading)return this.reading;
    this.reading=this.readOnce().finally(()=>{this.reading=null;});
    return this.reading;
  }
  readOnce() {
    return this.transport.run(async(query,initialized)=>{
      if(claudeAuthentication(initialized?.account)==='unauthenticated')throw publicError(missingLogin);
      const usage=await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true});
      if(!usage?.rate_limits_available)throw publicError('Der vorhandene Claude-Zugang stellt kein Abo-Kontingent bereit.');
      try{normalizeClaudeQuota(usage);}catch(error){throw publicError(error.message);}
      return usage.rate_limits;
    });
  }
  stop(){this.transport.stop();}
}
