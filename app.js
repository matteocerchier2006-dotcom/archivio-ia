/* Archivio IA — note e documenti con ricerca offline e domande a un'IA locale (Ollama). */
'use strict';

const APP_VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

/* ---------------- Archivio (IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('archivio-ia', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction('docs', mode);
      const store = t.objectStore('docs');
      const out = fn(store);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(doc) { return this.tx('readwrite', (s) => s.put(doc)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

let docs = [];            // tutti i documenti in memoria
let index = null;         // indice di ricerca
let currentDocId = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------------- Testo e ricerca ---------------- */
const STOP = new Set(('il lo la i gli le un uno una di a da in con su per tra fra e ed o ma se che chi cui non ' +
  'del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei ' +
  'negli nelle sul sullo sulla sui sugli sulle col coi è sono era erano ho hai ha abbiamo avete hanno ci si mi ti ' +
  'vi ne come dove quando quale quali quanto questo questa questi queste quello quella quelli quelle anche più ' +
  'molto poi già cosa cose va vanno fa fatto fatta dove ogni mio mia miei mie tuo tua suo sua loro nostro nostra essere avere fare c l d un').split(' '));

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function tokens(s) {
  const m = norm(s).match(/[a-z0-9]+/g) || [];
  return m.filter((w) => w.length > 1 && !STOP.has(w));
}
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // distanza con scambio di lettere vicine (es. "caldiaa" ~ "caldaia")
  let pp = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}

/* Divide un documento in pezzi di ~900 caratteri, tenendo traccia della pagina (per i PDF). */
function chunkDoc(doc) {
  const parts = doc.pages && doc.pages.length ? doc.pages.map((t, i) => ({ page: i + 1, text: t }))
    : [{ page: null, text: doc.text || '' }];
  const chunks = [];
  for (const p of parts) {
    const paras = p.text.split(/\n\s*\n/);
    let buf = '';
    const flush = () => { if (buf.trim()) chunks.push({ docId: doc.id, page: p.page, text: buf.trim() }); buf = ''; };
    for (const para of paras) {
      if (buf.length + para.length > 900 && buf.length > 200) flush();
      if (para.length > 1400) {
        for (let i = 0; i < para.length; i += 900) { buf += para.slice(i, i + 900); flush(); }
      } else buf += (buf ? '\n\n' : '') + para;
    }
    flush();
  }
  // il titolo aiuta a trovare il documento
  if (chunks.length) chunks[0].title = true;
  return chunks;
}

function buildIndex() {
  const chunks = [];
  const vocab = new Map(); // parola -> numero di pezzi che la contengono
  for (const d of docs) {
    for (const c of chunkDoc(d)) {
      const toks = tokens((c.title ? d.title + ' ' : '') + c.text);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      tf.forEach((_, t) => vocab.set(t, (vocab.get(t) || 0) + 1));
      c.tf = tf; c.len = toks.length || 1;
      c.titleToks = new Set(tokens(d.title));
      chunks.push(c);
    }
  }
  const avg = chunks.reduce((a, c) => a + c.len, 0) / (chunks.length || 1);
  index = { chunks, vocab, avg };
}

/* Per ogni parola cercata trova le parole dell'archivio simili (uguali, inizio parola, piccoli errori). */
function expandTerm(q) {
  const out = new Map();
  index.vocab.forEach((_, w) => {
    let wgt = 0;
    if (w === q) wgt = 1;
    else if (q.length >= 3 && w.startsWith(q)) wgt = 0.8;
    else if (q.length >= 4 && w.length >= 4 && w.startsWith(q.slice(0, -1)) && w.length <= q.length + 3) wgt = 0.6; // plurali/desinenze
    else if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      if (lev(q, w, max) <= max) wgt = 0.55;
    }
    if (wgt) out.set(w, wgt);
  });
  return out;
}

function search(query, limit = 20) {
  if (!index) buildIndex();
  const qt = [...new Set(tokens(query))];
  if (!qt.length) return { results: [], terms: new Set() };
  const N = index.chunks.length;
  const expanded = qt.map(expandTerm);
  const allTerms = new Set();
  expanded.forEach((m) => m.forEach((_, w) => allTerms.add(w)));
  const k1 = 1.2, b = 0.75;
  const results = [];
  for (const c of index.chunks) {
    let score = 0, hit = 0;
    expanded.forEach((m) => {
      let best = 0;
      m.forEach((wgt, w) => {
        const f = c.tf.get(w);
        if (!f) return;
        const df = index.vocab.get(w);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        let s = wgt * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / index.avg));
        if (c.titleToks.has(w)) s *= 1.5;
        if (s > best) best = s;
      });
      if (best) { score += best; hit++; }
    });
    if (hit) {
      score *= (hit / qt.length) ** 1.5; // premia chi contiene tutte le parole
      results.push({ chunk: c, score });
    }
  }
  results.sort((a, b2) => b2.score - a.score);
  return { results: results.slice(0, limit), terms: allTerms };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function highlight(text, terms) {
  return esc(text).replace(/[\p{L}\p{N}]+/gu, (w) => (terms.has(norm(w)) ? `<mark>${w}</mark>` : w));
}
function snippet(text, terms, size = 260) {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const first = words.find((m) => terms.has(norm(m[0])));
  let start = first ? Math.max(0, first.index - 80) : 0;
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp > -1 && sp - start < 20) start = sp + 1; }
  const part = text.slice(start, start + size);
  return (start > 0 ? '… ' : '') + highlight(part, terms) + (start + size < text.length ? ' …' : '');
}

/* ---------------- Interfaccia generale ---------------- */
const TITLES = { docs: 'Documenti', search: 'Cerca', ask: 'Chiedi', settings: 'Impostazioni', doc: '' };
let lastTab = 'docs';

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('viewTitle').textContent = view === 'doc' ? ($('docTitle').value || 'Nota') : TITLES[view];
  if (view !== 'doc') lastTab = view;
  if (view === 'search') setTimeout(() => $('searchInput').focus(), 50);
  if (view === 'ask') checkAI();
  if (view === 'settings') showStorage();
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const typeLabel = (d) => (d.type === 'pdf' ? `PDF · ${d.pages.length} pag.` : d.type === 'file' ? 'File di testo' : 'Nota');

function renderDocs() {
  const f = norm($('docFilter').value.trim());
  const list = docs.filter((d) => !f || norm(d.title).includes(f)).sort((a, b) => b.updated - a.updated);
  $('docList').innerHTML = list.map((d) =>
    `<li data-id="${d.id}"><div class="t">${esc(d.title || 'Senza titolo')}</div>` +
    `<div class="s">${typeLabel(d)} · ${fmtDate(d.updated)}</div></li>`).join('');
  $('emptyDocs').hidden = docs.length > 0;
}

function docById(id) { return docs.find((d) => d.id === id); }

function openDoc(id, focusTerms) {
  const d = id ? docById(id) : null;
  currentDocId = d ? d.id : null;
  $('docTitle').value = d ? d.title : '';
  $('docText').value = d ? (d.pages ? d.pages.map((p, i) => `— Pagina ${i + 1} —\n${p}`).join('\n\n') : d.text) : '';
  $('docText').readOnly = !!(d && d.pages);
  $('docMeta').textContent = d ? `${typeLabel(d)} · aggiunto il ${fmtDate(d.created)}` + (d.pages ? ' · il testo dei PDF non si modifica' : '') : 'Nuova nota';
  $('btnDeleteDoc').hidden = !d;
  show('doc');
  if (!d) setTimeout(() => $('docTitle').focus(), 50);
  if (focusTerms) {
    // porta il cursore sul punto trovato
    const txt = norm($('docText').value);
    const t = [...focusTerms][0];
    const pos = t ? txt.indexOf(t) : -1;
    if (pos > -1) setTimeout(() => {
      const ta = $('docText');
      ta.setSelectionRange(pos, pos + t.length);
      const lineH = 26, before = ta.value.slice(0, pos).split('\n').length;
      ta.scrollTop = Math.max(0, before * lineH - 100);
    }, 80);
  }
}

async function saveDoc() {
  const title = $('docTitle').value.trim() || 'Senza titolo';
  const now = Date.now();
  let d = currentDocId ? docById(currentDocId) : null;
  if (d) {
    d.title = title;
    if (!d.pages) d.text = $('docText').value;
    d.updated = now;
  } else {
    d = { id: uid(), type: 'note', title, text: $('docText').value, created: now, updated: now };
    docs.push(d);
    currentDocId = d.id;
  }
  await DB.put(d);
  index = null;
  toast('Salvato');
  renderDocs();
  show(lastTab === 'doc' ? 'docs' : lastTab);
}

async function deleteDoc() {
  const d = docById(currentDocId);
  if (!d) return;
  if (!confirm(`Eliminare "${d.title}"?`)) return;
  await DB.del(d.id);
  docs = docs.filter((x) => x.id !== d.id);
  index = null;
  renderDocs();
  toast('Eliminato');
  show('docs');
}

/* ---------------- Importare file ---------------- */
let pdfLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (!pdfLoading) pdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'lib/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; resolve(); };
    s.onerror = () => { pdfLoading = null; reject(new Error('Lettore PDF non disponibile')); };
    document.head.appendChild(s);
  });
  return pdfLoading;
}

async function readPdf(file, onPage) {
  await loadPdfJs();
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '', lastY = null;
    for (const it of content.items) {
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
      text += it.str;
      if (it.hasEOL) text += '\n';
      lastY = y;
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
    onPage && onPage(i, pdf.numPages);
  }
  return pages;
}

async function importFiles(files) {
  const prog = $('importProgress');
  prog.hidden = false;
  let added = 0;
  for (const file of files) {
    try {
      const name = file.name.replace(/\.[^.]+$/, '');
      const now = Date.now();
      let d;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        prog.textContent = `Leggo "${file.name}"…`;
        const pages = await readPdf(file, (i, n) => { prog.textContent = `Leggo "${file.name}": pagina ${i} di ${n}`; });
        const chars = pages.join('').replace(/\s/g, '').length;
        if (chars < 20) toast(`"${file.name}" sembra una scansione senza testo: non potrò cercarci dentro.`, 5000);
        d = { id: uid(), type: 'pdf', title: name, pages, created: now, updated: now };
      } else {
        d = { id: uid(), type: 'file', title: name, text: await file.text(), created: now, updated: now };
      }
      await DB.put(d);
      docs.push(d);
      added++;
    } catch (e) {
      console.error(e);
      toast(`Non riesco a leggere "${file.name}"`, 4000);
    }
  }
  prog.hidden = true;
  index = null;
  renderDocs();
  if (added) toast(added === 1 ? 'Documento aggiunto' : `${added} documenti aggiunti`);
}

/* ---------------- Ricerca (schermata Cerca) ---------------- */
let searchTimer;
function runSearch() {
  const q = $('searchInput').value.trim();
  const ul = $('searchResults');
  if (!q) { ul.innerHTML = ''; return; }
  const { results, terms } = search(q, 30);
  if (!results.length) {
    ul.innerHTML = '<li class="empty" style="cursor:default">Nessun risultato. Prova con altre parole.</li>';
    return;
  }
  ul.innerHTML = results.map(({ chunk }) => {
    const d = docById(chunk.docId);
    return `<li data-id="${d.id}"><div class="t">${highlight(d.title, terms)}</div>` +
      `<div class="s">${typeLabel(d)}${chunk.page ? ' · pagina ' + chunk.page : ''}</div>` +
      `<div class="snip">${snippet(chunk.text, terms)}</div></li>`;
  }).join('');
  ul.dataset.terms = JSON.stringify([...terms]);
}

/* ---------------- IA (Ollama) ---------------- */
const settings = {
  url: '', model: '', k: 6,
  load() {
    try { Object.assign(this, JSON.parse(localStorage.getItem('archivio-settings') || '{}')); } catch (e) { /* niente */ }
  },
  save() {
    try { localStorage.setItem('archivio-settings', JSON.stringify({ url: this.url, model: this.model, k: this.k })); } catch (e) { /* niente */ }
  },
};
const baseUrl = () => settings.url.trim().replace(/\/+$/, '');

async function fetchTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

let aiOnline = false;
async function checkAI() {
  const el = $('aiStatus');
  if (!baseUrl()) { el.textContent = 'IA: da configurare'; el.className = 'status off'; aiOnline = false; return false; }
  if (!navigator.onLine) { el.textContent = 'IA: offline'; el.className = 'status off'; aiOnline = false; return false; }
  try {
    const r = await fetchTimeout(baseUrl() + '/api/tags', {}, 5000);
    aiOnline = r.ok;
  } catch (e) { aiOnline = false; }
  el.textContent = aiOnline ? 'IA: collegata' : 'IA: non raggiungibile';
  el.className = 'status ' + (aiOnline ? 'on' : 'off');
  return aiOnline;
}

async function loadModels() {
  const sel = $('setModel');
  try {
    const r = await fetchTimeout(baseUrl() + '/api/tags', {}, 6000);
    const data = await r.json();
    const names = (data.models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    if (!names.length) throw new Error('Nessun modello installato sul Mac');
    sel.innerHTML = names.map((n) => `<option ${n === settings.model ? 'selected' : ''}>${esc(n)}</option>`).join('');
    if (!settings.model || !names.includes(settings.model)) settings.model = names[0];
    return names;
  } catch (e) {
    if (settings.model) sel.innerHTML = `<option selected>${esc(settings.model)}</option>`;
    throw e;
  }
}

let chatHistory = []; // [{role, content}] solo domande e risposte, senza contesto

const SYSTEM_PROMPT = `Sei l'assistente di un archivio personale di documenti di una famiglia.
Rispondi SEMPRE in italiano, in modo semplice e chiaro.
Usa SOLO le informazioni presenti negli estratti forniti. Se la risposta non c'è, dillo chiaramente ("Nei documenti non ho trovato...") e non inventare.
Quando usi un'informazione, indica da quale estratto viene con il numero tra parentesi quadre, ad esempio [1] o [2].`;

function renderAnswer(text, sources) {
  let h = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');
  h = h.replace(/\[(\d+)\]/g, (m, n) => (sources[n - 1] ? `<span class="cite" data-src="${n - 1}">[${n}]</span>` : m));
  return h;
}

function sourcesHtml(sources) {
  if (!sources.length) return '';
  return '<div class="sources"><b>Fonti</b>' + sources.map((s, i) => {
    const d = docById(s.docId);
    return `<a data-src="${i}">[${i + 1}] ${esc(d ? d.title : '?')}${s.page ? ' · pag. ' + s.page : ''}</a>`;
  }).join('') + '</div>';
}

function addBubble(cls, html) {
  const div = document.createElement('div');
  div.className = 'bubble ' + cls;
  div.innerHTML = html;
  $('chat').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function bindSources(bubble, sources, terms) {
  bubble.addEventListener('click', (e) => {
    const t = e.target.closest('[data-src]');
    if (!t) return;
    const s = sources[+t.dataset.src];
    if (s) openDoc(s.docId, terms);
  });
}

async function ask(question) {
  addBubble('user', esc(question));
  const q = question;
  // per le domande di seguito ("e quando scade?") usa anche la domanda precedente
  const prevQ = chatHistory.filter((m) => m.role === 'user').slice(-1)[0];
  let { results, terms } = search(q, settings.k);
  if (results.length < 2 && prevQ) ({ results, terms } = search(prevQ.content + ' ' + q, settings.k));
  const sources = results.map((r) => r.chunk);

  const online = await checkAI();
  if (!online || !settings.model) {
    const why = !baseUrl() ? "L'IA non è ancora configurata (vai in Impostazioni)."
      : !navigator.onLine ? 'Sei senza internet, quindi l\'IA non è raggiungibile.'
        : "Non riesco a raggiungere l'IA sul Mac mini (è acceso? Tailscale è attivo?).";
    const html = `<div class="warn">${why}</div>` + (sources.length
      ? 'Ecco cosa ho trovato nei documenti:' + sources.map((c, i) => {
        const d = docById(c.docId);
        return `<div style="margin-top:10px"><a class="cite" data-src="${i}">${esc(d.title)}${c.page ? ' · pag. ' + c.page : ''}</a><div class="small">${snippet(c.text, terms, 220)}</div></div>`;
      }).join('')
      : 'E nella ricerca normale non ho trovato niente con queste parole.');
    bindSources(addBubble('ai', html), sources, terms);
    return;
  }

  const context = sources.length
    ? sources.map((c, i) => {
      const d = docById(c.docId);
      return `[${i + 1}] Documento: "${d.title}"${c.page ? `, pagina ${c.page}` : ''}\n${c.text}`;
    }).join('\n\n---\n\n')
    : '(Nessun estratto trovato per questa domanda.)';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...chatHistory.slice(-6),
    { role: 'user', content: `Estratti dai documenti:\n\n${context}\n\nDomanda: ${q}` },
  ];

  const bubble = addBubble('ai typing', '');
  bindSources(bubble, sources, terms);
  let answer = '';
  $('askBtn').disabled = true;
  try {
    const r = await fetchTimeout(baseUrl() + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, messages, stream: true, options: { temperature: 0.2 } }),
    }, 60000);
    if (!r.ok) throw new Error('Errore del server: ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message && j.message.content) answer += j.message.content;
      }
      bubble.innerHTML = renderAnswer(answer, sources);
      bubble.scrollIntoView({ block: 'end' });
    }
    bubble.classList.remove('typing');
    bubble.innerHTML = renderAnswer(answer || '(nessuna risposta)', sources) + sourcesHtml(sources);
    chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
  } catch (e) {
    bubble.classList.remove('typing');
    bubble.innerHTML = (answer ? renderAnswer(answer, sources) + '<br>' : '') +
      `<div class="warn">La risposta si è interrotta: ${esc(e.message || e)}</div>` + sourcesHtml(sources);
  } finally {
    $('askBtn').disabled = false;
  }
}

/* ---------------- Esporta / importa ---------------- */
async function exportAll() {
  const data = JSON.stringify({ app: 'archivio-ia', version: 1, exported: Date.now(), docs });
  const name = `archivio-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Archivio' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importAll(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'archivio-ia' || !Array.isArray(data.docs)) throw new Error('formato');
    let added = 0, updated = 0;
    for (const d of data.docs) {
      if (!d || !d.id) continue;
      const mine = docById(d.id);
      if (!mine) { docs.push(d); await DB.put(d); added++; }
      else if (d.updated > mine.updated) { Object.assign(mine, d); await DB.put(mine); updated++; }
    }
    index = null;
    renderDocs();
    toast(`Importati ${added} nuovi documenti` + (updated ? `, ${updated} aggiornati` : ''), 3500);
  } catch (e) {
    toast('Questo file non è un archivio valido', 3500);
  }
}

async function showStorage() {
  let txt = `${docs.length} documenti.`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      txt += ` Occupano circa ${(usage / 1048576).toFixed(1)} MB sul telefono.`;
    }
  } catch (e) { /* niente */ }
  $('storageInfo').textContent = txt;
}

/* ---------------- Avvio ---------------- */
async function init() {
  $('appVersion').textContent = APP_VERSION;
  settings.load();
  $('setUrl').value = settings.url;
  $('setK').value = settings.k;
  if (settings.model) $('setModel').innerHTML = `<option selected>${esc(settings.model)}</option>`;

  await DB.open();
  docs = await DB.all() || [];
  renderDocs();
  checkAI();

  // chiede al sistema di non cancellare i dati
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('btnNewNote').onclick = () => openDoc(null);
  $('docList').onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) openDoc(li.dataset.id); };
  $('docFilter').oninput = renderDocs;
  $('fileInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('btnBack').onclick = () => show(lastTab);
  $('btnSaveDoc').onclick = saveDoc;
  $('btnDeleteDoc').onclick = deleteDoc;

  $('searchInput').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); };
  $('searchResults').onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openDoc(li.dataset.id, new Set(JSON.parse($('searchResults').dataset.terms || '[]')));
  };

  const inp = $('askInput');
  inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = inp.scrollHeight + 'px'; };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('askForm').requestSubmit(); } };
  $('askForm').onsubmit = (e) => {
    e.preventDefault();
    const q = inp.value.trim();
    if (!q || $('askBtn').disabled) return;
    inp.value = ''; inp.style.height = 'auto';
    ask(q);
  };
  $('btnClearChat').onclick = () => {
    chatHistory = [];
    [...$('chat').querySelectorAll('.bubble:not(.intro)')].forEach((b) => b.remove());
  };

  $('btnSaveSettings').onclick = async () => {
    settings.url = $('setUrl').value.trim();
    settings.model = $('setModel').value || settings.model;
    settings.k = Math.min(15, Math.max(2, +$('setK').value || 6));
    settings.save();
    toast('Impostazioni salvate');
    checkAI();
  };
  $('setModel').onchange = () => { settings.model = $('setModel').value; settings.save(); };
  const testConn = async () => {
    settings.url = $('setUrl').value.trim();
    const out = $('testResult');
    if (location.protocol === 'https:' && /^http:/i.test(settings.url)) {
      out.textContent = "⚠︎ L'indirizzo deve iniziare con https:// (usa l'indirizzo di Tailscale), altrimenti il telefono lo blocca.";
      return;
    }
    out.textContent = 'Provo…';
    try {
      const names = await loadModels();
      settings.save();
      out.textContent = `✓ Collegato. Modelli trovati: ${names.join(', ')}`;
    } catch (e) {
      out.textContent = '✗ Non riesco a collegarmi. Controlla che il Mac mini sia acceso, che Ollama e Tailscale siano attivi e che l\'indirizzo sia giusto.';
    }
    checkAI();
  };
  $('btnTest').onclick = testConn;
  $('btnLoadModels').onclick = testConn;
  $('btnExport').onclick = exportAll;
  $('importInput').onchange = (e) => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };

  window.addEventListener('online', checkAI);
  window.addEventListener('offline', checkAI);
}

init().catch((e) => { console.error(e); alert('Errore di avvio: ' + e.message); });
