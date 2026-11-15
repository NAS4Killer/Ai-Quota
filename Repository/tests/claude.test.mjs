import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, delimiter } from 'node:path';
import { ClaudeQuotaClient, normalizeClaudeQuota, resolveClaudeExecutable } from '../src/claude.js';
import { ClaudeConnection, claudeAuthentication } from '../src/claude-connection.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const raw={five_hour:{utilization:12.5,resets_at:'2026-10-14T12:00:00Z'},seven_day:{utilization:37,resets_at:'2026-10-20T12:00:00Z'}};
const home=resolve('test-profile'),exe=resolve('test-runtime','claude.exe');
function mockSdk({account={tokenSource:'claude-login',apiProvider:'firstParty'},initialization,usage}={}) {
  const sessions=[];
  const loadSdk=async()=>({query:input=>{
    const state={input,closed:0,initCalls:0,usageCalls:0};sessions.push(state);
    return {
      initializationResult:async()=>{state.initCalls++;return initialization?initialization():{account};},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async options=>{state.usageCalls++;assert.deepEqual(options,{skipBehaviors:true});return usage?usage():{rate_limits_available:true,rate_limits:raw};},
      close:()=>{state.closed++;}
    };
  }});
  return {loadSdk,sessions};
}
function makeClient(sdkOptions={},connectionOptions={}) {
  const sdk=mockSdk(sdkOptions);
  return {...sdk,client:new ClaudeQuotaClient(exe,{env:{},home,timeoutMs:200,loadSdk:sdk.loadSdk,...connectionOptions})};
}

test('Claude normalizes native SDK windows, zero values and reset times without substituting missing limits',()=>{
  const data=normalizeClaudeQuota({rate_limits:raw});
  assert.equal(data.fiveHour.usedPercent,12.5);assert.equal(data.week.usedPercent,37);
  assert.equal(data.fiveHour.resetsAt,Date.parse(raw.five_hour.resets_at)/1000);
  assert.equal(normalizeClaudeQuota({seven_day:raw.seven_day}).fiveHour,null);
  assert.equal(normalizeClaudeQuota({five_hour:{utilization:0,resets_at:null}}).fiveHour.usedPercent,0);
  assert.equal(normalizeClaudeQuota({five_hour:{utilization:130,resets_at:'bad'}}).fiveHour.usedPercent,100);
  assert.throws(()=>normalizeClaudeQuota({five_hour:{utilization:'12'}}),/kein/);
});

test('Claude maps current Desktop limits by kind and preserves zero usage and resets',()=>{
  const data=normalizeClaudeQuota({limits:[
    {kind:'weekly_model',group:'weekly',percent:91,scope:{model:{display_name:'Model'}}},
    {kind:'weekly_all',group:'weekly',percent:37,resets_at:raw.seven_day.resets_at},
    {kind:'session',group:'session',percent:0,resets_at:raw.five_hour.resets_at}
  ]});
  assert.equal(data.fiveHour.usedPercent,0);
  assert.equal(data.fiveHour.windowDurationMins,300);
  assert.equal(data.week.usedPercent,37);
  assert.equal(data.week.windowDurationMins,10080);
  assert.equal(data.week.resetsAt,Date.parse(raw.seven_day.resets_at)/1000);
  assert.equal(data.windows.length,2);
});

test('current Claude limits supersede legacy values without inventing missing account windows',()=>{
  assert.throws(()=>normalizeClaudeQuota({...raw,limits:[]}),/kein/);
  assert.throws(()=>normalizeClaudeQuota({limits:[{kind:'weekly_model',group:'weekly',percent:25}]}),/kein/);
  assert.throws(()=>normalizeClaudeQuota({limits:[{kind:'session',percent:'42'}]}),/kein/);
  assert.throws(()=>normalizeClaudeQuota({limits:[{kind:'session',percent:NaN}]}),/kein/);
  const data=normalizeClaudeQuota({...raw,limits:[null,{kind:'session',percent:110,resets_at:0}]});
  assert.equal(data.fiveHour.usedPercent,100);assert.equal(data.fiveHour.resetsAt,null);
  assert.equal(data.week,null);
  assert.equal(normalizeClaudeQuota({limits:[{kind:'session',percent:-5,resets_at:'invalid'}]}).fiveHour.usedPercent,0);
});

test('connection check uses T3 SDK initialization without a prompt or a usage request',async()=>{
  const {client,sessions}=makeClient();
  const first=client.connect();assert.equal(first,client.connect());
  assert.deepEqual(await first,{connected:true,authentication:'authenticated'});
  assert.equal(sessions.length,1);const state=sessions[0],options=state.input.options;
  assert.equal(state.initCalls,1);assert.equal(state.usageCalls,0);assert.equal(state.closed,1);
  assert.equal(options.pathToClaudeCodeExecutable,exe);assert.equal(options.cwd,home);
  assert.equal(options.persistSession,false);assert.deepEqual(options.settingSources,['user','project','local']);
  assert.deepEqual(options.settings,{disableAllHooks:true});assert.deepEqual(options.allowedTools,[]);
  assert.deepEqual(options.mcpServers,{});assert.equal(options.strictMcpConfig,true);
  assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS,'false');assert.equal(options.env.FORCE_CODE_TERMINAL,undefined);
  assert.equal(options.abortController.signal.aborted,true);
  assert.deepEqual(await state.input.prompt.next(),{value:undefined,done:true});
});

test('T3 initialization distinguishes an open connection from a missing sign-in',async()=>{
  for(const [account,authentication] of [
    [{tokenSource:'none'},'unauthenticated'],
    [{tokenSource:'none',apiKeySource:'none'},'unauthenticated'],
    [{tokenSource:'none',apiKeySource:'environment'},'authenticated'],
    [{tokenSource:'none',subscriptionType:'pro'},'authenticated'],
    [{apiProvider:'bedrock'},'authenticated'],
    [undefined,'unknown']
  ]){
    assert.equal(claudeAuthentication(account),authentication);
    const {client,sessions}=makeClient({initialization:async()=>({account})});
    assert.deepEqual(await client.connect(),{connected:true,authentication});
    assert.equal(sessions[0].usageCalls,0);
  }
});

test('T3 environment preserves the existing profile and forwards an explicit configuration directory',async()=>{
  const env={HOME:home,CLAUDE_CONFIG_DIR:resolve('existing-account'),CLAUDE_CODE_OAUTH_TOKEN:'fixture-token'};
  for(const configDir of ['',join('~','another-account')]){
    const {client,sessions}=makeClient({}, {env,configDir});await client.connect();
    const actual=sessions[0].input.options.env;
    assert.equal(actual.HOME,home);assert.equal(actual.CLAUDE_CODE_OAUTH_TOKEN,'fixture-token');
    assert.equal(actual.CLAUDE_CONFIG_DIR,configDir?join(home,'another-account'):env.CLAUDE_CONFIG_DIR);
    assert.equal(env.CLAUDE_CONFIG_DIR,resolve('existing-account'));
  }
});

test('connection timeouts and cancellation abort only the owned SDK session',async()=>{
  const {client,sessions}=makeClient({initialization:()=>new Promise(()=>{})},{timeoutMs:20});
  await assert.rejects(client.connect(),/nicht rechtzeitig/);
  assert.equal(sessions[0].closed,1);assert.equal(sessions[0].input.options.abortController.signal.aborted,true);
  const cancelled=makeClient({initialization:()=>new Promise(()=>{})});
  const pending=cancelled.client.connect();await new Promise(resolveWait=>setImmediate(resolveWait));cancelled.client.stop();
  await assert.rejects(pending,/beendet/);assert.equal(cancelled.sessions[0].closed,1);
});

test('stopping during SDK loading cannot start a late process',async()=>{
  let resolveSdk,starts=0;
  const connection=new ClaudeConnection(exe,{env:{},home,loadSdk:()=>new Promise(done=>{resolveSdk=done;})});
  const pending=connection.check();connection.stop();
  await assert.rejects(pending,/beendet/);
  resolveSdk({query:()=>{starts++;}});await new Promise(done=>setImmediate(done));
  assert.equal(starts,0);assert.equal(connection.active.size,0);
});

test('SDK failures are sanitized and release the connection',async()=>{
  const {client,sessions}=makeClient({initialization:()=>Promise.reject(new Error('private credential diagnostic'))});
  await assert.rejects(client.connect(),error=>error.message==='Claude-Verbindungsanfrage fehlgeschlagen.');
  assert.equal(sessions[0].closed,1);assert.equal(client.transport.active.size,0);
});

test('program resolution follows PATH and T3 npm launcher resolution without a shell',()=>{
  const name=process.platform==='win32'?'claude.exe':'claude';
  const installed=join(resolve('other-drive','Claude'),name),bundled=join(resolve('plugin-moved','bin','claude'),name);
  const env={Path:[resolve('irrelevant'),resolve('other-drive','Claude')].join(delimiter)};
  assert.equal(resolveClaudeExecutable('claude',bundled,path=>[installed,bundled].includes(path),env,home),installed);
  assert.equal(resolveClaudeExecutable('claude',bundled,path=>path===bundled,{},home),bundled);
  assert.equal(resolveClaudeExecutable(join('~','custom','claude.exe'),null,()=>true,{},home),join(home,'custom','claude.exe'));
  for(const wrapper of ['claude.cmd','claude.bat','claude.ps1']){
    const shim=join(resolve('relocated-npm'),wrapper);
    for(const entry of [join('bin','claude.exe'),'cli.js']){
      const target=join(resolve('relocated-npm'),'node_modules','@anthropic-ai','claude-code',entry);
      assert.equal(resolveClaudeExecutable(shim,bundled,path=>path===target,{},home),target);
    }
    assert.throws(()=>resolveClaudeExecutable(shim,bundled,()=>false,{},home),/Programmeinstieg fehlt/);
  }
});

test('a completed poll uses its SDK session and reloads the account on the next call',async()=>{
  let used=37;
  const {client,sessions}=makeClient({usage:()=>({rate_limits_available:true,rate_limits:{seven_day:{...raw.seven_day,utilization:used}}})});
  const first=client.read();assert.equal(first,client.read());assert.equal((await first).seven_day.utilization,37);
  used=65;assert.equal((await client.read()).seven_day.utilization,65);
  assert.deepEqual(sessions.map(s=>s.closed),[1,1]);assert.equal(client.transport.active.size,0);
});

test('an unauthenticated initialization stops before any further provider request',async()=>{
  const {client,sessions}=makeClient({account:{tokenSource:'none',apiKeySource:'none'}});
  await assert.rejects(client.read(),/Mit Claude anmelden/);
  assert.equal(sessions[0].usageCalls,0);assert.equal(sessions[0].closed,1);
});

test('unavailable and malformed SDK responses retain the existing error behavior',async()=>{
  const unavailable=makeClient({usage:()=>({rate_limits_available:false,rate_limits:null})});
  await assert.rejects(unavailable.client.read(),/kein Abo-Kontingent/);
  const malformed=makeClient({usage:()=>({rate_limits_available:true,rate_limits:{seven_day:{utilization:null}}})});
  await assert.rejects(malformed.client.read(),/kein 5-Stunden-/);
});

function authChild(){
  const child=new EventEmitter();
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;
  child.finish=(code,output='')=>{
    if(output)child.stdout.write(output);
    child.emit('exit',code);child.emit('close',code);
  };
  child.kill=()=>{child.killed++;child.finish(null);};
  return child;
}
const authorizationUrl='https://claude.ai/oauth/authorize?client_id=test-client&response_type=code&state=test-state&code_challenge=test-challenge';
const signedIn=JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private-test@example.invalid'});

test('login waits for CLI confirmation, shares the configured account location, and exposes only the authorization URL',async()=>{
  const calls=[],updates=[];
  const inherited=resolve('existing-account'),config=join(home,'selected-account');
  const connection=new ClaudeConnection('claude',{bundledExecutable:exe,exists:path=>path===exe,env:{CLAUDE_CONFIG_DIR:inherited},home,configDir:'~/selected-account',spawnProcess:(program,args,options)=>{
    const child=authChild();calls.push({program,args,options,child});
    if(args[1]==='login')queueMicrotask(()=>{
      child.stderr.write('private diagnostic\nhttps://untrusted.invalid/oauth/authorize?state=private\n');
      child.stdout.write('\u001b[32m'+authorizationUrl.slice(0,65));
      child.stdout.write(authorizationUrl.slice(65)+'\u001b[0m\n');
    });
    return child;
  }});
  const login=connection.login(state=>updates.push(state));assert.equal(login,connection.login());
  await new Promise(done=>setImmediate(done));
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['auth','login','--claudeai']);
  assert.equal(updates.at(-1).url,authorizationUrl);assert(!updates.some(s=>s.phase==='complete'));
  calls[0].child.finish(0);await new Promise(done=>setImmediate(done));
  assert.equal(calls.length,2);assert.deepEqual(calls[1].args,['auth','status']);
  assert.equal(updates.at(-1).phase,'checking');
  calls[1].child.finish(0,signedIn);
  assert.deepEqual(await login,{connected:true,authentication:'authenticated'});
  assert.equal(updates.at(-1).phase,'complete');assert.equal(updates.at(-1).url,null);
  assert(!JSON.stringify(updates).includes('private'));
  for(const call of calls){
    assert.equal(call.program,exe);assert.equal(call.options.env.CLAUDE_CONFIG_DIR,config);
    assert.equal(call.options.cwd,home);assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
    assert.equal(call.child.killed,0);
  }
  assert.equal(connection.env.CLAUDE_CONFIG_DIR,inherited);
  assert.equal(connection.loginAttempt,null);assert.equal(connection.active.size,0);
});

test('a failed browser login is retryable and never reports the raw CLI diagnostics',async()=>{
  let attempt=0;const methods=[],updates=[];
  const {client}=makeClient({}, {spawnProcess:(_program,args)=>{
    const child=authChild();methods.push(args[1]);
    queueMicrotask(()=>{
      if(args[1]==='login'&&attempt++===0){child.stderr.write('private token diagnostic');child.finish(1);}
      else child.finish(0,args[1]==='status'?signedIn:'');
    });return child;
  }});
  client.on('login',state=>updates.push(state));
  await assert.rejects(client.login(),/nicht abgeschlossen/);
  assert.deepEqual(methods,['login']);assert.equal(updates.at(-1).phase,'error');assert.equal(updates.at(-1).url,null);
  assert(!JSON.stringify(updates).includes('private'));
  await client.login();assert.deepEqual(methods,['login','login','status']);
});

test('a successful login process alone cannot turn invalid or unauthenticated status into success',async()=>{
  for(const [code,output]of [[1,'{}'],[0,'not JSON'],[0,JSON.stringify({loggedIn:false})],[0,JSON.stringify({loggedIn:true,authMethod:'api_key'})]]){
    const updates=[];
    const connection=new ClaudeConnection(exe,{env:{},home,spawnProcess:(_program,args)=>{
      const child=authChild();queueMicrotask(()=>child.finish(args[1]==='status'?code:0,args[1]==='status'?output:''));return child;
    }});
    await assert.rejects(connection.login(state=>updates.push(state)),/keine erfolgreiche Anmeldung|anderer Claude-Zugang/);
    assert(!updates.some(state=>state.phase==='complete'));assert.equal(connection.active.size,0);
  }
});

test('login process errors and oversized status responses are bounded and sanitized',async()=>{
  for(const mode of ['throw','error','overflow']){
    let owned;
    const connection=new ClaudeConnection(exe,{env:{},home,spawnProcess:(_program,args)=>{
      if(mode==='throw')throw new Error('private process details');
      const child=owned=authChild();
      queueMicrotask(()=>{
        if(mode==='error')child.emit('error',new Error('private process details'));
        else if(args[1]==='status')child.stdout.write('x'.repeat(65537));
        else child.finish(0);
      });return child;
    }});
    await assert.rejects(connection.login(),error=>/nicht gestartet|ungültigen Anmeldestatus/.test(error.message)&&!error.message.includes('private'));
    assert.equal(connection.active.size,0);if(owned)assert.equal(owned.killed,1);
  }
});

test('login cancellation, shutdown, and timeout stop only their owned helper and permit retry',async()=>{
  for(const action of ['cancel','stop','timeout']){
    const children=[];
    const connection=new ClaudeConnection(exe,{env:{},home,loginTimeoutMs:action==='timeout'?15:1000,spawnProcess:()=>{
      const child=authChild();children.push(child);return child;
    }});
    const pending=connection.login();
    if(action==='cancel')connection.cancelLogin();if(action==='stop')connection.stop();
    await assert.rejects(pending,/abgebrochen|nicht rechtzeitig/);
    assert.equal(children.length,1);assert.equal(children[0].killed,1);
    assert.equal(connection.active.size,0);assert.equal(connection.loginAttempt,null);
    const retry=connection.login();connection.cancelLogin();await assert.rejects(retry,/abgebrochen/);
    assert.equal(children.length,2);assert.equal(children[0].killed,1);assert.equal(children[1].killed,1);
  }
});

test('cancelling while login switches to verification cannot start a late status process',async()=>{
  let starts=0;
  const connection=new ClaudeConnection(exe,{env:{},home,spawnProcess:()=>{
    starts++;const child=authChild();queueMicrotask(()=>child.finish(0));return child;
  }});
  await assert.rejects(connection.login(state=>{if(state.phase==='checking')connection.cancelLogin();}),/abgebrochen/);
  assert.equal(starts,1);assert.equal(connection.active.size,0);
});

test('login supports a resolved JavaScript CLI entry without a shell and inherits the selected config directory',async()=>{
  const entry=resolve('npm-runtime','cli.js'),config=resolve('inherited-config'),calls=[];
  const connection=new ClaudeConnection(entry,{env:{CLAUDE_CONFIG_DIR:config},home,spawnProcess:(program,args,options)=>{
    calls.push({program,args,options});const child=authChild();
    queueMicrotask(()=>child.finish(0,args[2]==='status'?signedIn:''));return child;
  }});
  await connection.login();
  for(const call of calls){assert.equal(call.program,process.execPath);assert.equal(call.args[0],entry);assert.equal(call.options.env.CLAUDE_CONFIG_DIR,config);}
});
