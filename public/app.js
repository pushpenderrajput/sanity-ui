// ── Global data store: avoids embedding complex strings in onclick attrs ──────
const _S = {};         // _S[key] = any data (curl text, payload text, etc.)
let _sKey = 0;
function stash(v){ const k='k'+(++_sKey); _S[k]=v; return k; }
function get(k){ return _S[k]; }

// ── App state ─────────────────────────────────────────────────────────────────
let instances=[], customApis={}, activeId=null, editId=null;
let results={}, payloads={}, instVars={}, hiddenApis={};
let selectedApis={};   // { instId: Set<apiId> }  — in-memory only, reset on refresh
let _parsedCurl=null;

// ── Channel definitions ───────────────────────────────────────────────────────
const CHANNELS = [
  { id:'sms',   label:'SMS',       icon:'📱', cls:'ch-sms',   badge:'ch-badge-sms'   },
  { id:'rcs',   label:'RCS',       icon:'💬', cls:'ch-rcs',   badge:'ch-badge-rcs'   },
  { id:'wa',    label:'WhatsApp',  icon:'🟢', cls:'ch-wa',    badge:'ch-badge-wa'    },
  { id:'email', label:'Email',     icon:'📧', cls:'ch-email', badge:'ch-badge-email' },
  { id:'other', label:'Other',     icon:'🔧', cls:'ch-other', badge:'ch-badge-other' },
];
function chMeta(id){ return CHANNELS.find(c=>c.id===id) || CHANNELS[4]; }

// channel picker wiring — call once DOM is ready
function wireChannelPickers(){
  document.querySelectorAll('.ch-select-row').forEach(row=>{
    const hidden = document.getElementById(row.id.replace('-row','-channel') || row.id.replace('ch-row','channel'));
    // find sibling hidden input by convention: row id = "X-ch-row", hidden = "X-channel"
    const hiddenId = row.id.replace(/-ch-row$/,'-channel');
    const inp = document.getElementById(hiddenId);
    row.addEventListener('click', e=>{
      const opt = e.target.closest('.ch-sel-opt');
      if(!opt) return;
      row.querySelectorAll('.ch-sel-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
      if(inp) inp.value = opt.dataset.ch;
    });
  });
}

function setChannelPicker(rowId, chId){
  const row = document.getElementById(rowId);
  if(!row) return;
  const hiddenId = rowId.replace(/-ch-row$/,'-channel');
  const inp = document.getElementById(hiddenId);
  row.querySelectorAll('.ch-sel-opt').forEach(o=>{
    o.classList.toggle('active', o.dataset.ch === chId);
  });
  if(inp) inp.value = chId;
}

// ── Default API definitions ───────────────────────────────────────────────────
const DEFAULTS=[];
let _openModalChannel = null; // pre-select channel when opening modal from folder

function getApis(inst){
  const base=inst.url.replace(/\/$/,''), tok=inst.token, ck=inst.cookie;
  const hdr=()=>({'Accept':'application/json','Content-Type':'application/json','Authorization':'Bearer '+tok,...(ck?{'Cookie':ck}:{})});
  const def=DEFAULTS.map(a=>({...a,url:base+a.path,headers:hdr(),isDefault:true}));
  const cst=(customApis[inst.id]||[]).map(a=>({...a,url:base+a.path,headers:hdr(),isDefault:false}));
  const hidden=new Set(hiddenApis[inst.id]||[]);
  return [...def,...cst].filter(a=>!hidden.has(a.id));
}

// ── Payload helpers ───────────────────────────────────────────────────────────
function getPayload(iid,api){
  const k=iid+'_'+api.id;
  return payloads[k]!==undefined ? payloads[k] : JSON.stringify(api.payload||{},null,2);
}
function readPayloadEl(iid,apiId){ return document.getElementById('pe_'+iid+'_'+apiId)?.value; }

// ── Persistence — via Express backend ────────────────────────────────────────
let _lastServerVersion = null;  // ISO string of last known DB updated_at
let _saving = false;            // guard: don't poll-reload while saving

async function save(){
  _saving = true;
  try{
    await fetch('/api/config',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({instances,payloads,customApis,instVars,hiddenApis})
    });
    // Update our version stamp so polling doesn't trigger a reload for our own save
    _lastServerVersion = new Date().toISOString();
  }catch(e){console.error('Save error:',e);}
  finally{ setTimeout(()=>{ _saving=false; }, 1000); }
}

// Explicit delete helper — hits a dedicated DELETE endpoint so no save() wipe occurs
async function dbDel(path){
  try{
    await fetch(path, {method:'DELETE'});
  }catch(e){ console.error('dbDel error:',e); }
}

async function load(){
  try{
    const r=await fetch('/api/config');
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    instances  = d.instances  || [];
    payloads   = d.payloads   || {};
    customApis = d.customApis || {};
    instVars   = d.instVars   || {};
    hiddenApis = d.hiddenApis || {};
  }catch(e){
    console.error('Load error:',e);
    instances=[]; payloads={}; customApis={}; instVars={}; hiddenApis={};
  }
}

// ── Real-time sync — poll every 5 s for changes from other users ──────────────
function startPolling(){
  setInterval(async ()=>{
    if(_saving) return;                                    // skip during our own save
    const active=document.activeElement;
    const editing=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.tagName==='SELECT');
    if(editing) return;                                    // don't interrupt typing

    try{
      const r=await fetch('/api/config/version');
      const d=await r.json();
      const serverVer=d.updatedAt;
      if(!serverVer) return;
      if(_lastServerVersion && serverVer===_lastServerVersion) return;  // no change
      if(!_lastServerVersion){ _lastServerVersion=serverVer; return; }  // first poll, just record

      // Changes detected from another user — reload silently
      _lastServerVersion=serverVer;
      await load();
      renderSidebar();
      renderMain();
      _showSyncBadge();
    }catch(e){ /* silent — offline or transient error */ }
  }, 5000);
}

function _showSyncBadge(){
  const id='_syncBadge';
  let el=document.getElementById(id);
  if(!el){
    el=document.createElement('div');
    el.id=id;
    el.style.cssText='position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--green);color:var(--green);padding:7px 14px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity .4s';
    document.body.appendChild(el);
  }
  el.textContent='🔄 Synced with team';
  el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>{ el.style.opacity='0'; },2200);
}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(){
  const el=document.getElementById('instList');
  el.innerHTML='';
  instances.forEach(inst=>{
    const r=results[inst.id]||{}, apis=getApis(inst), total=apis.length;
    const ok=Object.values(r).filter(x=>x.status==='success').length;
    const er=Object.values(r).filter(x=>x.status==='error').length;
    const done=ok+er;
    const dc=done===0?'':(er>0&&ok>0?'partial':er>0?'err':ok===total?'ok':'partial');
    const div=document.createElement('div');
    div.className='inst-item'+(inst.id===activeId?' active':'');
    div.dataset.id=inst.id;
    div.innerHTML=
      '<div class="dot '+dc+'"></div>'+
      '<div class="inst-meta">'+
        '<div class="inst-name">'+esc(inst.name)+'</div>'+
        '<div class="inst-url">'+esc(inst.url)+'</div>'+
        (done>0?'<div class="pbar-w"><div class="pbar" style="width:'+Math.round(done/total*100)+'%"></div></div>':'')+
      '</div>'+
      '<button class="del-btn" data-del="'+inst.id+'">✕</button>';
    el.appendChild(div);
  });
}

// Event delegation on sidebar
document.getElementById('instList').addEventListener('click',function(e){
  // Delete button
  const delId=e.target.dataset.del;
  if(delId){e.stopPropagation();deleteInst(delId);return;}
  // Instance item click
  const item=e.target.closest('.inst-item');
  if(item&&item.dataset.id) selectInst(item.dataset.id);
});

function selectInst(id){
  activeId=id;
  renderSidebar();
  renderMain();
}

// ── Main area ─────────────────────────────────────────────────────────────────
function renderMain(){
  const area=document.getElementById('main');
  if(!activeId){
    area.innerHTML='<div class="empty"><div class="empty-icon">🚀</div><h3>Select an Instance</h3><p>Pick one from the sidebar to view and run its APIs.</p><button class="btn btn-p" onclick="openInstModal()">+ Add Instance</button></div>';
    return;
  }
  const inst=instances.find(i=>i.id===activeId);
  if(!inst){area.innerHTML='<div class="empty"><h3>Instance not found.</h3></div>';return;}

  const apis=getApis(inst);
  const r=results[inst.id]||{};
  const total=apis.length;
  const ok=Object.values(r).filter(x=>x.status==='success').length;
  const er=Object.values(r).filter(x=>x.status==='error').length;
  const running=Object.values(r).filter(x=>x.status==='running').length;
  const defApis=apis.filter(a=>a.isDefault);
  const cstApis=apis.filter(a=>!a.isDefault);

  if(!selectedApis[activeId]) selectedApis[activeId]=new Set();
  const selSet=selectedApis[activeId];
  const selCount=selSet.size;
  const hiddenCount=(hiddenApis[activeId]||[]).length;

  const disabled=running>0;
  const runAllBtn=disabled
    ? '<button class="btn btn-p" disabled><span class="spin"></span> Running…</button>'
    : '<button class="btn btn-p" onclick="runAll(\''+activeId+'\')">▶ Run All</button>';
  const runSelBtn='<button class="btn btn-p" id="runSelBtn_'+activeId+'" onclick="runSelected(\''+activeId+'\')"'+(selCount===0||disabled?' disabled':'')+' style="background:var(--accent2)">▶ Run Selected'+(selCount>0?' ('+selCount+')':'')+'</button>';

  let html=
    '<div class="i-hdr">'+
      '<div class="i-title">'+esc(inst.name)+'</div>'+
      '<div class="i-url" title="'+esc(inst.url)+'">'+esc(inst.url)+'</div>'+
      '<button class="btn btn-g btn-sm" onclick="openEditModal(\''+inst.id+'\')">✏ Edit</button>'+
      (hiddenCount?'<button class="btn btn-g btn-sm" style="color:var(--yellow);border-color:var(--yellow)" onclick="restoreHidden(\''+inst.id+'\')">↩ Restore '+hiddenCount+' hidden</button>':'')+
    '</div>'+
    '<div class="run-bar">'+
      '<div class="run-label">'+esc(inst.name)+' — <b>'+total+'</b> APIs &nbsp;<label title="Select / deselect all" style="font-size:12px;color:var(--text3);cursor:pointer;user-select:none"><input type="checkbox" id="selAllCb_'+activeId+'"'+(selCount===total&&total>0?' checked':'')+' onchange="toggleSelectAll(\''+activeId+'\',this)" style="accent-color:var(--accent2);margin-right:4px">Select all</label></div>'+
      '<div class="pills">'+
        (ok>0?'<div class="pill p-g">✓ '+ok+' passed</div>':'')+
        (er>0?'<div class="pill p-r">✕ '+er+' failed</div>':'')+
        (running>0?'<div class="pill p-n"><span class="spin"></span> '+running+' running</div>':'')+
        (ok===0&&er===0&&running===0?'<div class="pill p-n">— not run yet</div>':'')+
      '</div>'+
      runAllBtn+runSelBtn+
      '<button class="btn btn-g" onclick="resetRes(\''+activeId+'\')">↺ Reset</button>'+
      '<button class="btn btn-g" onclick="copyAllCurls(\''+activeId+'\')">📋 cURLs</button>'+
      ((ok+er)>0?'<button class="btn btn-g" style="border-color:var(--accent);color:var(--accent)" onclick="openReport(\''+activeId+'\')">📊 Report</button>':'')+
    '</div>';

  // ── Variables panel ──
  html+=buildVarsPanel(inst.id);

  // ── Channel folders ──
  html += buildChannelFolders(inst, cstApis, r);

  area.innerHTML=html;
  attachPayloadListeners(inst.id);
  // Set indeterminate state on channel checkboxes (can't be done via HTML)
  if(selectedApis[inst.id]){
    CHANNELS.forEach(ch=>{
      const chApis=(customApis[inst.id]||[]).filter(a=>(a.channel||'sms')===ch.id);
      const chSel=chApis.filter(a=>selectedApis[inst.id].has(a.id)).length;
      const cbEl=document.getElementById('chsa_'+inst.id+'_'+ch.id);
      if(cbEl) cbEl.indeterminate=chSel>0&&chSel<chApis.length;
    });
  }
}

// ── Attach oninput to all payload textareas so edits persist ──────────────────
function attachPayloadListeners(iid){
  document.querySelectorAll('.pe').forEach(ta=>{
    const id=ta.id; // pe_<iid>_<aid>
    if(!id.startsWith('pe_'+iid+'_'))return;
    const aid=id.slice(('pe_'+iid+'_').length);
    ta.addEventListener('input',function(){
      payloads[iid+'_'+aid]=this.value;
      save();
    });
  });
}

// ── Channel folder renderer ───────────────────────────────────────────────────
function buildChannelFolders(inst, apis, r){
  const iid = inst.id;
  let out = '';
  CHANNELS.forEach(ch => {
    const chApis = apis.filter(a => (a.channel || 'sms') === ch.id);
    const ok  = chApis.filter(a => r[a.id]?.status==='success').length;
    const er  = chApis.filter(a => r[a.id]?.status==='error').length;
    const run = chApis.filter(a => r[a.id]?.status==='running').length;
    const folderId  = 'chf_'+iid+'_'+ch.id;
    const bodyId    = 'chfb_'+iid+'_'+ch.id;
    const chevId    = 'chfc_'+iid+'_'+ch.id;
    const saId      = 'chsa_'+iid+'_'+ch.id;

    // How many in this channel are selected?
    const sel       = selectedApis[iid] || new Set();
    const chSelCount= chApis.filter(a=>sel.has(a.id)).length;
    const allSel    = chApis.length>0 && chSelCount===chApis.length;
    const someSel   = chSelCount>0 && chSelCount<chApis.length;

    const pills =
      (ok  ? '<div class="pill p-g" style="font-size:11px;padding:1px 7px">✓'+ok+'</div>' : '')+
      (er  ? '<div class="pill p-r" style="font-size:11px;padding:1px 7px">✕'+er+'</div>' : '')+
      (run ? '<div class="pill p-n" style="font-size:11px;padding:1px 7px"><span class="spin"></span></div>' : '');

    const addActs =
      '<button class="btn btn-g btn-sm" onclick="openManualModal(null,\''+ch.id+'\')">➕ Manual</button>'+
      '<button class="btn btn-g btn-sm" onclick="openCurlModal(\''+ch.id+'\')">📋 cURL</button>'+
      '<button class="btn btn-g btn-sm" onclick="openColModal(\''+ch.id+'\')">📦 Import</button>';

    // Select-all checkbox for this channel (rendered; indeterminate set via JS after)
    const saCb = chApis.length
      ? '<label class="ch-sa-label" onclick="event.stopPropagation()" title="Select all '+ch.label+' APIs">'+
          '<input type="checkbox" id="'+saId+'"'+(allSel?' checked':'')+
          ' onchange="toggleChSelectAll(\''+iid+'\',\''+ch.id+'\',this)" style="accent-color:var(--accent2)">'+
          '<span style="font-size:11px;color:var(--text3);margin-left:4px">Select all</span>'+
        '</label>'
      : '';

    out +=
      '<div class="ch-folder '+ch.cls+'" id="'+folderId+'">'+
        '<div class="ch-folder-hdr open" onclick="toggleChFolder(\''+bodyId+'\',\''+chevId+'\',this)">'+
          '<span class="ch-folder-icon">'+ch.icon+'</span>'+
          '<span class="ch-folder-name">'+ch.label+'</span>'+
          '<span class="ch-folder-count">'+chApis.length+' API'+(chApis.length!==1?'s':'')+'</span>'+
          '<div class="ch-folder-pills">'+pills+'</div>'+
          saCb+
          '<div class="ch-folder-acts" onclick="event.stopPropagation()">'+addActs+'</div>'+
          '<span class="ch-folder-chev open" id="'+chevId+'">▼</span>'+
        '</div>'+
        '<div class="ch-folder-body" id="'+bodyId+'">'+
          (chApis.length
            ? chApis.map(api => buildCard(inst, api, r[api.id])).join('')
            : '<div class="ch-empty">No '+ch.label+' APIs yet — add one above</div>'
          )+
        '</div>'+
      '</div>';
  });
  return out;
}

function toggleChFolder(bodyId, chevId, hdr){
  const body = document.getElementById(bodyId);
  const chev = document.getElementById(chevId);
  if(!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  hdr.classList.toggle('open', !open);
  if(chev) chev.classList.toggle('open', !open);
}

// ── Variables panel ───────────────────────────────────────────────────────────
function buildVarsPanel(iid){
  const vars=instVars[iid]||{};
  const entries=Object.entries(vars);
  const rows=entries.map(([k,v],i)=>
    '<div class="var-row" data-vi="'+i+'">'+
      '<span class="var-token">{{</span>'+
      '<input class="var-key-in" value="'+esc(k)+'" placeholder="variable_name" data-vi="'+i+'" data-iid="'+iid+'" onchange="updateVar(\''+iid+'\','+i+',\'key\',this.value)">'+
      '<span class="var-token">}}</span>'+
      '<span class="var-eq">=</span>'+
      '<input class="var-val-in" value="'+esc(v)+'" placeholder="value" data-vi="'+i+'" data-iid="'+iid+'" onchange="updateVar(\''+iid+'\','+i+',\'val\',this.value)">'+
      '<button class="var-del" onclick="deleteVar(\''+iid+'\','+i+')">✕</button>'+
    '</div>'
  ).join('');

  return '<div class="vars-panel" id="varsPanel_'+iid+'">'+
    '<div class="vars-hdr" onclick="toggleVarsPanel(\''+iid+'\')">'+
      '<span>⚙ Instance Variables</span>'+
      '<span class="vars-count">'+(entries.length?entries.length+' defined':'none — click to add')+'</span>'+
      '<span class="vars-hint">Use <code>{{var}}</code> in payloads · auto-substituted at runtime</span>'+
      '<span class="chev" id="vchev_'+iid+'">▼</span>'+
    '</div>'+
    '<div class="vars-body" id="varsbody_'+iid+'">'+
      '<div class="var-rows" id="varrows_'+iid+'">'+rows+'</div>'+
      '<div style="margin-top:8px">'+
        '<button class="btn btn-g btn-sm" onclick="addVar(\''+iid+'\')">+ Add Variable</button>'+
        (entries.length?'<button class="btn btn-g btn-sm" style="margin-left:8px" onclick="clearVars(\''+iid+'\')">Clear All</button>':'')+
      '</div>'+
    '</div>'+
  '</div>';
}

function buildCard(inst,api,res){
  const iid=inst.id, aid=api.id;
  const status=res?res.status:'pending';
  const statusLabel={pending:'Pending',running:'Running…',success:res&&res.code?res.code+' OK':'OK',error:res&&res.code?res.code+' Fail':'Error'}[status]||'Pending';
  const payload=getPayload(iid,api);
  const curlStr=buildCurl(api,payload);
  const curlKey=stash(curlStr);
  const bodyId='cb_'+iid+'_'+aid;
  const tabPfx='t_'+iid+'_'+aid;
  const isSelected=selectedApis[iid]&&selectedApis[iid].has(aid);

  const tagHtml=api.isDefault
    ?'<span class="lbl-tag">'+esc(api.label)+'</span>'
    :'<span class="custom-tag">✦ '+esc(api.label)+'</span>';

  // Checkbox for selection
  const cbHtml='<input type="checkbox" class="api-cb" data-iid="'+iid+'" data-aid="'+aid+'"'+(isSelected?' checked':'')+' onclick="toggleSelect(\''+iid+'\',\''+aid+'\',this,event)" title="Select for Run Selected">';

  // Channel badge
  const ch = chMeta(api.channel || 'sms');
  const chBadge = '<span class="ch-badge '+ch.badge+'" title="'+ch.label+'">'+ch.label+'</span>';

  // Edit + delete buttons (all APIs get delete; custom also get edit)
  const editBtn=!api.isDefault?'<button class="del-api edit-api" onclick="openManualModal(\''+aid+'\',null)" title="Edit API">✏</button>':'';
  const delBtn='<button class="del-api" onclick="hideApi(\''+iid+'\',\''+aid+'\',\''+(!api.isDefault?'custom':'default')+'\',event)" title="Delete / Hide API">🗑</button>';

  const sIcon=status==='running'?'<span class="spin"></span> ':'';

  // Response HTML
  let respHtml;
  if(!res||status==='pending') respHtml='<div style="color:var(--text3);font-size:13px">Not run yet.</div>';
  else if(status==='running') respHtml='<div style="display:flex;align-items:center;gap:8px"><span class="spin"></span><span style="color:var(--text2)">Running…</span></div>';
  else{
    const ok=status==='success';
    const respKey=stash(res.body||'');
    respHtml=
      '<div class="resp-meta">'+
        '<span class="resp-status '+(ok?'resp-ok':'resp-err')+'">'+(ok?'✓':'✕')+' HTTP '+(res.code||'—')+'</span>'+
        (res.time?'<span class="resp-time">⏱ '+res.time+'ms</span>':'')+
        '<button class="btn btn-g btn-sm" style="margin-left:auto" onclick="copyStash(\''+respKey+'\',this)">📋 Copy</button>'+
      '</div>'+
      '<div class="resp-box">'+esc(res.body||'')+'</div>';
  }

  return '<div class="card '+status+(isSelected?' card-sel':'')+'" id="card_'+iid+'_'+aid+'">'+
    '<div class="card-hdr">'+
      cbHtml+
      '<span class="card-hdr-expand" onclick="toggleCard(\''+bodyId+'\')" style="display:flex;align-items:center;gap:9px;flex:1;min-width:0;cursor:pointer">'+
        '<span class="m-badge">'+api.method+'</span>'+
        '<span class="ep" title="'+esc(api.path)+'">'+esc(api.path)+'</span>'+
        chBadge+
        tagHtml+
        '<span class="s-badge '+status+'">'+sIcon+statusLabel+'</span>'+
      '</span>'+
      editBtn+delBtn+
      '<span class="chev" id="chev_'+bodyId+'" onclick="toggleCard(\''+bodyId+'\')" style="cursor:pointer">▼</span>'+
    '</div>'+
    '<div class="card-body" id="'+bodyId+'">'+
      '<div class="tabs">'+
        '<div class="tab active" onclick="swTab(event,\''+tabPfx+'\',\'payload\')">Payload</div>'+
        '<div class="tab" onclick="swTab(event,\''+tabPfx+'\',\'response\')">Response'+(res&&res.code?' ('+res.code+')':'')+'</div>'+
        '<div class="tab" onclick="swTab(event,\''+tabPfx+'\',\'curl\')">cURL</div>'+
      '</div>'+
      '<div class="tab-c active" id="'+tabPfx+'_payload">'+
        '<textarea class="pe" id="pe_'+iid+'_'+aid+'">'+escHtml(payload)+'</textarea>'+
        '<div class="p-actions">'+
          '<button class="btn btn-p btn-sm" onclick="runOne(\''+iid+'\',\''+aid+'\')">▶ Run This</button>'+
          '<button class="btn btn-g btn-sm" onclick="resetPayload(\''+iid+'\',\''+aid+'\')">↺ Reset Payload</button>'+
          '<span class="p-note">Edits saved per instance</span>'+
        '</div>'+
      '</div>'+
      '<div class="tab-c" id="'+tabPfx+'_response">'+respHtml+'</div>'+
      '<div class="tab-c" id="'+tabPfx+'_curl">'+
        '<div style="margin-bottom:8px"><button class="btn btn-g btn-sm" onclick="copyStash(\''+curlKey+'\',this)">📋 Copy cURL</button></div>'+
        '<div class="curl-box">'+esc(curlStr)+'</div>'+
      '</div>'+
    '</div>'+
  '</div>';
}

// ── Tab & card toggle ─────────────────────────────────────────────────────────
function swTab(e,pfx,name){
  const hdr=e.target.closest('.tabs');
  hdr.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  e.target.classList.add('active');
  ['payload','response','curl'].forEach(n=>{
    const el=document.getElementById(pfx+'_'+n);
    if(el)el.classList.toggle('active',n===name);
  });
}
function toggleCard(id){
  const b=document.getElementById(id), c=document.getElementById('chev_'+id);
  if(!b)return;
  const o=b.classList.toggle('open');
  if(c)c.classList.toggle('open',o);
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function runAll(iid){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  if(!results[iid])results[iid]={};
  const apis=getApis(inst);
  apis.forEach(a=>{results[iid][a.id]={status:'running'};});
  renderMain(); renderSidebar();
  await Promise.all(apis.map(a=>callApi(iid,a)));
  renderMain(); renderSidebar();
}

async function runOne(iid,aid){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  if(!results[iid])results[iid]={};
  const api=getApis(inst).find(a=>a.id===aid); if(!api)return;
  results[iid][aid]={status:'running'};
  const card=document.getElementById('card_'+iid+'_'+aid);
  if(card){card.className='card running';const sb=card.querySelector('.s-badge');if(sb){sb.className='s-badge running';sb.innerHTML='<span class="spin"></span> Running…';}}
  await callApi(iid,api);
  renderMain(); renderSidebar();
}

// Apply {{var}} substitution using this instance's variables
function applyVars(iid,str){
  const vars=instVars[iid]||{};
  return str.replace(/\{\{([^}]+)\}\}/g,(match,key)=>{
    const k=key.trim();
    return vars.hasOwnProperty(k)?vars[k]:match;
  });
}

async function callApi(iid,api){
  const el=document.getElementById('pe_'+iid+'_'+api.id);
  const rawTemplate=el?el.value:getPayload(iid,api);
  const raw=applyVars(iid,rawTemplate);      // substitute {{vars}} before sending
  let body; try{body=JSON.parse(raw);}catch(e){body=raw;}
  const t0=Date.now();
  try{
    // Route through /api/proxy so Node makes the request — avoids CORS entirely
    const r=await fetch('/api/proxy',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({url:api.url,method:api.method,headers:api.headers,body})
    });
    const d=await r.json();
    if(!r.ok && d.error){
      results[iid][api.id]={status:'error',code:0,body:'Proxy error: '+d.error,time:d.time||Date.now()-t0};
      return;
    }
    let pretty=d.body; try{pretty=JSON.stringify(JSON.parse(d.body),null,2);}catch(e){}
    results[iid][api.id]={status:d.ok?'success':'error',code:d.status,body:pretty,time:d.time};
  }catch(err){
    results[iid][api.id]={status:'error',code:0,body:'Request failed: '+err.message,time:Date.now()-t0};
  }
}

function resetRes(iid){results[iid]={};renderMain();renderSidebar();}
function resetPayload(iid,aid){delete payloads[iid+'_'+aid];save();renderMain();}

// ── Run Selected ──────────────────────────────────────────────────────────────
async function runSelected(iid){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const sel=selectedApis[iid]; if(!sel||!sel.size)return;
  if(!results[iid])results[iid]={};
  const apis=getApis(inst).filter(a=>sel.has(a.id));
  apis.forEach(a=>{results[iid][a.id]={status:'running'};});
  renderMain(); renderSidebar();
  await Promise.all(apis.map(a=>callApi(iid,a)));
  renderMain(); renderSidebar();
}

// ── Checkbox selection ────────────────────────────────────────────────────────
function _refreshSelUI(iid){
  if(!selectedApis[iid])selectedApis[iid]=new Set();
  const selCount=selectedApis[iid].size;
  const inst=instances.find(i=>i.id===iid);
  const total=inst?getApis(inst).length:0;
  // Run Selected button
  const btn=document.getElementById('runSelBtn_'+iid);
  if(btn){btn.disabled=selCount===0;btn.textContent='▶ Run Selected'+(selCount>0?' ('+selCount+')':'');}
  // Delete Selected button — full re-render needed only when it appears/disappears
  // Use a lightweight DOM swap instead
  const delId='delSelBtn_'+iid;
  let delBtn=document.getElementById(delId);
  if(selCount>0){
    if(!delBtn){
      delBtn=document.createElement('button');
      delBtn.id=delId;
      delBtn.className='btn btn-g';
      delBtn.style.cssText='border-color:#e74c3c;color:#e74c3c';
      delBtn.onclick=()=>deleteSelected(iid);
      const runBar=btn&&btn.parentNode;
      if(runBar)runBar.insertBefore(delBtn,btn.nextSibling);
    }
    delBtn.textContent='🗑 Delete Selected ('+selCount+')';
  } else {
    if(delBtn)delBtn.remove();
  }
  // Global select-all checkbox
  const saCb=document.getElementById('selAllCb_'+iid);
  if(saCb){saCb.checked=total>0&&selCount===total;saCb.indeterminate=selCount>0&&selCount<total;}
  // Per-channel select-all checkboxes
  const instObj=instances.find(i=>i.id===iid);
  if(instObj){
    CHANNELS.forEach(ch=>{
      const chApis=getApis(instObj).filter(a=>(a.channel||'sms')===ch.id);
      const chSel=chApis.filter(a=>selectedApis[iid]&&selectedApis[iid].has(a.id)).length;
      const cbEl=document.getElementById('chsa_'+iid+'_'+ch.id);
      if(cbEl){
        cbEl.checked=chApis.length>0&&chSel===chApis.length;
        cbEl.indeterminate=chSel>0&&chSel<chApis.length;
      }
    });
  }
}

function toggleSelect(iid,aid,cb,e){
  e.stopPropagation();
  if(!selectedApis[iid])selectedApis[iid]=new Set();
  if(cb.checked) selectedApis[iid].add(aid);
  else selectedApis[iid].delete(aid);
  _refreshSelUI(iid);
  // Highlight card
  const card=document.getElementById('card_'+iid+'_'+aid);
  if(card) card.classList.toggle('card-sel',cb.checked);
}

function toggleSelectAll(iid,cb){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const apis=getApis(inst);
  if(!selectedApis[iid])selectedApis[iid]=new Set();
  if(cb.checked){
    apis.forEach(a=>selectedApis[iid].add(a.id));
  } else {
    selectedApis[iid].clear();
  }
  // Update all card checkboxes + highlights
  apis.forEach(a=>{
    const c=document.querySelector('.api-cb[data-iid="'+iid+'"][data-aid="'+a.id+'"]');
    if(c)c.checked=cb.checked;
    const card=document.getElementById('card_'+iid+'_'+a.id);
    if(card)card.classList.toggle('card-sel',cb.checked);
  });
  _refreshSelUI(iid);
}

// Select all APIs in a specific channel folder
function toggleChSelectAll(iid, chId, cb){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const chApis=getApis(inst).filter(a=>(a.channel||'sms')===chId);
  if(!selectedApis[iid])selectedApis[iid]=new Set();
  chApis.forEach(a=>{
    if(cb.checked) selectedApis[iid].add(a.id);
    else selectedApis[iid].delete(a.id);
    const c=document.querySelector('.api-cb[data-iid="'+iid+'"][data-aid="'+a.id+'"]');
    if(c)c.checked=cb.checked;
    const card=document.getElementById('card_'+iid+'_'+a.id);
    if(card)card.classList.toggle('card-sel',cb.checked);
  });
  _refreshSelUI(iid);
}

// ── Hide / Delete API ─────────────────────────────────────────────────────────
function hideApi(iid,aid,type,e){
  e.stopPropagation();
  const msg=type==='default'
    ?'Hide this API for this instance? (Restore it anytime with "Restore hidden".)'
    :'Delete this custom API? This cannot be undone.';
  if(!confirm(msg))return;
  if(type==='default'){
    if(!hiddenApis[iid])hiddenApis[iid]=[];
    if(!hiddenApis[iid].includes(aid))hiddenApis[iid].push(aid);
    save();  // upsert the hidden entry
  } else {
    if(customApis[iid])customApis[iid]=customApis[iid].filter(a=>a.id!==aid);
    dbDel('/api/apis/'+aid);  // explicit DELETE — safe for multi-user
  }
  if(selectedApis[iid])selectedApis[iid].delete(aid);
  if(results[iid])delete results[iid][aid];
  renderMain(); renderSidebar();
}

function deleteSelected(iid){
  const sel=selectedApis[iid]; if(!sel||!sel.size)return;
  const ids=[...sel];
  // Separate into custom vs default
  const allApis=(customApis[iid]||[]);
  const customIds=ids.filter(id=>allApis.some(a=>a.id===id));
  const defaultIds=ids.filter(id=>!allApis.some(a=>a.id===id));
  const parts=[];
  if(customIds.length)parts.push(customIds.length+' custom API'+(customIds.length>1?'s':''));
  if(defaultIds.length)parts.push(defaultIds.length+' default API'+(defaultIds.length>1?'s (will be hidden)':'(will be hidden)'));
  if(!confirm('Delete '+parts.join(' and ')+'? Custom APIs cannot be undone.'))return;
  // Delete custom — explicit per-row DELETE
  if(customIds.length&&customApis[iid]){
    customApis[iid]=customApis[iid].filter(a=>!customIds.includes(a.id));
    customIds.forEach(id=>dbDel('/api/apis/'+id));
  }
  // Hide defaults — upsert hidden entries
  if(defaultIds.length){
    if(!hiddenApis[iid])hiddenApis[iid]=[];
    defaultIds.forEach(id=>{if(!hiddenApis[iid].includes(id))hiddenApis[iid].push(id);});
    save();
  }
  // Clear selection + results for deleted
  ids.forEach(id=>{
    sel.delete(id);
    if(results[iid])delete results[iid][id];
  });
  renderMain(); renderSidebar();
}

function restoreHidden(iid){
  hiddenApis[iid]=[];
  dbDel('/api/hidden/'+iid);  // explicit DELETE — clears just this instance's hidden set
  renderMain(); renderSidebar();
}

// ── Reporting ─────────────────────────────────────────────────────────────────
let _rptInstId=null;

function openReport(iid){
  _rptInstId=iid;
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const apis=getApis(inst);
  const r=results[iid]||{};

  // Stats
  const ran=apis.filter(a=>r[a.id]&&r[a.id].status!=='running');
  const passed=ran.filter(a=>r[a.id].status==='success');
  const failed=ran.filter(a=>r[a.id].status==='error');
  const times=ran.map(a=>r[a.id].time||0).filter(t=>t>0);
  const avgTime=times.length?Math.round(times.reduce((s,t)=>s+t,0)/times.length):0;
  const totalTime=times.reduce((s,t)=>s+t,0);

  document.getElementById('rptTitle').textContent='📊 Report — '+inst.name;
  document.getElementById('rptMeta').textContent=new Date().toLocaleString()+' · '+ran.length+' of '+apis.length+' APIs ran';

  // Summary bar
  document.getElementById('rptSummary').innerHTML=
    rptStat(ran.length,'Total Run','var(--text)')+
    rptStat(passed.length,'Passed','var(--green)')+
    rptStat(failed.length,'Failed','var(--red)')+
    rptStat(avgTime+'ms','Avg Time','var(--accent)')+
    rptStat(totalTime+'ms','Total Time','var(--text2)');

  // Table rows
  const tbody=document.getElementById('rptBody');
  tbody.innerHTML='';
  apis.forEach((api,idx)=>{
    const res=r[api.id];
    const tr=document.createElement('tr');
    const ok=res&&res.status==='success';
    const notRan=!res||res.status==='running'||res.status==='pending';
    tr.className=notRan?'':(ok?'rpt-pass':'rpt-fail');

    const statusBadge=notRan
      ?'<span style="color:var(--text3);font-size:12px">—</span>'
      :(ok
        ?'<span style="background:rgba(16,185,129,.15);color:var(--green);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">✓ PASS</span>'
        :'<span style="background:rgba(239,68,68,.15);color:var(--red);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">✕ FAIL</span>');

    const preview=res&&res.body?res.body.slice(0,300):'';
    const previewKey=stash(res&&res.body||'');

    tr.innerHTML=
      '<td style="color:var(--text3);font-size:12px">'+(idx+1)+'</td>'+
      '<td><div style="font-weight:600">'+esc(api.label)+'</div><div style="font-size:11px;font-family:monospace;color:var(--text3);margin-top:2px">'+esc(api.path)+'</div></td>'+
      '<td><span style="font-size:11px;font-weight:700;color:var(--green);background:rgba(16,185,129,.15);padding:2px 7px;border-radius:4px">'+api.method+'</span></td>'+
      '<td>'+statusBadge+'</td>'+
      '<td style="font-family:monospace;font-size:13px;font-weight:600;color:'+(notRan?'var(--text3)':ok?'var(--green)':'var(--red)')+'">'+
        (notRan?'—':(res.code||'Err'))+
      '</td>'+
      '<td style="font-family:monospace;font-size:12px;color:var(--text2)">'+
        (res&&res.time?res.time+'ms':'—')+
      '</td>'+
      '<td>'+
        (preview
          ?'<div class="rpt-preview'+(ok?'':' err-body')+'" title="Click to expand" onclick="this.classList.toggle(\'rpt-expanded\')">'+esc(preview)+(res.body.length>300?'\n…':'')+'</div>'
          :'<span style="color:var(--text3);font-size:12px">—</span>')+
      '</td>';
    tbody.appendChild(tr);
  });

  document.getElementById('reportModal').classList.add('open');
}

function rptStat(val,lbl,color){
  return '<div class="rpt-stat"><div class="rpt-stat-val" style="color:'+color+'">'+val+'</div><div class="rpt-stat-lbl">'+lbl+'</div></div>';
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportReport(fmt){
  const iid=_rptInstId; if(!iid)return;
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const apis=getApis(inst);
  const r=results[iid]||{};
  const ts=new Date().toISOString();

  if(fmt==='json'){
    const data={
      instance:inst.name, url:inst.url, timestamp:ts,
      summary:{total:apis.length,passed:0,failed:0,notRun:0},
      apis:apis.map(api=>{
        const res=r[api.id]||{};
        if(res.status==='success') data&&data.summary&&data.summary.passed++;
        return {label:api.label,method:api.method,path:api.path,status:res.status||'pending',httpCode:res.code,timeMs:res.time,response:res.body};
      })
    };
    // recalculate summary properly
    data.summary.passed=data.apis.filter(a=>a.status==='success').length;
    data.summary.failed=data.apis.filter(a=>a.status==='error').length;
    data.summary.notRun=data.apis.filter(a=>!a.status||a.status==='pending'||a.status==='running').length;
    dl(JSON.stringify(data,null,2),'application/json','cerf-report-'+inst.name+'-'+ts.slice(0,10)+'.json');
    return;
  }

  if(fmt==='csv'){
    const rows=[['#','Label','Method','Path','Status','HTTP Code','Time (ms)','Response Preview']];
    apis.forEach((api,i)=>{
      const res=r[api.id]||{};
      rows.push([
        i+1, api.label, api.method, api.path,
        res.status||'pending', res.code||'', res.time||'',
        (res.body||'').replace(/[\r\n]+/g,' ').slice(0,200)
      ]);
    });
    const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
    dl(csv,'text/csv','cerf-report-'+inst.name+'-'+ts.slice(0,10)+'.csv');
    return;
  }

  if(fmt==='html'){
    const passed=apis.filter(a=>r[a.id]&&r[a.id].status==='success').length;
    const failed=apis.filter(a=>r[a.id]&&r[a.id].status==='error').length;
    const rows=apis.map((api,i)=>{
      const res=r[api.id]||{};
      const ok=res.status==='success';
      const notRan=!res.status||res.status==='pending'||res.status==='running';
      const bg=notRan?'':ok?'#0d2b1e':'#2b0d0d';
      const badge=notRan?'<span style="color:#888">—</span>'
        :(ok?'<span style="background:#0a3b22;color:#10b981;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">✓ PASS</span>'
            :'<span style="background:#3b0a0a;color:#ef4444;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">✕ FAIL</span>');
      return `<tr style="background:${bg}">
        <td style="color:#666;font-size:12px;padding:10px 14px">${i+1}</td>
        <td style="padding:10px 14px"><div style="font-weight:600;color:#e2e8f0">${api.label}</div><div style="font-size:11px;font-family:monospace;color:#64748b;margin-top:3px">${api.path}</div></td>
        <td style="padding:10px 14px"><span style="font-size:11px;font-weight:700;color:#10b981;background:rgba(16,185,129,.15);padding:2px 7px;border-radius:4px">${api.method}</span></td>
        <td style="padding:10px 14px">${badge}</td>
        <td style="padding:10px 14px;font-family:monospace;font-weight:700;color:${notRan?'#666':ok?'#10b981':'#ef4444'}">${notRan?'—':(res.code||'Err')}</td>
        <td style="padding:10px 14px;font-family:monospace;font-size:12px;color:#94a3b8">${res.time?res.time+'ms':'—'}</td>
        <td style="padding:10px 14px"><pre style="font-size:11px;color:${ok?'#94a3b8':'#f87171'};background:#0f1117;border-radius:4px;padding:6px 8px;max-height:80px;overflow:hidden;white-space:pre-wrap;word-break:break-all;margin:0">${(res.body||'').slice(0,300)}</pre></td>
      </tr>`;
    }).join('');

    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>CERF SMS Report — ${inst.name}</title>
<style>
body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;margin:0;padding:24px}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
.meta{color:#64748b;font-size:13px;margin-bottom:20px}
.stats{display:flex;gap:0;background:#1a1d27;border:1px solid #2e3352;border-radius:8px;overflow:hidden;margin-bottom:20px;width:fit-content}
.stat{padding:14px 24px;text-align:center;border-right:1px solid #2e3352}
.stat:last-child{border-right:none}
.stat-val{font-size:24px;font-weight:800}
.stat-lbl{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#1a1d27;border:1px solid #2e3352;border-radius:8px;overflow:hidden}
th{background:#21263a;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#64748b;border-bottom:1px solid #2e3352}
td{border-bottom:1px solid #2e3352}
tr:last-child td{border-bottom:none}
</style></head><body>
<h1>📊 CERF SMS Sanity Report</h1>
<div class="meta">${inst.name} · ${inst.url} · ${new Date().toLocaleString()}</div>
<div class="stats">
  <div class="stat"><div class="stat-val" style="color:#e2e8f0">${apis.length}</div><div class="stat-lbl">Total APIs</div></div>
  <div class="stat"><div class="stat-val" style="color:#10b981">${passed}</div><div class="stat-lbl">Passed</div></div>
  <div class="stat"><div class="stat-val" style="color:#ef4444">${failed}</div><div class="stat-lbl">Failed</div></div>
  <div class="stat"><div class="stat-val" style="color:#4f6ef7">${apis.length-passed-failed}</div><div class="stat-lbl">Not Run</div></div>
</div>
<table><thead><tr><th>#</th><th>API</th><th>Method</th><th>Status</th><th>HTTP</th><th>Time</th><th>Response Preview</th></tr></thead>
<tbody>${rows}</tbody></table>
<div style="margin-top:16px;font-size:11px;color:#475569;text-align:center">Generated by CERF SMS Sanity Runner · ${ts}</div>
</body></html>`;
    dl(html,'text/html','cerf-report-'+inst.name+'-'+ts.slice(0,10)+'.html');
  }
}

function dl(content,type,filename){
  const b=new Blob([content],{type});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=filename;a.click();
}

// ── Variable management ───────────────────────────────────────────────────────
function getVarEntries(iid){ return Object.entries(instVars[iid]||{}); }

function addVar(iid){
  if(!instVars[iid])instVars[iid]={};
  // Add a blank entry with unique placeholder key
  let k='variable'+(Object.keys(instVars[iid]).length+1);
  while(instVars[iid].hasOwnProperty(k)) k+='_';
  instVars[iid][k]='';
  save();
  // Re-render just the vars panel in place (avoid full re-render to keep open state)
  const panel=document.getElementById('varsPanel_'+iid);
  if(panel){
    const tmp=document.createElement('div'); tmp.innerHTML=buildVarsPanel(iid);
    panel.replaceWith(tmp.firstChild);
    // keep body open
    const body=document.getElementById('varsbody_'+iid);
    if(body)body.style.display='block';
    const chev=document.getElementById('vchev_'+iid);
    if(chev)chev.classList.add('open');
  }
}

function updateVar(iid,idx,field,val){
  if(!instVars[iid])return;
  const entries=Object.entries(instVars[iid]);
  if(idx>=entries.length)return;
  if(field==='key'){
    const oldKey=entries[idx][0];
    if(oldKey===val)return;
    // rename: delete old key explicitly, then upsert new key via save()
    const newVars={};
    entries.forEach(([k,v],i)=>{ newVars[i===idx?val:k]=v; });
    instVars[iid]=newVars;
    dbDel('/api/vars/'+iid+'/'+encodeURIComponent(oldKey));
  } else {
    instVars[iid][entries[idx][0]]=val;
  }
  save();
}

function deleteVar(iid,idx){
  if(!instVars[iid])return;
  const entries=Object.entries(instVars[iid]);
  if(idx>=entries.length)return;
  const key=entries[idx][0];
  delete instVars[iid][key];
  dbDel('/api/vars/'+iid+'/'+encodeURIComponent(key));  // explicit DELETE
  const panel=document.getElementById('varsPanel_'+iid);
  if(panel){
    const tmp=document.createElement('div'); tmp.innerHTML=buildVarsPanel(iid);
    panel.replaceWith(tmp.firstChild);
    const body=document.getElementById('varsbody_'+iid);
    if(body)body.style.display='block';
    const chev=document.getElementById('vchev_'+iid);
    if(chev)chev.classList.add('open');
  }
}

function clearVars(iid){
  if(!confirm('Clear all variables for this instance?'))return;
  instVars[iid]={};
  dbDel('/api/vars/'+iid);  // explicit DELETE — wipes only this instance's vars
  const panel=document.getElementById('varsPanel_'+iid);
  if(panel){
    const tmp=document.createElement('div'); tmp.innerHTML=buildVarsPanel(iid);
    panel.replaceWith(tmp.firstChild);
  }
}

function toggleVarsPanel(iid){
  const body=document.getElementById('varsbody_'+iid);
  const chev=document.getElementById('vchev_'+iid);
  if(!body)return;
  const open=body.style.display!=='block';
  body.style.display=open?'block':'none';
  if(chev)chev.classList.toggle('open',open);
}

// ── cURL ──────────────────────────────────────────────────────────────────────
function buildCurl(api,payloadStr){
  let p; try{p=JSON.parse(payloadStr);}catch(e){p=payloadStr;}
  const hs=Object.entries(api.headers).map(([k,v])=>"  --header '"+k+": "+v+"'").join(' \\\n');
  return "curl --location '"+api.url+"' \\\n"+hs+" \\\n  --data '"+JSON.stringify(p,null,2)+"'";
}

function copyStash(key,btn){
  const text=get(key)||'';
  navigator.clipboard.writeText(text).then(()=>{const o=btn.textContent;btn.textContent='✓ Copied!';setTimeout(()=>btn.textContent=o,1500);}).catch(()=>prompt('Copy:',text));
}

function copyAllCurls(iid){
  const inst=instances.find(i=>i.id===iid); if(!inst)return;
  const all=getApis(inst).map(a=>'# '+a.label+' — '+a.path+'\n'+buildCurl(a,getPayload(iid,a))).join('\n\n'+'─'.repeat(55)+'\n\n');
  navigator.clipboard.writeText(all).then(()=>alert('All cURL commands copied!')).catch(()=>prompt('Copy:',all));
}

// ── Collection Import ─────────────────────────────────────────────────────────
let _colParsed = [];   // [{ label, method, path, payload, folder }]

function openColModal(preChannel){
  if(!activeId){alert('Select an instance first.');return;}
  document.getElementById('colJson').value='';
  colClearPreview();
  setChannelPicker('col-ch-row', preChannel||'sms');
  document.getElementById('colModal').classList.add('open');
}

// Drag & drop
function colDragOver(e){e.preventDefault();document.getElementById('colDrop').classList.add('drag');}
function colDragLeave(e){document.getElementById('colDrop').classList.remove('drag');}
function colDrop(e){
  e.preventDefault();
  document.getElementById('colDrop').classList.remove('drag');
  const file=e.dataTransfer.files[0];
  if(file) readColFile(file);
}
function colFileChosen(e){const f=e.target.files[0];if(f)readColFile(f);e.target.value='';}
function readColFile(file){
  const r=new FileReader();
  r.onload=ev=>{document.getElementById('colJson').value=ev.target.result;parseCollection();};
  r.readAsText(file);
}
function colClearPreview(){
  _colParsed=[];
  document.getElementById('colPreviewWrap').style.display='none';
  document.getElementById('colImportBtn').style.display='none';
  document.getElementById('colInfo').style.display='none';
}

// ── Postman / OpenAPI parser ──────────────────────────────────────────────────
function parseCollection(){
  const raw=document.getElementById('colJson').value.trim();
  const info=document.getElementById('colInfo');
  info.style.display='none';
  colClearPreview();
  if(!raw){info.textContent='Paste collection JSON first.';info.style.color='var(--red)';info.style.display='block';return;}
  let json;
  try{json=JSON.parse(raw);}catch(e){info.textContent='✕ Invalid JSON: '+e.message;info.style.color='var(--red)';info.style.display='block';return;}

  let apis=[];
  // Detect format
  if(json.item){
    // Postman collection v2.0 / v2.1
    apis=parsePostman(json.item,'');
  } else if(json.paths){
    // OpenAPI 3.x / Swagger 2.x
    apis=parseOpenApi(json);
  } else if(Array.isArray(json)){
    // Array of requests (simple format)
    json.forEach(r=>{
      if(r.method&&(r.path||r.url)) apis.push({label:r.name||r.path||r.url,method:(r.method||'POST').toUpperCase(),path:extractPath(r.url||r.path),payload:r.body||r.data||{}});
    });
  } else {
    info.textContent='✕ Unrecognised format. Supports Postman v2.0/v2.1 and OpenAPI 3.0.';info.style.color='var(--red)';info.style.display='block';return;
  }

  if(!apis.length){info.textContent='✕ No API requests found in this collection.';info.style.color='var(--red)';info.style.display='block';return;}
  _colParsed=apis;
  renderColPreview();
  info.textContent='✓ Found '+apis.length+' API'+(apis.length>1?'s':'')+'.';
  info.style.color='var(--green)';
  info.style.display='block';
}

function parsePostman(items,folder){
  let out=[];
  (items||[]).forEach(item=>{
    if(item.item){
      // Folder — recurse
      out=out.concat(parsePostman(item.item,folder?(folder+' / '+item.name):item.name));
    } else if(item.request){
      const req=item.request;
      const method=(req.method||'POST').toUpperCase();
      // URL
      let url='';
      if(typeof req.url==='string') url=req.url;
      else if(req.url&&req.url.raw) url=req.url.raw;
      const path=extractPath(url);
      // Body
      let payload={};
      if(req.body){
        const b=req.body;
        if(b.mode==='raw'&&b.raw){try{payload=JSON.parse(b.raw);}catch(e){payload=b.raw;}}
        else if(b.mode==='urlencoded'&&b.urlencoded){b.urlencoded.forEach(p=>{payload[p.key]=p.value;});}
        else if(b.mode==='formdata'&&b.formdata){b.formdata.forEach(p=>{payload[p.key]=p.value;});}
      }
      out.push({label:item.name||path,method,path,payload,folder});
    }
  });
  return out;
}

function parseOpenApi(json){
  const out=[];
  const base=json.basePath||'';
  const paths=json.paths||{};
  Object.entries(paths).forEach(([path,methods])=>{
    Object.entries(methods).forEach(([method,op])=>{
      if(['get','post','put','patch','delete','head','options'].includes(method)){
        let payload={};
        // Try to extract example from requestBody (OAS3) or body params (Swagger2)
        if(op.requestBody){
          const content=op.requestBody.content||{};
          const jsonContent=content['application/json']||content['*/*']||Object.values(content)[0];
          if(jsonContent){
            if(jsonContent.example) payload=jsonContent.example;
            else if(jsonContent.schema&&jsonContent.schema.example) payload=jsonContent.schema.example;
          }
        }
        const label=(op.summary||op.operationId||path);
        out.push({label,method:method.toUpperCase(),path:base+path,payload,folder:op.tags&&op.tags[0]||''});
      }
    });
  });
  return out;
}

function extractPath(url){
  if(!url) return '/';
  try{
    const u=new URL(url.replace(/\{\{[^}]+\}\}/g,'placeholder'));
    return u.pathname+(u.search||'');
  }catch(e){
    // Maybe it's already a path or has template variables
    const noProto=url.replace(/^https?:\/\/[^/]+/,'').replace(/\{\{[^}]+\}\}/g,'placeholder');
    return noProto||'/';
  }
}

// ── Preview list ──────────────────────────────────────────────────────────────
function renderColPreview(){
  const list=document.getElementById('colPreviewList');
  const wrap=document.getElementById('colPreviewWrap');
  list.innerHTML='';
  let lastFolder=null;
  _colParsed.forEach((api,idx)=>{
    if(api.folder!==lastFolder){
      lastFolder=api.folder;
      if(api.folder){
        const fl=document.createElement('div');
        fl.className='folder-label';
        fl.textContent='📁 '+api.folder;
        list.appendChild(fl);
      }
    }
    const item=document.createElement('div');
    item.className='api-preview-item checked';
    item.dataset.idx=idx;
    const mColor={POST:'var(--green)',GET:'var(--accent)',PUT:'var(--yellow)',PATCH:'var(--yellow)',DELETE:'var(--red)'}[api.method]||'var(--text3)';
    item.innerHTML=
      '<input type="checkbox" checked onchange="colCheckChange()" onclick="event.stopPropagation()">'+
      '<span style="font-size:10px;font-weight:700;color:'+mColor+';flex-shrink:0;min-width:42px">'+api.method+'</span>'+
      '<span class="api-preview-name" title="'+esc(api.label)+'">'+esc(api.label)+'</span>'+
      '<span class="api-preview-path" title="'+esc(api.path)+'">'+esc(api.path)+'</span>';
    item.addEventListener('click',function(e){
      if(e.target.type==='checkbox')return;
      const cb=this.querySelector('input[type=checkbox]');
      cb.checked=!cb.checked;
      this.classList.toggle('checked',cb.checked);
      colCheckChange();
    });
    item.querySelector('input').addEventListener('change',function(){
      item.classList.toggle('checked',this.checked);
    });
    list.appendChild(item);
  });
  wrap.style.display='block';
  document.getElementById('colImportBtn').style.display='inline-flex';
  colCheckChange();
}

function colToggleAll(checked){
  document.querySelectorAll('#colPreviewList .api-preview-item').forEach(item=>{
    const cb=item.querySelector('input[type=checkbox]');
    cb.checked=checked;
    item.classList.toggle('checked',checked);
  });
  colCheckChange();
}

function colCheckChange(){
  const items=document.querySelectorAll('#colPreviewList .api-preview-item');
  const checked=[...items].filter(i=>i.querySelector('input').checked).length;
  document.getElementById('selCount').textContent=checked+' / '+items.length+' selected';
  const allChk=document.getElementById('selAll');
  allChk.checked=checked===items.length;
  allChk.indeterminate=checked>0&&checked<items.length;
}

function importCollection(){
  if(!activeId){alert('Select an instance first.');return;}
  if(!customApis[activeId])customApis[activeId]=[];
  const channel = document.getElementById('col-channel')?.value || 'sms';
  const items=document.querySelectorAll('#colPreviewList .api-preview-item');
  let imported=0;
  items.forEach(item=>{
    if(!item.querySelector('input').checked)return;
    const idx=parseInt(item.dataset.idx);
    const api=_colParsed[idx];
    if(!api)return;
    customApis[activeId].push({id:'c_'+uid(),label:api.label,method:api.method,path:api.path,payload:api.payload,channel});
    imported++;
  });
  save();
  closeModal('colModal');
  colClearPreview();
  renderMain();
  renderSidebar();
  // Small toast feedback
  const toast=document.createElement('div');
  toast.style.cssText='position:fixed;bottom:24px;right:24px;background:var(--green);color:#fff;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13px;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,.4)';
  toast.textContent='✓ '+imported+' API'+(imported>1?'s':'')+' imported!';
  document.body.appendChild(toast);
  setTimeout(()=>toast.remove(),2800);
}

// ── Manual API add ────────────────────────────────────────────────────────────
let _editingCustomId = null;

function openManualModal(editApiId, preChannel){
  if(!activeId){alert('Select an instance first.');return;}
  _editingCustomId = editApiId || null;
  const title = document.getElementById('manualModalTitle');
  const saveBtn = document.getElementById('manualSaveBtn');
  const errBox = document.getElementById('m-error');
  errBox.style.display='none';

  if(editApiId){
    const api=(customApis[activeId]||[]).find(a=>a.id===editApiId);
    if(!api)return;
    title.textContent='✏ Edit API';
    saveBtn.textContent='✓ Save Changes';
    setChannelPicker('m-ch-row', api.channel||'sms');
    document.getElementById('m-label').value=api.label||'';
    document.getElementById('m-method').value=api.method||'POST';
    document.getElementById('m-path').value=api.path||'';
    document.getElementById('m-payload').value=JSON.stringify(api.payload||{},null,2);
  } else {
    title.textContent='➕ Add API Manually';
    saveBtn.textContent='✓ Add API';
    setChannelPicker('m-ch-row', preChannel||'sms');
    document.getElementById('m-label').value='';
    document.getElementById('m-method').value='POST';
    document.getElementById('m-path').value='';
    document.getElementById('m-payload').value='{\n  \n}';
  }
  document.getElementById('manualModal').classList.add('open');
  document.getElementById('m-label').focus();
}

function saveManualApi(){
  const label=document.getElementById('m-label').value.trim();
  const method=document.getElementById('m-method').value;
  const path=document.getElementById('m-path').value.trim();
  const payStr=document.getElementById('m-payload').value.trim();
  const errBox=document.getElementById('m-error');
  errBox.style.display='none';

  if(!label){errBox.textContent='API Label is required.';errBox.style.display='block';return;}
  if(!path||!path.startsWith('/')){errBox.textContent='Path is required and must start with / (e.g. /api/sms/send).';errBox.style.display='block';return;}
  let payload={};
  if(payStr){try{payload=JSON.parse(payStr);}catch(e){errBox.textContent='Invalid JSON in request body: '+e.message;errBox.style.display='block';return;}}

  const channel = document.getElementById('m-channel')?.value || 'sms';
  if(!customApis[activeId])customApis[activeId]=[];

  if(_editingCustomId){
    const idx=customApis[activeId].findIndex(a=>a.id===_editingCustomId);
    if(idx>-1) customApis[activeId][idx]={...customApis[activeId][idx],label,method,path,payload,channel};
  } else {
    customApis[activeId].push({id:'c_'+uid(),label,method,path,payload,channel});
  }
  save(); closeModal('manualModal'); _editingCustomId=null;
  renderMain(); renderSidebar();
}

// ── cURL Parser ───────────────────────────────────────────────────────────────
function parseCurl(raw){
  const s=raw.replace(/\\\n\s*/g,' ').trim();
  // URL
  let um=s.match(/--location\s+['"]([^'"]+)['"]/)||s.match(/curl\s+['"]([^'"]+)['"]/)||s.match(/curl\s+(https?:\/\/\S+)/);
  if(!um) throw new Error('Could not find URL.');
  const fullUrl=um[1];
  // Method
  const mm=s.match(/-X\s+(\w+)/i);
  const method=mm?mm[1].toUpperCase():(s.includes('--data')?'POST':'GET');
  // Body — try multiple patterns
  let bodyStr=null;
  const dq=s.match(/--data(?:-raw)?\s+"((?:[^"\\]|\\.)*)"/);
  const sq=s.match(/--data(?:-raw)?\s+'((?:[^'\\]|\\.)*)'/);
  if(dq) bodyStr=dq[1].replace(/\\"/g,'"');
  else if(sq) bodyStr=sq[1];
  let body={};
  if(bodyStr){try{body=JSON.parse(bodyStr);}catch(e){body=bodyStr;}}
  // Path
  const u=new URL(fullUrl);
  const path=u.pathname+(u.search||'');
  return {fullUrl,path,method,body};
}

function parseCurlPreview(){
  const raw=document.getElementById('c-curl').value.trim();
  const ok=document.getElementById('curlOk'), er=document.getElementById('curlErr');
  ok.classList.remove('show'); er.classList.remove('show');
  if(!raw){er.textContent='Paste a cURL command first.';er.classList.add('show');return;}
  try{
    _parsedCurl=parseCurl(raw);
    ok.textContent='✓ Parsed\n  Method : '+_parsedCurl.method+'\n  Path   : '+_parsedCurl.path+'\n  Body   : '+JSON.stringify(_parsedCurl.body,null,2).slice(0,200);
    ok.classList.add('show');
  }catch(e){_parsedCurl=null;er.textContent='✕ '+e.message;er.classList.add('show');}
}

function clearCurlParse(){_parsedCurl=null;document.getElementById('curlOk').classList.remove('show');document.getElementById('curlErr').classList.remove('show');}

function addApiFromCurl(){
  const label=document.getElementById('c-label').value.trim()||'Custom API';
  const channel=document.getElementById('c-channel')?.value||'sms';
  const raw=document.getElementById('c-curl').value.trim();
  if(!raw){alert('Paste a cURL command first.');return;}
  if(!_parsedCurl){try{_parsedCurl=parseCurl(raw);}catch(e){alert('Parse error: '+e.message);return;}}
  if(!activeId){alert('Select an instance first.');return;}
  if(!customApis[activeId])customApis[activeId]=[];
  customApis[activeId].push({id:'c_'+uid(),label,method:_parsedCurl.method,path:_parsedCurl.path,payload:_parsedCurl.body,channel});
  save(); closeModal('curlModal'); _parsedCurl=null;
  renderMain(); renderSidebar();
}

function delCustomApi(iid,aid,e){
  e.stopPropagation();
  if(!confirm('Remove this custom API?'))return;
  if(customApis[iid])customApis[iid]=customApis[iid].filter(a=>a.id!==aid);
  if(results[iid])delete results[iid][aid];
  dbDel('/api/apis/'+aid);  // explicit DELETE
  renderMain(); renderSidebar();
}

// ── Instance CRUD ─────────────────────────────────────────────────────────────
function openInstModal(){
  editId=null;
  document.getElementById('instModalTitle').textContent='Add Instance';
  document.getElementById('f-name').value='';
  document.getElementById('f-url').value='https://';
  document.getElementById('f-token').value='';
  document.getElementById('f-cookie').value='';
  document.getElementById('instSaveBtn').textContent='Add Instance';
  document.getElementById('instModal').classList.add('open');
  document.getElementById('f-name').focus();
}

function openEditModal(id){
  const inst=instances.find(i=>i.id===id); if(!inst)return;
  editId=id;
  document.getElementById('instModalTitle').textContent='Edit Instance';
  document.getElementById('f-name').value=inst.name;
  document.getElementById('f-url').value=inst.url;
  document.getElementById('f-token').value=inst.token;
  document.getElementById('f-cookie').value=inst.cookie||'';
  document.getElementById('instSaveBtn').textContent='Save Changes';
  document.getElementById('instModal').classList.add('open');
}

function saveInst(){
  const name=document.getElementById('f-name').value.trim();
  const url=document.getElementById('f-url').value.trim().replace(/\/$/,'');
  const token=document.getElementById('f-token').value.trim();
  const cookie=document.getElementById('f-cookie').value.trim();
  if(!name||!url){alert('Name and URL required.');return;}
  if(editId){const i=instances.find(x=>x.id===editId);if(i){i.name=name;i.url=url;i.token=token;i.cookie=cookie;}}
  else instances.push({id:uid(),name,url,token,cookie});
  save(); closeModal('instModal'); renderSidebar();
  if(activeId===editId||!editId)renderMain();
}

function deleteInst(id){
  const inst=instances.find(i=>i.id===id);
  if(!inst||!confirm('Delete "'+inst.name+'"?'))return;
  instances=instances.filter(i=>i.id!==id);
  if(activeId===id)activeId=null;
  dbDel('/api/instances/'+id);  // cascades: custom_apis, inst_vars, hidden_apis, api_payloads
  renderSidebar(); renderMain();
}

function openCurlModal(preChannel){
  if(!activeId){alert('Select an instance first.');return;}
  document.getElementById('c-label').value='';
  document.getElementById('c-curl').value='';
  clearCurlParse();
  setChannelPicker('c-ch-row', preChannel||'sms');
  document.getElementById('curlModal').classList.add('open');
  document.getElementById('c-label').focus();
}

function closeModal(id){document.getElementById(id).classList.remove('open');}

// Close on overlay click
document.querySelectorAll('.overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.overlay.open').forEach(m=>m.classList.remove('open'));});

// ── Export / Import ───────────────────────────────────────────────────────────
function _exportCfg(){
  const b=new Blob([JSON.stringify({instances,payloads,customApis,instVars,hiddenApis},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='cerf-sanity-config.json';a.click();
}
function _importCfg(e){
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const d=JSON.parse(ev.target.result);
      if(d.instances)instances=d.instances;
      if(d.payloads)payloads=d.payloads;
      if(d.customApis)customApis=d.customApis;
      if(d.instVars)instVars=d.instVars;
      if(d.hiddenApis)hiddenApis=d.hiddenApis;
      save();renderSidebar();renderMain();alert('Imported!');
    }catch(er){alert('Invalid config file.');}
  };
  r.readAsText(f);e.target.value='';
}

// ── Escape helpers ────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init(){
  wireChannelPickers();
  document.getElementById('main').innerHTML=
    '<div class="empty"><div class="empty-icon" style="font-size:40px">🗄</div><h3>Loading…</h3><p style="color:var(--text3);font-size:13px">Fetching data from server</p></div>';
  document.getElementById('instList').innerHTML=
    '<div style="padding:16px;color:var(--text3);font-size:13px;text-align:center">Loading…</div>';

  await load();

  renderSidebar();
  if(instances.length>0) selectInst(instances[0].id);
  else renderMain();

  startPolling();   // sync changes from other users every 5 s
})();
