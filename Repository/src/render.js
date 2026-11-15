export const DEFAULTS = Object.freeze({
  title: 'chatGPT', titlePosition: 'top-center', titleOffsetY: 0, titleOffsetX: 0, numberY: 76, barY: 110, ringScale: 100, titleSize: 24, titleWeight: 700, titleColor: '#d9e1e2', direction: 'counterclockwise', showWindowLabels: false, window: 'week', display: 'remaining', style: 'number',
  topLabelMode: 'custom', transparentBackground: true, settingsRevision: 0, startTemplateVersion: 1,
  showReset: false, resetFormat: 'relative', smooth: false,
  showTitle: true, showUpdateInfo: true,
  resetFiveHourVisible: false, resetFiveHourPosition: 'bottom-center', resetFiveHourOffsetX: 0, resetFiveHourOffsetY: -18, resetFiveHourSize: 12, resetFiveHourWeight: 400, resetFiveHourColor: '#d9e1e2', resetFiveHourFormat: 'relative',
  resetWeekVisible: true, resetWeekPosition: 'bottom-center', resetWeekOffsetX: 0, resetWeekOffsetY: -38, resetWeekSize: 19, resetWeekWeight: 900, resetWeekColor: '#d9e1e2', resetWeekFormat: 'relative',
  warning: 50, critical: 80,
  textGood: '#64961e', textWarning: '#ff791f', textCritical: '#ff493d',
  barGood: '#64961e', barWarning: '#ff791f', barCritical: '#ff493d',
  background: '#090d0e', track: '#243333', claudePath: 'claude', claudeConfigDir: '', bucket: 'codex', refreshSeconds: 60
});
const LEGACY_VISUAL_DEFAULTS = {
  titlePosition:'top-center',titleOffsetY:0,titleOffsetX:0,numberY:77,barY:120,ringScale:100,titleSize:18,titleWeight:400,titleColor:'#d9e1e2',
  direction:'clockwise',showWindowLabels:true,window:'fiveHour',display:'remaining',style:'number',topLabelMode:'custom',transparentBackground:false,
  showReset:false,resetFormat:'relative',warning:50,critical:80,textGood:'#b6df29',textWarning:'#ff791f',textCritical:'#ff493d',
  barGood:'#b6df29',barWarning:'#ff791f',barCritical:'#ff493d',background:'#090d0e',track:'#243333'
};
export function normalizeInitialSettings(raw = {}) {
  const legacy = raw.startTemplateVersion !== 1 && Object.entries(LEGACY_VISUAL_DEFAULTS).every(([key,value])=>raw[key]===value);
  if (!legacy) return normalizeSettings(raw);
  const visual = Object.fromEntries(Object.keys(LEGACY_VISUAL_DEFAULTS).map(key=>[key,DEFAULTS[key]]));
  return normalizeSettings({...raw,...visual,startTemplateVersion:1,settingsRevision:Math.max(Date.now(),Number(raw.settingsRevision||0)+1)});
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback) => Number.isFinite(Number(value)) && value !== '' && value != null ? Number(value) : fallback;
const color = (value, fallback) => /^#[\da-f]{6}$/i.test(value ?? '') ? value : fallback;
export const escapeXml = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function formatPlanLabel(planType) {
  if (!planType) return '';
  return ({free:'Free',go:'Go',plus:'Plus',pro:'Pro',prolite:'Pro',business:'Business',team:'Business',enterprise:'Enterprise',edu:'Edu'})[String(planType).toLowerCase()] || 'ChatGPT-Abo';
}
export function selectAvailableWindow(selected, data) {
  if (!data) return selected;
  if (selected==='both' && data.fiveHour && data.week) return selected;
  if (selected==='fiveHour' && data.fiveHour) return selected;
  if (selected==='week' && data.week) return selected;
  if (data.fiveHour) return 'fiveHour';
  if (data.week) return 'week';
  return selected;
}
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  s.showTitle = raw.showTitle === undefined ? s.titlePosition !== 'none' : raw.showTitle === true;
  s.showUpdateInfo = raw.showUpdateInfo === undefined ? DEFAULTS.showUpdateInfo : raw.showUpdateInfo === true;
  for (const prefix of ['resetFiveHour','resetWeek']) {
    s[prefix+'Visible']=s[prefix+'Visible']===true;
    const positions=['top','middle','bottom'].flatMap(y=>['left','center','right'].map(x=>y+'-'+x));
    if(!positions.includes(s[prefix+'Position']))s[prefix+'Position']=DEFAULTS[prefix+'Position'];
    for(const axis of ['X','Y'])s[prefix+'Offset'+axis]=clamp(number(s[prefix+'Offset'+axis],DEFAULTS[prefix+'Offset'+axis]),-144,144);
    s[prefix+'Size']=clamp(number(s[prefix+'Size'],DEFAULTS[prefix+'Size']),8,48);
    s[prefix+'Weight']=clamp(number(s[prefix+'Weight'],DEFAULTS[prefix+'Weight']),100,900);
    s[prefix+'Color']=color(s[prefix+'Color'],DEFAULTS[prefix+'Color']);
    if(!['relative','absolute'].includes(s[prefix+'Format']))s[prefix+'Format']=DEFAULTS[prefix+'Format'];
  }
  s.title = String(s.title ?? DEFAULTS.title).slice(0, 32);
  for (const [key, allowed] of Object.entries({window:['fiveHour','week','both'],display:['remaining','used'],style:['dual','number','ring','fill','frame'],resetFormat:['relative','absolute'],topLabelMode:['custom','window','none']})) {
    if (!allowed.includes(s[key])) s[key] = DEFAULTS[key];
  }
  for (const key of ['showReset','smooth','transparentBackground','showWindowLabels']) s[key] = s[key] === true;
  if(!['clockwise','counterclockwise'].includes(s.direction))s.direction=DEFAULTS.direction;
  if(!['none',...['top','middle','bottom'].flatMap(y=>['left','center','right'].map(x=>y+'-'+x))].includes(s.titlePosition))s.titlePosition='top-center';
  s.titleOffsetX=clamp(number(s.titleOffsetX,0),-144,144);
  s.numberY=clamp(number(s.numberY,DEFAULTS.numberY),0,144);s.barY=clamp(number(s.barY,DEFAULTS.barY),0,124);s.ringScale=clamp(number(s.ringScale,100),20,100);s.smooth=false;
  s.titleOffsetY=clamp(number(s.titleOffsetY,0),-144,144);
  s.titleSize=clamp(number(s.titleSize,DEFAULTS.titleSize),8,48);s.titleWeight=clamp(number(s.titleWeight,DEFAULTS.titleWeight),100,900);s.titleColor=color(s.titleColor,DEFAULTS.titleColor);
  s.settingsRevision=Math.max(0,number(s.settingsRevision,0));
  s.warning = clamp(number(s.warning, 50), 0, 99);
  s.critical = clamp(number(s.critical, 80), s.warning + 1, 100);
  s.refreshSeconds = clamp(number(s.refreshSeconds, 60), 30, 3600);
  for (const key of ['textGood','textWarning','textCritical','barGood','barWarning','barCritical','background','track']) s[key] = color(s[key], DEFAULTS[key]);
  delete s.codexPath;
  s.claudePath=String(s.claudePath||'claude').trim();s.claudeConfigDir=String(s.claudeConfigDir||'').trim();
  s.bucket = String(s.bucket || 'codex').trim();
  return s;
}
export function colorsFor(usedPercent, settings) {
  const s = normalizeSettings(settings), used = clamp(number(usedPercent, 0),0,100);
  const level = used >= s.critical ? 'Critical' : used >= s.warning ? 'Warning' : 'Good';
  return { text:s['text'+level], bar:s['bar'+level] };
}
export function resetLabel(window, settings, now = Date.now()) {
  const reset = window?.resetsAt;
  if (!Number.isFinite(reset)) return 'Reset unbekannt';
  if (settings.resetFormat === 'absolute') return new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(reset*1000));
  const minutes = Math.ceil((reset*1000-now)/60000);
  if (minutes <= 0) return 'Reset fällig';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 1440) return `in ${Math.floor(minutes/60)} h ${minutes%60} m`;
  return `in ${Math.floor(minutes/1440)} d ${Math.floor(minutes%1440/60)} h`;
}
// Explicit continuous geometry avoids pathLength/dash interpretation differences.
function progressPath(points, percent, direction='clockwise') {
  if(direction==='counterclockwise')points=[points[0],...points.slice(1,-1).reverse(),points[0]];
  const lengths=points.slice(1).map((point,i)=>Math.hypot(point[0]-points[i][0],point[1]-points[i][1]));
  let remaining=lengths.reduce((a,b)=>a+b,0)*clamp(percent,0,100)/100;
  let path=`M${points[0].join(' ')}`;
  for(let i=0;i<lengths.length && remaining>0;i++){
    const t=Math.min(1,remaining/lengths[i]);
    path+=` L${points[i][0]+(points[i+1][0]-points[i][0])*t} ${points[i][1]+(points[i+1][1]-points[i][1])*t}`;
    remaining-=lengths[i];
  }
  return path;
}
function framePoints(top,bottom){
  const points=[[72,top],[127,top]];
  const corner=(control,end)=>{const start=points.at(-1);for(let i=1;i<=24;i++){const t=i/24,u=1-t;points.push([u*u*start[0]+2*u*t*control[0]+t*t*end[0],u*u*start[1]+2*u*t*control[1]+t*t*end[1]]);}};
  corner([140,top],[140,top+13]);points.push([140,bottom-13]);
  corner([140,bottom],[127,bottom]);points.push([17,bottom]);
  corner([4,bottom],[4,bottom-13]);points.push([4,top+13]);
  corner([4,top],[17,top]);points.push([72,top]);return points;
}
export function renderKey(rawSettings, data = null, status = {}, now = Date.now()) {
  const s = normalizeSettings(rawSettings);
  s.window = selectAvailableWindow(s.window,data);
  const text = (value,x,y,size,fill='#e8edef',extra='') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="middle" ${extra}>${escapeXml(value)}</text>`;
  const rect = (x,y,w,h,fill,r=0,extra='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
  const value = w => s.display === 'used' ? w.usedPercent : 100-w.usedPercent;
  const label = w => w?.label || (s.window==='week'?'Woche':'5 h');
  const dual = s.style === 'dual' || s.window === 'both';
  const windows = dual ? [data?.fiveHour,data?.week] : [s.window==='week'?data?.week:data?.fiveHour];
  const top=4, bottom=140, height=136, center=72;
  let body=s.transparentBackground?'':rect(0,0,144,144,s.background,12);
  const bar = (w,y,barHeight=18) => {
    const p=w?value(w):0, c=w?colorsFor(w.usedPercent,s):null;
    return rect(8,y,128,barHeight,s.track,barHeight/2)+(p>0?rect(8,y,128*p/100,barHeight,c.bar,Math.min(barHeight/2,128*p/200)):'');
  };
  if(dual && data){
    const rowHeight=height/2;
    windows.forEach((w,i)=>{
      const y=top+i*rowHeight, barHeight=rowHeight-12;
      body+=bar(w,y,barHeight);
      const ink=w?colorsFor(w.usedPercent,s).text:'#a4afb0';
      const outline='';
      if(s.showWindowLabels)body+=text(w?label(w):i?'Woche':'5 h',72,y+23,20,ink,outline);
      body+=text(w?Math.round(value(w))+'%':'—',72,s.showWindowLabels?y+barHeight-8:y+barHeight/2+10,30,ink,'font-weight="700" '+outline);

    });
  }else if(windows[0]){
    const w=windows[0],p=value(w),c=colorsFor(w.usedPercent,s),percent=`${Math.round(p)}%`;
    const bigSize=44;
    if(s.style==='ring'){
      body+=`<g transform="translate(72 72) scale(${s.ringScale/100}) translate(-72 -72)">`;
      const radius=58;
      body+=`<circle cx="72" cy="${center}" r="${radius}" fill="none" stroke="${s.track}" stroke-width="12"/>`;
      if(p>0){const points=Array.from({length:721},(_,i)=>{const angle=i*Math.PI/360-Math.PI/2;return [72+radius*Math.cos(angle),center+radius*Math.sin(angle)];});body+=`<path d="${progressPath(points,p,s.direction)}" fill="none" stroke="${c.bar}" stroke-width="12" stroke-linejoin="round"/>`;}
      const size=34;
      body+=text(percent,72,center+size*0.35,size,c.text,'font-weight="700"'+(percent.length>3?' textLength="80" lengthAdjust="spacingAndGlyphs"':''));
      body+='</g>';
    }else if(s.style==='frame'){
      body+=`<rect x="4" y="${top}" width="136" height="${height}" rx="13" fill="none" stroke="${s.track}" stroke-width="8"/>`;
      if(p>0)body+=`<path d="${progressPath(framePoints(top,bottom),p,s.direction)}" fill="none" stroke="${c.bar}" stroke-width="8" stroke-linejoin="round"/>`;
      body+=text(percent,72,center+bigSize*0.35,bigSize,c.text,'font-weight="700"');
    }else if(s.style==='fill'){
      const filled=144*p/100;
      body+=`<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${c.bar}" stop-opacity="0.16"/><stop offset="1" stop-color="${c.bar}" stop-opacity="0.68"/></linearGradient><clipPath id="plot"><rect x="0" y="0" width="144" height="144" rx="12"/></clipPath></defs>`;
      if(!s.transparentBackground)body+=rect(0,0,144,144,s.track,12);
      if(p>0)body+=`<g clip-path="url(#plot)">`+rect(0,144-filled,144,filled,'url(#fill)')+`<path d="M0 ${144-filled} H144" stroke="${c.bar}" stroke-width="3"/></g>`;
      body+=text(percent,72,center+bigSize*0.35,bigSize,c.text,'font-weight="700"');
    }else{
      body+=text(percent,72,s.numberY,bigSize,c.text,'font-weight="700"');
      body+=bar(w,s.barY,20);
    }
  }else{
    body+=text('—',72,center+22,64,'#a4afb0');
  }
  const overlayText=(value,position,offsetX,offsetY,size,weight,fill,id)=>{
    const [vertical,horizontal]=position.split('-');
    const x={left:8,center:72,right:136}[horizontal]+offsetX,y={top:size+4,middle:72+size*.35,bottom:140}[vertical]+offsetY;
    const anchor={left:'start',center:'middle',right:'end'}[horizontal];
    return text(value,x,y,size,fill,`font-weight="${weight}" data-element="${id}"`).replace('text-anchor="middle"',`text-anchor="${anchor}"`);
  };
  if(s.showTitle && s.title && s.titlePosition!=='none')body+=overlayText(s.title,s.titlePosition,s.titleOffsetX,s.titleOffsetY,s.titleSize,s.titleWeight,s.titleColor,'title');
  for(const [prefix,window] of [['resetFiveHour',data?.fiveHour],['resetWeek',data?.week]]){
    if(s[prefix+'Visible'] && Number.isFinite(window?.resetsAt)){
      body+=overlayText(resetLabel(window,{resetFormat:s[prefix+'Format']},now),s[prefix+'Position'],s[prefix+'OffsetX'],s[prefix+'OffsetY'],s[prefix+'Size'],s[prefix+'Weight'],s[prefix+'Color'],prefix);
    }
  }
  if(status.stale)body+=`<circle cx="137" cy="8" r="4" fill="#ff791f"/>`;
  if(s.showUpdateInfo && status.updateAvailable===true)body+=`<circle cx="132" cy="12" r="6" fill="#ff493d"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" font-family="Arial, sans-serif">${body}</svg>`;
}
