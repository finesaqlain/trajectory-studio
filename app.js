const STORAGE_KEY='trajectory-editor-workspace-v1';
const DRAFT_KEY='trajectory-editor-drafts-v1';
const THEME_KEY='trajectory-editor-theme';
const state={original:[],edited:[],editedBaseline:[],cellBaselines:[],originIndexes:[],drafts:{},selected:0,editedSelected:null,query:'',filter:'all',editedQuery:'',editedFilter:'all',originalDoc:null,editedDoc:null,expanded:new Set(),rawCards:new Set(),editedExpanded:new Set(),changeCursor:-1,copiedKey:null,originalName:'',editedName:''};
const $=id=>document.getElementById(id);

function normalizeDocument(parsed){
  if(parsed && !Array.isArray(parsed) && Array.isArray(parsed.steps)){
    const events=[];
    parsed.steps.forEach(step=>{
      if(step && typeof step==='object') Object.values(step).forEach(event=>{
        if(event && typeof event==='object') events.push(event);
      });
    });
    if(!events.length) throw new Error('This trajectory contains no readable steps.');
    return {events,document:parsed,format:'wrapped'};
  }
  return {events:Array.isArray(parsed)?parsed:[parsed],document:parsed,format:Array.isArray(parsed)?'array':'single'};
}

function parseTrajectory(text){
  const trimmed=text.trim();
  if(!trimmed) throw new Error('The selected file is empty.');
  try{
    const parsed=JSON.parse(trimmed);
    return normalizeDocument(parsed);
  }catch(firstError){
    const values=[];let start=0,depth=0,inString=false,escaped=false;
    for(let i=0;i<trimmed.length;i++){
      const ch=trimmed[i];
      if(inString){if(escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch==='"') inString=false;continue;}
      if(ch==='"'){inString=true;continue} if(ch==='{'||ch==='[') depth++; if(ch==='}'||ch===']') depth--;
      if(depth===0&&(ch==='}'||ch===']')){const piece=trimmed.slice(start,i+1).trim();if(piece) values.push(JSON.parse(piece));start=i+1;}
    }
    if(trimmed.slice(start).trim()||!values.length) throw new Error('Invalid JSON or JSONL trajectory.');
    return {events:values.flatMap(v=>Array.isArray(v)?v:[v]),document:values,format:'stream'};
  }
}

function labelFor(event,index){
  const p=event?.payload||{}; const role=p.role;
  if(event?.type==='session_meta') return 'Session Metadata';
  if(p.type==='message'&&role) return `${title(role)} Message`;
  if(p.type==='custom_tool_call')return 'Tool Call';
  if(event?.type==='response_item'&&p.type) return human(p.type);
  if(event?.type==='event_msg'&&p.type) return human(p.type);
  return human(event?.type||`Event ${index+1}`);
}
function human(s){return String(s).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}
function title(s){return String(s).charAt(0).toUpperCase()+String(s).slice(1)}
function roleFor(e){return e?.payload?.role||e?.payload?.type||e?.type||'unknown'}
function contentFor(e){
  const p=e?.payload||{};
  if(Array.isArray(p.content)) return p.content.map(x=>x?.text??x?.content??JSON.stringify(x)).join('\n');
  if(p.type==='custom_tool_call'&&typeof p.input==='string')return p.input;
  if(typeof p.text==='string') return p.text;
  if(typeof p.message==='string') return p.message;
  if(e?.type==='session_meta'&&p.cwd) return `${p.cwd} / ${p.cli_version||''} / ${p.model_provider||''}`;
  return pretty(p);
}
function updateStructuredContent(event,text){
  const p=event?.payload||{};
  if(Array.isArray(p.content)){
    const item=p.content.find(x=>x&&typeof x.text==='string')||p.content.find(x=>x&&typeof x.content==='string');
    if(!item)throw new Error('This event has no editable text field. Use Raw JSON instead.');
    if(typeof item.text==='string')item.text=text;else item.content=text;return;
  }
  if(typeof p.text==='string'){p.text=text;return}
  if(typeof p.message==='string'){p.message=text;return}
  if(p.type==='custom_tool_call'&&typeof p.input==='string'){p.input=text;return}
  try{event.payload=JSON.parse(text);return}catch{}
  throw new Error('This structured preview is derived from multiple fields. Use Raw JSON to edit it.');
}
function timeFor(e){const d=new Date(e?.timestamp);return isNaN(d)?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function pretty(v){return JSON.stringify(v,null,2)}
function compact(v){return JSON.stringify(v)}
function isChanged(i){const originalIndex=state.originIndexes[i]??null;return originalIndex===null||!state.original[originalIndex]||compact(state.edited[i])!==compact(state.original[originalIndex])}
function changedCount(){return state.edited.reduce((count,event,i)=>count+(isChanged(i)?1:0),0)}
function dirtyIndexes(){return Object.keys(state.drafts).map(Number).filter(i=>state.drafts[i]&&i<state.edited.length).sort((a,b)=>a-b)}
function baselineText(i,mode){const event=state.cellBaselines[i]??state.editedBaseline[i]??state.original[i]??state.edited[i];return mode==='raw'?pretty(event):contentFor(event)}
function highlightedSegment(text,baseline){
  if(text===baseline)return esc(text);
  let start=0;while(start<text.length&&start<baseline.length&&text[start]===baseline[start])start++;
  let endText=text.length-1,endBase=baseline.length-1;while(endText>=start&&endBase>=start&&text[endText]===baseline[endBase]){endText--;endBase--}
  return `${esc(text.slice(0,start))}<mark class="draft-insert">${esc(text.slice(start,endText+1))}</mark>${esc(text.slice(endText+1))}`;
}
function highlightedDraft(text,baseline){
  if(text===baseline)return esc(text);
  const currentLines=text.split('\n'),baselineLines=baseline.split('\n');
  if(currentLines.length===baselineLines.length)return currentLines.map((line,i)=>highlightedSegment(line,baselineLines[i])).join('\n');
  return highlightedSegment(text,baseline);
}
function caretOffset(element){
  const selection=getSelection();if(!selection?.rangeCount)return null;const range=selection.getRangeAt(0);if(!element.contains(range.startContainer))return null;
  const before=range.cloneRange();before.selectNodeContents(element);before.setEnd(range.startContainer,range.startOffset);return before.toString().length;
}
function restoreCaret(element,offset){
  if(offset===null)return;const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node,remaining=offset;
  while((node=walker.nextNode())){if(remaining<=node.data.length){const range=document.createRange();range.setStart(node,remaining);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return}remaining-=node.data.length}
}
function showDraftHighlight(view,text,baseline,preserveCaret=false){const offset=preserveCaret?caretOffset(view):null;view.innerHTML=highlightedDraft(text,baseline);if(preserveCaret)restoreCaret(view,offset)}
async function copyText(text){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true}}catch{}
  const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.left='-9999px';area.style.top='0';document.body.appendChild(area);
  try{area.focus();area.select();area.setSelectionRange(0,area.value.length);return document.execCommand('copy')}
  catch{return false}finally{area.remove()}
}
function copyButtonContent(key,label){return state.copiedKey===key?'<span class="copy-icon copied">✓</span> Copied':`<span class="copy-icon">⧉</span> ${label}`}
function copiedFeedback(button,label,key){
  document.querySelectorAll('.copy-cell.copied-state,.copy-structured.copied-state').forEach(previous=>{previous.innerHTML=`<span class="copy-icon">⧉</span> ${previous.dataset.copyLabel}`;previous.classList.remove('copied-state')});
  state.copiedKey=key;button.innerHTML='<span class="copy-icon copied">✓</span> Copied';button.classList.add('copied-state');button.dataset.copyLabel=label;
}
function setEditedActionState(){const disabled=!state.edited.length;$('addAssistant').disabled=disabled;$('addToolCall').disabled=disabled;$('resetAllEdited').disabled=disabled}
function manualId(prefix){return `${prefix}_${globalThis.crypto?.randomUUID?.()||Date.now().toString(36)}`}
function newEditableEvent(kind){
  const timestamp=new Date().toISOString();
  if(kind==='assistant')return {timestamp,type:'response_item',payload:{type:'message',id:manualId('msg'),role:'assistant',content:[{type:'output_text',text:''}]}};
  return {timestamp,type:'response_item',payload:{type:'custom_tool_call',id:manualId('call'),status:'completed',call_id:manualId('manual'),name:'exec',input:'{}'}};
}
function remapCellState(mapper){
  const drafts={};Object.entries(state.drafts).forEach(([key,value])=>{const next=mapper(Number(key));if(next!==null)drafts[next]=value});state.drafts=drafts;
  state.editedExpanded=new Set([...state.editedExpanded].map(mapper).filter(i=>i!==null));
  if(state.copiedKey){const [kind,index]=state.copiedKey.split(':'),next=mapper(Number(index));state.copiedKey=next===null?null:`${kind}:${next}`}
}
function addEditableCell(kind){
  if(!state.edited.length)return;clearEditedFilters();const index=state.editedSelected===null?state.edited.length:Math.min(state.edited.length,state.editedSelected+1),cell=newEditableEvent(kind);
  remapCellState(i=>i>=index?i+1:i);state.edited.splice(index,0,cell);state.cellBaselines.splice(index,0,JSON.parse(JSON.stringify(cell)));state.originIndexes.splice(index,0,null);state.editedSelected=index;state.editedExpanded.add(index);saveDrafts();saveWorkspace();renderEdited();
  requestAnimationFrame(()=>{const cell=document.querySelector(`#editedArea [data-edit-index="${index}"]`);cell?.scrollIntoView({behavior:'smooth',block:'start'})});toast(`${kind==='assistant'?'Assistant':'Tool Call'} cell added`);
}
async function deleteEditableCell(index){
  if(!await askConfirmation(`Delete event ${index+1} from the edited trajectory?`))return;
  state.edited.splice(index,1);state.cellBaselines.splice(index,1);state.originIndexes.splice(index,1);remapCellState(i=>i===index?null:i>index?i-1:i);
  if(state.editedSelected===index)state.editedSelected=null;else if(state.editedSelected>index)state.editedSelected--;
  saveDrafts();saveWorkspace();renderEdited();toast(`Event ${index+1} deleted`);
}
function askConfirmation(message){
  const dialog=$('confirmDialog');$('confirmMessage').textContent=message;dialog.showModal();
  return new Promise(resolve=>{
    const finish=value=>{dialog.close();resolve(value)};
    $('confirmYes').onclick=()=>finish(true);$('confirmNo').onclick=()=>finish(false);dialog.oncancel=event=>{event.preventDefault();finish(false)};
  });
}
function saveWorkspace(){
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify({original:state.original,edited:state.edited,editedBaseline:state.editedBaseline,cellBaselines:state.cellBaselines,originIndexes:state.originIndexes,originalDoc:state.originalDoc,editedDoc:state.editedDoc,originalName:state.originalName,editedName:state.editedName}));
  }catch(err){toast('Could not save locally: browser storage is full',true)}
}
function saveDrafts(){try{localStorage.setItem(DRAFT_KEY,JSON.stringify(state.drafts))}catch(err){toast('Could not save draft locally',true)}}
function setTheme(theme){
  const dark=theme==='dark',button=$('themeToggle');document.documentElement.dataset.theme=dark?'dark':'light';
  button.setAttribute('aria-pressed',String(dark));button.setAttribute('aria-label',dark?'Enable light mode':'Enable dark mode');
  button.querySelector('.theme-icon').textContent=dark?'☀':'☾';button.querySelector('.theme-label').textContent=dark?'Light mode':'Dark mode';
  localStorage.setItem(THEME_KEY,dark?'dark':'light');
}
function restoreWorkspace(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(!saved)return;
    state.original=Array.isArray(saved.original)?saved.original:[];state.edited=Array.isArray(saved.edited)?saved.edited:[];
    state.editedBaseline=Array.isArray(saved.editedBaseline)?saved.editedBaseline:JSON.parse(JSON.stringify(state.edited));
    state.cellBaselines=Array.isArray(saved.cellBaselines)?saved.cellBaselines:JSON.parse(JSON.stringify(state.editedBaseline));
    state.originIndexes=Array.isArray(saved.originIndexes)?saved.originIndexes:state.edited.map((_,i)=>i);
    state.drafts=JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}')||{};
    Object.entries(state.drafts).forEach(([key,draft])=>{const i=Number(key);if(!state.edited[i]||draft?.error)return;try{if(draft.mode==='raw')state.edited[i]=JSON.parse(draft.text);else updateStructuredContent(state.edited[i],draft.text)}catch{}});
    state.originalDoc=saved.originalDoc||null;state.editedDoc=saved.editedDoc||null;state.originalName=saved.originalName||'Restored trajectory';state.editedName=saved.editedName||'Restored edited trajectory';
    if(state.original.length){$('originalMeta').textContent=`${state.originalName} / ${state.original.length} events`;$('headerOriginalName').textContent=state.originalName;$('headerOriginalName').title=state.originalName;renderOriginal()}
    if(state.edited.length){$('headerEditedName').textContent=state.editedName;$('headerEditedName').title=state.editedName;renderEdited()}
    $('resetOriginalUpload').disabled=!state.original.length;$('resetEditedUpload').disabled=!state.edited.length;setEditedActionState();
    toast('Saved workspace restored');
  }catch{localStorage.removeItem(STORAGE_KEY)}
}

function eventCard(e,i){
  const role=roleFor(e),content=contentFor(e),expanded=state.expanded.has(i),raw=state.rawCards.has(i),preview=raw?pretty(e):content;
  return `<article class="event-card ${i===state.selected?'active':''} ${expanded?'expanded':''}" data-index="${i}">
  <div class="event-title"><span class="event-icon">${e.type==='session_meta'?'&lt;/&gt;':'▢'}</span><h3>${i+1}. ${esc(labelFor(e,i))}</h3><span class="event-time">${timeFor(e)}</span></div>
  <div class="badges"><span class="badge">${esc(role)}</span><span class="badge">${esc(e.type||'event')}</span><span class="badge success">success</span></div>
  <div class="event-summary">${esc(content.slice(0,240))}</div><pre class="preview">${esc(expanded?preview:preview.slice(0,600))}</pre><div class="card-actions"><button data-action="expand">${expanded?'Collapse':'Expand'}</button><button data-action="raw">${raw?'◀ View Content':'▶ View Raw'}</button></div></article>`;
}

function renderOriginal(){
  const roles=[...new Set(state.original.map(roleFor))].sort();
  $('roleFilter').innerHTML='<option value="all">all</option>'+roles.map(r=>`<option ${r===state.filter?'selected':''} value="${esc(r)}">${esc(r)}</option>`).join('');
  const entries=state.original.map((e,i)=>({e,i})).filter(({e})=>(state.filter==='all'||roleFor(e)===state.filter)&&(!state.query||JSON.stringify(e).toLowerCase().includes(state.query)));
  $('originalList').className='event-list'+(entries.length?'':' empty-state');
  $('originalList').innerHTML=entries.length?entries.map(({e,i})=>eventCard(e,i)).join(''):'<div class="empty-icon">⌕</div><strong>No matching events</strong><span>Try another search or filter</span>';
  document.querySelectorAll('.event-card').forEach(card=>{
    card.onclick=()=>{
      state.selected=Number(card.dataset.index);renderOriginal();
      document.querySelectorAll('#editedArea .event-editor').forEach(cell=>cell.classList.toggle('selected',Number(cell.dataset.editIndex)===state.selected));
    };
    card.querySelectorAll('[data-action]').forEach(button=>button.onclick=event=>{
      event.stopPropagation();const i=Number(card.dataset.index),set=button.dataset.action==='expand'?state.expanded:state.rawCards;
      set.has(i)?set.delete(i):set.add(i);renderOriginal();
    });
  });
}
function editorBlock(e,i,editable=false){
  const changed=editable&&isChanged(i);
  const draft=editable?state.drafts[i]:null,mode=draft?.mode||'structured',value=draft?.text??(mode==='raw'?pretty(e):contentFor(e)),dirty=!!draft;
  const open=!editable||changed||dirty||state.editedExpanded.has(i);
  const rendered=dirty?highlightedDraft(value,baselineText(i,mode)):esc(value);
  return `<article class="event-editor ${i===state.selected?'selected':''} ${i===state.editedSelected?'edit-selected':''} ${changed?'changed':''} ${dirty?'dirty':''} ${editable&&!open?'collapsed':''}" data-edit-index="${i}" data-mode="${mode}"><div class="editor-head"><div class="editor-title-row"><div><h3>${i+1}. ${esc(labelFor(e,i))}</h3><p>${esc(roleFor(e))} / ${mode} ${editable?'editable':'readonly'}</p></div>${editable?`<div class="cell-tools">${dirty?'<span class="dirty-badge">Dirty</span>':''}${changed?'<span class="changed-badge">Changed</span>':''}<button class="reset-cell button ghost" type="button">Reset Section</button><button class="delete-cell button danger-button" type="button">Delete</button><button class="expand-cell button ghost" type="button" ${changed||dirty?'disabled':''}>${changed||dirty?'Expanded':open?'Collapse':'Expand'}</button><button class="copy-structured button ghost ${state.copiedKey===`structured:${i}`?'copied-state':''}" data-copy-label="Structured" type="button">${copyButtonContent(`structured:${i}`,'Structured')}</button><button class="copy-cell button ghost ${state.copiedKey===`json:${i}`?'copied-state':''}" data-copy-label="JSON" type="button">${copyButtonContent(`json:${i}`,'JSON')}</button></div>`:''}</div><div class="tabs"><button class="tab ${mode==='structured'?'active':''}" data-mode="structured">Structured</button><button class="tab ${mode==='raw'?'active':''}" data-mode="raw">Raw JSON</button></div></div><div class="error" ${draft?.error?'':'hidden'}>${esc(draft?.error||'')}</div><pre class="code-view" ${editable?'contenteditable="true" spellcheck="false"':''}>${rendered}</pre></article>`
}
function bindTabs(scope,editable=false){
  scope.querySelectorAll('.event-editor').forEach(block=>{
    const idx=Number(block.dataset.editIndex),view=block.querySelector('.code-view'),tabs=block.querySelectorAll('.tab'),error=block.querySelector('.error');
    tabs.forEach(tab=>tab.onclick=()=>{
      tabs.forEach(t=>t.classList.toggle('active',t===tab));block.dataset.mode=tab.dataset.mode;const e=editable?state.edited[idx]:state.original[idx],draft=editable?state.drafts[idx]:null;
      const value=draft?.mode===tab.dataset.mode?draft.text:(tab.dataset.mode==='raw'?pretty(e):contentFor(e));
      if(editable&&draft?.mode===tab.dataset.mode)showDraftHighlight(view,value,baselineText(idx,tab.dataset.mode));else view.textContent=value;
      const message=draft?.mode===tab.dataset.mode?draft.error:'';error.textContent=message||'';error.hidden=!message;
    });
    if(editable){
      block.addEventListener('click',()=>{state.editedSelected=idx;scope.querySelectorAll('.event-editor').forEach(cell=>cell.classList.toggle('edit-selected',Number(cell.dataset.editIndex)===idx))});
      block.querySelector('.copy-cell').onclick=async event=>{const button=event.currentTarget,draft=state.drafts[idx],value=draft?.mode==='raw'?draft.text:pretty(state.edited[idx]),copied=await copyText(value);if(copied){copiedFeedback(button,'JSON',`json:${idx}`);toast(`Event ${idx+1} JSON copied`)}else toast('Clipboard access failed. Allow clipboard permission and try again.',true)};
      block.querySelector('.copy-structured').onclick=async event=>{const button=event.currentTarget,draft=state.drafts[idx],value=draft?.mode==='structured'?draft.text:contentFor(state.edited[idx]),copied=await copyText(value);if(copied){copiedFeedback(button,'Structured',`structured:${idx}`);toast(`Event ${idx+1} structured data copied`)}else toast('Clipboard access failed. Allow clipboard permission and try again.',true)};
      block.querySelector('.reset-cell').onclick=()=>{
        state.edited[idx]=JSON.parse(JSON.stringify(state.cellBaselines[idx]??state.editedBaseline[idx]??state.original[idx]??state.edited[idx]));delete state.drafts[idx];saveDrafts();saveWorkspace();
        const scroll=$('editedArea').scrollTop;renderEdited();$('editedArea').scrollTop=scroll;toast(`Event ${idx+1} reset`);
      };
      block.querySelector('.delete-cell').onclick=event=>{event.stopPropagation();deleteEditableCell(idx)};
      block.querySelector('.expand-cell').onclick=event=>{
        event.stopPropagation();const open=state.editedExpanded.has(idx);open?state.editedExpanded.delete(idx):state.editedExpanded.add(idx);
        block.classList.toggle('collapsed',open);event.currentTarget.textContent=open?'Expand':'Collapse';
      };
      view.addEventListener('input',()=>{
        view.dataset.touched='true';
        const mode=block.dataset.mode,text=view.textContent;let message='';
        try{if(mode==='raw')state.edited[idx]=JSON.parse(text);else updateStructuredContent(state.edited[idx],text)}
        catch(err){message=mode==='raw'?'Raw event must be valid JSON.':err.message}
        state.drafts[idx]={mode,text,error:message};saveDrafts();
        showDraftHighlight(view,text,baselineText(idx,mode),true);
        state.editedExpanded.add(idx);block.classList.remove('collapsed');block.querySelector('.expand-cell').textContent='Expanded';block.querySelector('.expand-cell').disabled=true;
        error.textContent=message;error.hidden=!message;block.classList.add('dirty');
        if(!block.querySelector('.dirty-badge'))block.querySelector('.cell-tools').insertAdjacentHTML('afterbegin','<span class="dirty-badge">Dirty</span>');
        updateEditedMeta();
        clearTimeout(view.saveTimer);view.saveTimer=setTimeout(saveWorkspace,350);
      });
      view.addEventListener('blur',()=>{if(view.dataset.touched!=='true')return;view.dataset.touched='false';try{
        if(block.dataset.mode==='raw'){state.edited[idx]=JSON.parse(view.textContent);view.textContent=pretty(state.edited[idx])}
        else{updateStructuredContent(state.edited[idx],view.textContent);view.textContent=contentFor(state.edited[idx])}
        state.drafts[idx]={mode:block.dataset.mode,text:view.textContent,error:''};saveDrafts();showDraftHighlight(view,view.textContent,baselineText(idx,block.dataset.mode));error.hidden=true;
        const changed=isChanged(idx);block.classList.toggle('changed',changed);
        const tools=block.querySelector('.cell-tools'),badge=tools.querySelector('.changed-badge');
        if(changed&&!badge) tools.insertAdjacentHTML('afterbegin','<span class="changed-badge">Changed</span>');
        if(!changed&&badge) badge.remove();updateEditedMeta();saveWorkspace();
      }catch(err){const message=block.dataset.mode==='raw'?'Raw event must be valid JSON.':err.message;state.drafts[idx]={mode:block.dataset.mode,text:view.textContent,error:message};saveDrafts();error.textContent=message;error.hidden=false;updateEditedMeta()}});
    }
  });
}
function updateEditedMeta(){
  const changed=state.edited.map((_,i)=>i).filter(isChanged),changes=changed.length,jump=$('jumpChange'),current=jump.value;
  const dirty=dirtyIndexes(),dirtyJump=$('dirtyJump'),dirtyCurrent=dirtyJump.value,counter=$('dirtyCounter');
  if(!changes)state.changeCursor=-1;
  else if(state.changeCursor>=changes)state.changeCursor=changes-1;
  $('editedMeta').textContent=`${state.edited.length} events / ${changes} changed section${changes===1?'':'s'}`;
  jump.disabled=!changes;
  jump.innerHTML='<option value="">Jump to change</option>'+changed.map((eventIndex,changeIndex)=>`<option value="${eventIndex}">Change ${changeIndex+1} — Event ${eventIndex+1}: ${esc(labelFor(state.edited[eventIndex],eventIndex))}</option>`).join('');
  if(changed.some(i=>String(i)===current))jump.value=current;
  counter.hidden=!dirty.length;counter.textContent=`${dirty.length} Dirty`;
  dirtyJump.disabled=!dirty.length;
  dirtyJump.innerHTML='<option value="">Jump to dirty</option>'+dirty.map((eventIndex,dirtyIndex)=>`<option value="${eventIndex}">Dirty ${dirtyIndex+1} — Event ${eventIndex+1}: ${esc(labelFor(state.edited[eventIndex],eventIndex))}</option>`).join('');
  if(dirty.some(i=>String(i)===dirtyCurrent))dirtyJump.value=dirtyCurrent;
  const invalid=dirty.some(i=>state.drafts[i]?.error);$('downloadEdited').disabled=invalid;$('downloadEdited').title=invalid?'Fix invalid dirty sections before downloading':'';
}
function renderEdited(){
  if(!state.edited.length)return;
  const roles=[...new Set(state.edited.map(roleFor))].sort();
  $('editedRoleFilter').innerHTML='<option value="all">all</option>'+roles.map(r=>`<option ${r===state.editedFilter?'selected':''} value="${esc(r)}">${esc(r)}</option>`).join('');
  const entries=state.edited.map((e,i)=>({e,i})).filter(({e,i})=>(state.editedFilter==='all'||roleFor(e)===state.editedFilter)&&(!state.editedQuery||JSON.stringify(e).toLowerCase().includes(state.editedQuery)||state.drafts[i]?.text?.toLowerCase().includes(state.editedQuery)));
  $('editedArea').className='edited-area'+(entries.length?'':' empty-state');
  $('editedArea').innerHTML=entries.length?entries.map(({e,i})=>editorBlock(e,i,true)).join(''):'<div class="empty-icon">⌕</div><strong>No matching edited events</strong><span>Try another search or filter</span>';
  bindTabs($('editedArea'),true);$('downloadEdited').disabled=false;setEditedActionState();updateEditedMeta();
}
function clearEditedFilters(){state.editedQuery='';state.editedFilter='all';$('editedSearchInput').value='';renderEdited()}
async function loadFile(input,kind){
  const file=input.files[0];if(!file)return;
  try{
    const text=await file.text(),result=parseTrajectory(text),events=result.events;
    state[kind]=events;state[`${kind}Doc`]=result;state[`${kind}Name`]=file.name;state.expanded.clear();state.rawCards.clear();state.changeCursor=-1;
    if(kind==='edited'){state.editedBaseline=JSON.parse(JSON.stringify(events));state.cellBaselines=JSON.parse(JSON.stringify(events));state.originIndexes=events.map((_,i)=>i);state.editedSelected=null;state.drafts={};state.copiedKey=null;state.editedQuery='';state.editedFilter='all';$('editedSearchInput').value='';saveDrafts()}
    if(kind==='original'){state.selected=0;$('originalMeta').textContent=`${file.name} / ${events.length} events`;$('headerOriginalName').textContent=file.name;$('headerOriginalName').title=file.name;renderOriginal();if(state.edited.length)renderEdited();$('resetOriginalUpload').disabled=false}
    else{$('headerEditedName').textContent=file.name;$('headerEditedName').title=file.name;renderEdited();$('resetEditedUpload').disabled=false}
    saveWorkspace();toast(`${events.length} events loaded from ${file.name}`);
  }catch(err){toast(err.message,true)}finally{input.value=''}
}

function serializeEdited(){
  const source=state.editedDoc;
  if(source?.format==='wrapped'){
    const output={...source.document,steps:state.edited.map((event,index)=>({[`step_${index}`]:event}))};
    return JSON.stringify(output,null,2)+'\n';
  }
  if(source?.format==='array') return JSON.stringify(state.edited,null,2)+'\n';
  if(source?.format==='single' && state.edited.length===1) return JSON.stringify(state.edited[0],null,2)+'\n';
  return state.edited.map(compact).join('\n')+'\n';
}
function toast(message,isError=false){const t=$('toast');t.textContent=message;t.style.background=isError?'#a23d3d':'';t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2600)}

$('originalFile').onchange=e=>loadFile(e.target,'original');$('editedFile').onchange=e=>loadFile(e.target,'edited');
$('searchInput').oninput=e=>{state.query=e.target.value.toLowerCase();renderOriginal()};$('roleFilter').onchange=e=>{state.filter=e.target.value;renderOriginal()};
$('editedSearchInput').oninput=e=>{state.editedQuery=e.target.value.toLowerCase();renderEdited()};$('editedRoleFilter').onchange=e=>{state.editedFilter=e.target.value;renderEdited()};
$('addAssistant').onclick=()=>addEditableCell('assistant');$('addToolCall').onclick=()=>addEditableCell('tool');
$('resetAllEdited').onclick=async()=>{
  if(!await askConfirmation('Reset every edited section and remove all newly added cells?'))return;
  state.edited=JSON.parse(JSON.stringify(state.editedBaseline));state.cellBaselines=JSON.parse(JSON.stringify(state.editedBaseline));state.originIndexes=state.edited.map((_,i)=>i);state.editedSelected=null;state.drafts={};state.copiedKey=null;state.editedExpanded.clear();state.changeCursor=-1;state.editedQuery='';state.editedFilter='all';$('editedSearchInput').value='';saveDrafts();saveWorkspace();renderEdited();toast('All edited sections reset');
};
$('resetOriginalUpload').onclick=async()=>{
  if(!await askConfirmation('Clear the uploaded original trajectory? This will also remove it from local storage.'))return;
  state.original=[];state.originalDoc=null;state.originalName='';state.selected=0;state.query='';state.filter='all';state.expanded.clear();state.rawCards.clear();
  $('originalMeta').textContent='No file loaded';$('searchInput').value='';$('roleFilter').innerHTML='<option value="all">all</option>';
  $('headerOriginalName').textContent='No file uploaded';$('headerOriginalName').removeAttribute('title');
  $('originalList').className='event-list empty-state';$('originalList').innerHTML='<div class="empty-icon">⇧</div><strong>Upload a trajectory</strong><span>JSON and JSONL are supported</span>';
  $('resetOriginalUpload').disabled=true;if(state.edited.length)renderEdited();saveWorkspace();toast('Original trajectory cleared');
};
$('resetEditedUpload').onclick=async()=>{
  if(!await askConfirmation('Clear the uploaded edited trajectory and all local drafts?'))return;
  state.edited=[];state.editedBaseline=[];state.cellBaselines=[];state.originIndexes=[];state.editedSelected=null;state.editedDoc=null;state.editedName='';state.drafts={};state.copiedKey=null;state.editedExpanded.clear();state.changeCursor=-1;saveDrafts();
  state.editedQuery='';state.editedFilter='all';$('editedSearchInput').value='';$('editedRoleFilter').innerHTML='<option value="all">all</option>';
  $('headerEditedName').textContent='No file uploaded';$('headerEditedName').removeAttribute('title');
  $('editedMeta').textContent='No file loaded';$('editedArea').className='edited-area empty-state';$('editedArea').innerHTML='<div class="empty-icon">⇧</div><strong>Upload the edited trajectory</strong><span>It will appear here for comparison</span>';
  $('dirtyCounter').hidden=true;$('dirtyJump').disabled=true;$('dirtyJump').innerHTML='<option value="">Jump to dirty</option>';$('jumpChange').disabled=true;$('jumpChange').innerHTML='<option value="">Jump to change</option>';
  $('downloadEdited').disabled=true;$('resetEditedUpload').disabled=true;saveWorkspace();toast('Edited trajectory and drafts cleared');
  setEditedActionState();
};
$('jumpChange').onchange=event=>{
  if(event.target.value==='')return;const idx=Number(event.target.value),changed=state.edited.map((_,i)=>i).filter(isChanged),position=changed.indexOf(idx);if(!document.querySelector(`#editedArea [data-edit-index="${idx}"]`))clearEditedFilters();const cell=document.querySelector(`#editedArea [data-edit-index="${idx}"]`);
  state.changeCursor=position;
  if(cell){state.editedExpanded.add(idx);cell.classList.remove('collapsed');cell.querySelector('.expand-cell').textContent='Expanded';cell.querySelector('.expand-cell').disabled=true;cell.scrollIntoView({behavior:'smooth',block:'start'});cell.classList.add('change-pulse');setTimeout(()=>cell.classList.remove('change-pulse'),900);toast(`Change ${position+1} of ${changed.length} — Event ${idx+1}`)}
};
$('dirtyJump').onchange=event=>{
  if(event.target.value==='')return;const idx=Number(event.target.value),dirty=dirtyIndexes(),position=dirty.indexOf(idx);if(!document.querySelector(`#editedArea [data-edit-index="${idx}"]`))clearEditedFilters();const cell=document.querySelector(`#editedArea [data-edit-index="${idx}"]`);
  if(cell){state.editedExpanded.add(idx);cell.classList.remove('collapsed');cell.querySelector('.expand-cell').textContent='Expanded';cell.querySelector('.expand-cell').disabled=true;cell.scrollIntoView({behavior:'smooth',block:'start'});cell.classList.add('dirty-pulse');setTimeout(()=>cell.classList.remove('dirty-pulse'),900);toast(`Dirty ${position+1} of ${dirty.length} — Event ${idx+1}`)}
};
$('downloadEdited').onclick=()=>{const blob=new Blob([serializeEdited()],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='trajectory-edited.json';a.click();URL.revokeObjectURL(a.href);toast('Edited trajectory downloaded')};
$('themeToggle').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

function enableParallelScroll(){
  const original=$('originalList'),edited=$('editedArea');let syncing=false;
  const mirror=(source,target,sourceSelector,targetAttribute)=>{
    if(syncing)return;syncing=true;
    const sourceTop=source.getBoundingClientRect().top,cards=[...source.querySelectorAll(sourceSelector)];
    const anchor=cards.find(card=>card.getBoundingClientRect().bottom>sourceTop+1)||cards.at(-1);
    if(anchor){
      const index=anchor.dataset.index??anchor.dataset.editIndex,targetCard=target.querySelector(`[${targetAttribute}="${index}"]`);
      if(targetCard){const rect=anchor.getBoundingClientRect(),progress=Math.max(0,Math.min(1,(sourceTop-rect.top)/Math.max(1,rect.height))),targetRect=targetCard.getBoundingClientRect(),targetTop=target.getBoundingClientRect().top;target.scrollTop+=targetRect.top-targetTop+progress*targetRect.height}
    }
    requestAnimationFrame(()=>{syncing=false});
  };
  original.addEventListener('scroll',()=>mirror(original,edited,'.event-card','data-edit-index'),{passive:true});
  edited.addEventListener('scroll',()=>mirror(edited,original,'.event-editor','data-index'),{passive:true});
}

setTheme(localStorage.getItem(THEME_KEY)||'light');
restoreWorkspace();
enableParallelScroll();
