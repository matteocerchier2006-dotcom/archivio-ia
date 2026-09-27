/* Archivio IA — note e documenti con ricerca offline e domande a un'IA locale (Ollama). */
'use strict';

const APP_VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);

/* ---------------- Archivio (IndexedDB) ---------------- */
// versione 2 del database: aggiunge cartelle e promemoria senza toccare i documenti già salvati
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('archivio-ia', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['docs', 'folders', 'reminders']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(storeName, mode);
      const out = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Spazio esaurito o salvataggio annullato'));
    });
  },
  all(store = 'docs') { return this.tx(store, 'readonly', (s) => s.getAll()); },
  put(obj, store = 'docs') { return this.tx(store, 'readwrite', (s) => s.put(obj)); },
  del(id, store = 'docs') { return this.tx(store, 'readwrite', (s) => s.delete(id)); },
};

let docs = [];            // tutti i documenti in memoria
let folders = [];         // cartelle create dall'utente
let reminders = [];       // promemoria
let currentFolder = 'all';// cartella selezionata in Documenti ('all', 'none' o id)
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
const TITLES = { docs: 'Documenti', search: 'Cerca', ask: 'Chiedi', reminders: 'Promemoria', settings: 'Impostazioni', doc: '' };
let lastTab = 'docs';

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('viewTitle').textContent = view === 'doc' ? ($('docTitle').value || 'Nota') : TITLES[view];
  if (view !== 'doc') lastTab = view;
  if (view === 'search') setTimeout(() => $('searchInput').focus(), 50);
  if (view === 'ask') checkAI();
  if (view === 'settings') showStorage();
  if (view === 'reminders') renderReminders();
  if (view === 'docs') renderDocs();
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setProgress(text, frac) {
  const p = $('importProgress');
  if (text === null) { p.hidden = true; return; }
  p.hidden = false;
  p.querySelector('.progress-text').textContent = text;
  p.querySelector('.bar > div').style.width = Math.round((frac || 0) * 100) + '%';
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
function typeLabel(d) {
  if (d.type === 'pdf') return `PDF · ${d.pages.length} pag.` + (d.ocr ? ' · scansione' : '');
  if (d.type === 'photo') return (d.images && d.images.length > 1) ? `Foto · ${d.images.length}` : 'Foto';
  if (d.type === 'file') return 'File di testo';
  return 'Nota';
}

/* ---------------- Cartelle ---------------- */
const FOLDER_COLORS = ['#2f5d50', '#3b6fb6', '#b3402e', '#c27c0e', '#7a4fb0', '#2e8b8b', '#c2477a', '#6b716d'];
const folderById = (id) => folders.find((f) => f.id === id);
const dot = (color) => `<span class="dot" style="background:${esc(color || '#6b716d')}"></span>`;

function folderTag(d) {
  const f = d.folderId && folderById(d.folderId);
  return f ? ` · <span class="fold">${dot(f.color)}${esc(f.name)}</span>` : '';
}

function renderFolders() {
  const count = (id) => docs.filter((d) => (id === 'none' ? !folderById(d.folderId) : d.folderId === id)).length;
  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name, 'it'));
  if (currentFolder !== 'all' && currentFolder !== 'none' && !folderById(currentFolder)) currentFolder = 'all';
  let html = `<button class="chip ${currentFolder === 'all' ? 'active' : ''}" data-folder="all">Tutti · ${docs.length}</button>`;
  html += sorted.map((f) => `<button class="chip ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">${dot(f.color)} ${esc(f.name)} · ${count(f.id)}</button>`).join('');
  const loose = count('none');
  if (folders.length && loose) html += `<button class="chip ${currentFolder === 'none' ? 'active' : ''}" data-folder="none">Senza cartella · ${loose}</button>`;
  html += '<button class="chip add" data-folder="new">＋ Cartella</button>';
  $('folderChips').innerHTML = html;
  const f = folderById(currentFolder);
  $('folderHint').hidden = !f;
  if (f) $('folderHint').textContent = 'Tocca di nuovo la cartella per rinominarla o eliminarla. Quello che aggiungi ora finisce qui.';
}

function fillFolderSelect(sel, value) {
  sel.innerHTML = '<option value="">Nessuna cartella</option>' +
    [...folders].sort((a, b) => a.name.localeCompare(b.name, 'it')).map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('') +
    '<option value="__new">＋ Nuova cartella…</option>';
  sel.value = value && folderById(value) ? value : '';
}

// apre la finestra per creare o modificare una cartella; restituisce la cartella salvata (o null)
function folderDialog(folder) {
  return new Promise((resolve) => {
    const dlg = $('folderDialog');
    $('folderDialogTitle').textContent = folder ? 'Modifica cartella' : 'Nuova cartella';
    $('folderName').value = folder ? folder.name : '';
    $('btnFolderDelete').hidden = !folder;
    const color = folder ? folder.color : FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
    $('folderColors').innerHTML = FOLDER_COLORS.map((c, i) =>
      `<input type="radio" name="fcolor" id="fc${i}" value="${c}" ${c === color ? 'checked' : ''}><label for="fc${i}" style="background:${c}"></label>`).join('');
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const action = dlg.returnValue;
      if (action === 'save') {
        const name = $('folderName').value.trim();
        if (!name) return resolve(null);
        const c = (dlg.querySelector('input[name=fcolor]:checked') || {}).value || FOLDER_COLORS[0];
        const f = folder || { id: uid(), created: Date.now() };
        f.name = name; f.color = c; f.updated = Date.now();
        if (!folder) folders.push(f);
        await DB.put(f, 'folders');
        renderFolders();
        resolve(f);
      } else if (action === 'delete' && folder) {
        const n = docs.filter((d) => d.folderId === folder.id).length;
        if (!confirm(`Eliminare la cartella "${folder.name}"?` + (n ? `\nI suoi ${n} documenti NON vengono cancellati: restano "senza cartella".` : ''))) return resolve(null);
        for (const d of docs.filter((x) => x.folderId === folder.id)) { d.folderId = null; d.updated = Date.now(); await DB.put(d); }
        folders = folders.filter((x) => x.id !== folder.id);
        await DB.del(folder.id, 'folders');
        if (currentFolder === folder.id) currentFolder = 'all';
        renderDocs();
        toast('Cartella eliminata');
        resolve(null);
      } else resolve(null);
    };
    dlg.showModal();
    if (!folder) setTimeout(() => $('folderName').focus(), 50);
  });
}

/* ---------------- Lista documenti ---------------- */
function renderDocs() {
  renderFolders();
  renderAlertBar();
  const f = norm($('docFilter').value.trim());
  const list = docs.filter((d) => {
    if (currentFolder === 'none' && folderById(d.folderId)) return false;
    if (currentFolder !== 'all' && currentFolder !== 'none' && d.folderId !== currentFolder) return false;
    return !f || norm(d.title).includes(f);
  }).sort((a, b) => b.updated - a.updated);
  $('docList').innerHTML = list.map((d) =>
    `<li data-id="${d.id}">${d.thumb ? `<img class="mini" src="${d.thumb}" alt="">` : ''}<div class="body"><div class="t">${esc(d.title || 'Senza titolo')}</div>` +
    `<div class="s">${typeLabel(d)} · ${fmtDate(d.updated)}${currentFolder === 'all' ? folderTag(d) : ''}</div></div></li>`).join('');
  $('emptyDocs').hidden = list.length > 0;
  $('emptyDocs').innerHTML = docs.length
    ? 'Questa cartella è vuota.<br>Quello che aggiungi adesso finisce qui dentro.'
    : 'Non c\'è ancora niente.<br>Scrivi una nota, fai una foto o aggiungi un PDF per cominciare.';
}

function docById(id) { return docs.find((d) => d.id === id); }
const defaultFolder = () => (folderById(currentFolder) ? currentFolder : null);

function openDoc(id, focusTerms) {
  const d = id ? docById(id) : null;
  currentDocId = d ? d.id : null;
  $('docTitle').value = d ? d.title : '';
  $('docText').value = d ? (d.pages ? d.pages.map((p, i) => `— Pagina ${i + 1} —\n${p}`).join('\n\n') : d.text) : '';
  $('docText').readOnly = !!(d && d.pages);
  $('docMeta').textContent = d ? `${typeLabel(d)} · aggiunto il ${fmtDate(d.created)}` + (d.pages ? ' · il testo dei PDF non si modifica' : '') : 'Nuova nota';
  fillFolderSelect($('docFolder'), d ? d.folderId : defaultFolder());
  $('docImages').innerHTML = d && d.images ? d.images.map((src, i) => `<img src="${src}" data-i="${i}" alt="Foto ${i + 1}">`).join('') : '';
  $('docOcrInfo').hidden = !(d && d.type === 'photo');
  $('btnDeleteDoc').hidden = !d;
  $('btnDocReminder').hidden = !d;
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

async function saveDoc(stay) {
  const title = $('docTitle').value.trim() || 'Senza titolo';
  const now = Date.now();
  const folderId = $('docFolder').value && $('docFolder').value !== '__new' ? $('docFolder').value : null;
  let d = currentDocId ? docById(currentDocId) : null;
  if (d) {
    d.title = title;
    if (!d.pages) d.text = $('docText').value;
    d.folderId = folderId;
    d.updated = now;
  } else {
    d = { id: uid(), type: 'note', title, text: $('docText').value, folderId, created: now, updated: now };
    docs.push(d);
    currentDocId = d.id;
  }
  await DB.put(d);
  index = null;
  toast('Salvato');
  if (stay) return d;
  show(lastTab === 'doc' ? 'docs' : lastTab);
  return d;
}

async function deleteDoc() {
  const d = docById(currentDocId);
  if (!d) return;
  if (!confirm(`Eliminare "${d.title}"?`)) return;
  await DB.del(d.id);
  docs = docs.filter((x) => x.id !== d.id);
  index = null;
  toast('Eliminato');
  show('docs');
}

/* ---------------- Lettura del testo nelle foto (OCR, funziona senza internet) ---------------- */
const absUrl = (p) => new URL(p, location.href).href;
const OCR = {
  worker: null,
  loading: null,
  onProgress: null,
  loadScript() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'lib/ocr/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Lettore di foto non disponibile'));
      document.head.appendChild(s);
    });
  },
  get() {
    if (this.worker) return Promise.resolve(this.worker);
    if (!this.loading) this.loading = (async () => {
      await this.loadScript();
      this.worker = await window.Tesseract.createWorker('ita', 1, {
        workerPath: absUrl('lib/ocr/worker.min.js'),
        corePath: absUrl('lib/ocr/'),
        langPath: absUrl('lib/ocr'),
        workerBlobURL: false,
        gzip: true,
        logger: (m) => { if (m.status === 'recognizing text' && this.onProgress) this.onProgress(m.progress); },
      });
      return this.worker;
    })().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  },
  async read(canvas, onProgress) {
    const w = await this.get();
    this.onProgress = onProgress;
    const { data } = await w.recognize(canvas);
    this.onProgress = null;
    return cleanOcr(data.text || '');
  },
};

function cleanOcr(t) {
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Immagine non leggibile')); };
    img.src = url;
  });
}

function toCanvas(src, maxSide) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// una o più foto scelte insieme diventano un solo documento (es. le pagine di una bolletta)
async function importPhotos(files, step) {
  const images = [], texts = [];
  let thumb = null;
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `foto ${i + 1} di ${files.length}` : 'la foto';
    step(`Preparo ${label}…`, 0);
    const img = await loadImage(files[i]);
    images.push(toCanvas(img, 1400).toDataURL('image/jpeg', 0.72));
    if (!thumb) thumb = toCanvas(img, 140).toDataURL('image/jpeg', 0.7);
    step(`Leggo il testo nel${files.length > 1 ? 'la ' + label : 'la foto'}… (può volerci un po')`, 0.02);
    let text = '';
    try {
      text = await OCR.read(toCanvas(img, 2200), (p) => step(null, p));
    } catch (e) {
      console.error(e);
      toast('Non sono riuscito a leggere il testo della foto. La foto è salvata lo stesso: puoi scrivere tu cosa contiene.', 6000);
    }
    texts.push(files.length > 1 ? `— Foto ${i + 1} —\n${text}` : text);
  }
  const text = texts.join('\n\n');
  const firstLine = (text.split('\n').map((l) => l.replace(/^— Foto \d+ —$/, '').trim()).find((l) => l.replace(/[^\p{L}]/gu, '').length >= 4) || '').slice(0, 60);
  const now = Date.now();
  return {
    id: uid(), type: 'photo', title: firstLine || `Foto del ${fmtDate(now)}`, text, images, thumb,
    folderId: defaultFolder(), created: now, updated: now,
  };
}

/* ---------------- PDF (anche scansionati) ---------------- */
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

async function readPdf(file, step) {
  await loadPdfJs();
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  let scanned = 0, ocrFailed = false;
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
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // pagina senza testo = scansione: la "fotografo" e leggo il testo
    if (text.replace(/\s/g, '').length < 25 && !ocrFailed) {
      scanned++;
      step(`"${file.name}": pagina ${i} di ${pdf.numPages} è una scansione, leggo il testo… (può volerci un po')`, (i - 1) / pdf.numPages);
      try {
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, 2000 / vp1.width) });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        text = await OCR.read(c, (p) => step(null, (i - 1 + p) / pdf.numPages));
        c.width = c.height = 0; // libera memoria
      } catch (e) {
        console.error(e);
        ocrFailed = true;
      }
    } else step(`Leggo "${file.name}": pagina ${i} di ${pdf.numPages}`, i / pdf.numPages);
    pages.push(text);
  }
  return { pages, scanned, ocrFailed };
}

async function importFiles(files) {
  files = [...files];
  let lastText = '';
  const step = (text, frac) => { if (text !== null) lastText = text; setProgress(lastText, frac); };
  const added = [];
  const images = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  const others = files.filter((f) => !images.includes(f));
  if (images.length) {
    try {
      const d = await importPhotos(images, step);
      await DB.put(d);
      docs.push(d); added.push(d);
    } catch (e) {
      console.error(e);
      toast(/QuotaExceeded|Spazio/i.test(String(e)) ? 'Spazio sul telefono esaurito.' : 'Non riesco a leggere la foto', 4000);
    }
  }
  for (const file of others) {
    try {
      const name = file.name.replace(/\.[^.]+$/, '');
      const now = Date.now();
      let d;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        step(`Leggo "${file.name}"…`, 0);
        const { pages, scanned, ocrFailed } = await readPdf(file, step);
        const chars = pages.join('').replace(/\s/g, '').length;
        if (ocrFailed) toast(`Non sono riuscito a leggere le pagine scansionate di "${file.name}". La prima volta serve internet per preparare il lettore.`, 6000);
        else if (chars < 20) toast(`In "${file.name}" non ho trovato testo leggibile.`, 5000);
        d = { id: uid(), type: 'pdf', title: name, pages, ocr: scanned > 0, folderId: defaultFolder(), created: now, updated: now };
      } else {
        d = { id: uid(), type: 'file', title: name, text: await file.text(), folderId: defaultFolder(), created: now, updated: now };
      }
      await DB.put(d);
      docs.push(d); added.push(d);
    } catch (e) {
      console.error(e);
      toast(`Non riesco a leggere "${file.name}"`, 4000);
    }
  }
  setProgress(null);
  index = null;
  renderDocs();
  if (added.length === 1 && added[0].type === 'photo') {
    toast('Foto salvata: controlla il titolo e il testo letto', 3500);
    openDoc(added[0].id);
  } else if (added.length) toast(added.length === 1 ? 'Documento aggiunto' : `${added.length} documenti aggiunti`);
}

/* ---------------- Promemoria ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysUntil(s) { return Math.round((parseDay(s) - parseDay(todayStr())) / 86400000); }
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(Math.min(d, last))}`;
}
function fmtDay(s) {
  return parseDay(s).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}
function whenText(r) {
  const n = daysUntil(r.date);
  const rel = n === 0 ? 'oggi' : n === 1 ? 'domani' : n === -1 ? 'ieri' : n < 0 ? `${-n} giorni fa` : n <= 60 ? `tra ${n} giorni` : '';
  return fmtDay(r.date) + (r.time ? ' alle ' + r.time : '') + (rel ? ` (${rel})` : '');
}
function remState(r) {
  if (r.done) return 'done';
  const n = daysUntil(r.date);
  if (n < 0) return 'over';
  if (n <= (r.notice ?? 7)) return 'soon';
  return 'later';
}
const REPEAT_LABEL = { month: 'ogni mese', year: 'ogni anno' };

function renderReminders() {
  const groups = { over: [], soon: [], later: [], done: [] };
  reminders.forEach((r) => groups[remState(r)].push(r));
  const byDate = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
  Object.values(groups).forEach((g) => g.sort(byDate));
  groups.done.reverse();
  const card = (r) => {
    const st = remState(r);
    const d = r.docId && docById(r.docId);
    return `<div class="rem ${st}" data-id="${r.id}">
      <button class="check" data-act="toggle" aria-label="Fatto">${r.done ? '✓' : ''}</button>
      <div class="body" data-act="edit">
        <div class="t">${esc(r.title)}</div>
        <div class="s"><span class="when ${st}">${esc(whenText(r))}</span>${r.repeat ? ' · 🔁 ' + REPEAT_LABEL[r.repeat] : ''}</div>
        ${r.note ? `<div class="s">${esc(r.note)}</div>` : ''}
        ${d ? `<div class="doclink" data-act="doc">📎 ${esc(d.title)}</div>` : ''}
      </div></div>`;
  };
  const section = (key, title, list) => (list.length ? `<div class="rem-group ${key}"><h3>${title}</h3>${list.map(card).join('')}</div>` : '');
  $('reminderList').innerHTML =
    section('over', 'Scaduti', groups.over) +
    section('soon', 'In arrivo', groups.soon) +
    section('later', 'Più avanti', groups.later) +
    section('done', 'Fatti', groups.done.slice(0, 15));
  $('emptyReminders').hidden = reminders.length > 0;
  updateBadge();
}

function dueCount() { return reminders.filter((r) => ['over', 'soon'].includes(remState(r))).length; }
function updateBadge() {
  const n = dueCount();
  $('remBadge').hidden = !n;
  $('remBadge').textContent = n;
}
function renderAlertBar() {
  let bar = $('alertBar');
  const over = reminders.filter((r) => remState(r) === 'over').length;
  const n = dueCount();
  if (!n) { if (bar) bar.remove(); updateBadge(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'alertBar'; bar.className = 'alertbar';
    bar.onclick = () => show('reminders');
    $('view-docs').prepend(bar);
  }
  bar.innerHTML = `⏰ Hai <b>${n}</b> promemoria ${over ? `(${over} scadut${over === 1 ? 'o' : 'i'})` : 'in arrivo'} · <u>vedi</u>`;
  updateBadge();
}

async function toggleReminder(r) {
  if (!r.done && r.repeat) {
    const old = r.date;
    // passa alla prossima scadenza futura
    do { r.date = addMonths(r.date, r.repeat === 'year' ? 12 : 1); } while (daysUntil(r.date) < 0);
    r.lastDone = old;
    toast('Fatto! Prossima volta: ' + fmtDay(r.date), 3500);
  } else {
    r.done = !r.done;
    if (r.done) toast('Fatto ✓');
  }
  r.updated = Date.now();
  await DB.put(r, 'reminders');
  renderReminders();
}

function reminderDialog(r, preset) {
  const dlg = $('remDialog');
  $('remDialogTitle').textContent = r ? 'Modifica promemoria' : 'Nuovo promemoria';
  const v = r || { title: '', date: '', time: '', repeat: '', notice: 7, note: '', docId: null, ...preset };
  $('remTitle').value = v.title;
  $('remDate').value = v.date || addMonths(todayStr(), 0);
  $('remTime').value = v.time || '';
  $('remRepeat').value = v.repeat || '';
  $('remNotice').value = String(v.notice ?? 7);
  $('remNote').value = v.note || '';
  $('remDoc').innerHTML = '<option value="">Nessuno</option>' +
    [...docs].sort((a, b) => a.title.localeCompare(b.title, 'it')).map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join('');
  $('remDoc').value = v.docId && docById(v.docId) ? v.docId : '';
  $('btnRemDelete').hidden = !r;
  dlg.returnValue = '';
  dlg.onclose = async () => {
    const action = dlg.returnValue;
    if (action === 'save' || action === 'calendar') {
      const obj = r || { id: uid(), created: Date.now(), done: false };
      obj.title = $('remTitle').value.trim() || 'Promemoria';
      obj.date = $('remDate').value || todayStr();
      obj.time = $('remTime').value || '';
      obj.repeat = $('remRepeat').value || '';
      obj.notice = +$('remNotice').value;
      obj.note = $('remNote').value.trim();
      obj.docId = $('remDoc').value || null;
      if (r && daysUntil(obj.date) >= 0) obj.done = false;
      obj.updated = Date.now();
      if (!r) reminders.push(obj);
      await DB.put(obj, 'reminders');
      renderReminders(); renderAlertBar();
      if (action === 'calendar') addToCalendar(obj);
      else toast('Promemoria salvato');
    } else if (action === 'delete' && r) {
      if (!confirm(`Eliminare il promemoria "${r.title}"?`)) return;
      reminders = reminders.filter((x) => x.id !== r.id);
      await DB.del(r.id, 'reminders');
      renderReminders(); renderAlertBar();
      toast('Promemoria eliminato');
    }
  };
  dlg.showModal();
}

/* Calendario del telefono: su iPhone un file .ics, su Android Google Calendar */
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}
function buildIcs(r) {
  const ymd = r.date.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const d = r.docId && docById(r.docId);
  const desc = [r.note, d ? 'Documento: ' + d.title : '', 'Creato con Archivio IA'].filter(Boolean).join('\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Archivio IA//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${r.id}@archivio-ia`, `DTSTAMP:${stamp}`];
  if (r.time) {
    const [h, m] = r.time.split(':');
    const end = new Date(parseDay(r.date).getTime() + ((+h) * 60 + (+m) + 30) * 60000);
    const endStr = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T${pad(end.getHours())}${pad(end.getMinutes())}00`;
    lines.push(`DTSTART:${ymd}T${h}${m}00`, `DTEND:${endStr}`);
  } else {
    const next = new Date(parseDay(r.date).getTime() + 86400000 + 3600000);
    lines.push(`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`);
  }
  if (r.repeat) lines.push(`RRULE:FREQ=${r.repeat === 'year' ? 'YEARLY' : 'MONTHLY'}`);
  lines.push(`SUMMARY:${icsEscape(r.title)}`);
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  const alarm = (trigger) => lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(r.title)}`, `TRIGGER:${trigger}`, 'END:VALARM');
  // avviso il giorno stesso (alle 9 se senza ora) + avviso in anticipo
  alarm(r.time ? '-PT15M' : 'PT9H');
  // senza ora l'evento inizia a mezzanotte: "N giorni prima alle 9" = N*24-9 ore prima
  if (r.notice > 0) alarm(r.time ? `-P${r.notice}D` : `-PT${r.notice * 24 - 9}H`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function googleCalendarUrl(r) {
  const ymd = r.date.replace(/-/g, '');
  let dates;
  if (r.time) {
    const [h, m] = r.time.split(':');
    const end = new Date(parseDay(r.date).getTime() + ((+h) * 60 + (+m) + 30) * 60000);
    dates = `${ymd}T${h}${m}00/${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T${pad(end.getHours())}${pad(end.getMinutes())}00`;
  } else {
    const next = new Date(parseDay(r.date).getTime() + 86400000 + 3600000);
    dates = `${ymd}/${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
  }
  const p = new URLSearchParams({ action: 'TEMPLATE', text: r.title, dates, details: r.note || '' });
  if (r.repeat) p.set('recur', `RRULE:FREQ=${r.repeat === 'year' ? 'YEARLY' : 'MONTHLY'}`);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function addToCalendar(r) {
  if (isIOS()) {
    const file = new File([buildIcs(r)], 'promemoria.ics', { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = 'promemoria.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Apri il file scaricato e scegli "Aggiungi a Calendario"', 5000);
  } else {
    window.open(googleCalendarUrl(r), '_blank');
    toast('Si apre Google Calendar: tocca "Salva"', 4000);
  }
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
    return `<li data-id="${d.id}">${d.thumb ? `<img class="mini" src="${d.thumb}" alt="">` : ''}<div class="body"><div class="t">${highlight(d.title, terms)}</div>` +
      `<div class="s">${typeLabel(d)}${chunk.page ? ' · pagina ' + chunk.page : ''}${folderTag(d)}</div>` +
      `<div class="snip">${snippet(chunk.text, terms)}</div></div></li>`;
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
// ripulisce l'indirizzo: toglie spazi, "/api/tags" finale, aggiunge https:// se manca
function cleanUrl(u) {
  let s = (u || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  s = s.replace(/\/api(\/tags)?\/?$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/^(https?:\/\/[^/]+)/i, (m) => m.toLowerCase());
}
const baseUrl = () => cleanUrl(settings.url);

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
  const data = JSON.stringify({ app: 'archivio-ia', version: 2, exported: Date.now(), docs, folders, reminders });
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

// unisce: aggiunge quello che manca e aggiorna quello che nel file è più recente
async function mergeInto(list, incoming, store) {
  let added = 0, updated = 0;
  for (const x of incoming || []) {
    if (!x || !x.id) continue;
    const mine = list.find((y) => y.id === x.id);
    if (!mine) { list.push(x); await DB.put(x, store); added++; }
    else if ((x.updated || 0) > (mine.updated || 0)) { Object.assign(mine, x); await DB.put(mine, store); updated++; }
  }
  return { added, updated };
}

async function importAll(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'archivio-ia' || !Array.isArray(data.docs)) throw new Error('formato');
  } catch (e) {
    toast('Questo file non è un archivio valido', 3500);
    return;
  }
  try {
    const f = await mergeInto(folders, data.folders, 'folders');
    const d = await mergeInto(docs, data.docs, 'docs');
    const r = await mergeInto(reminders, data.reminders, 'reminders');
    index = null;
    renderDocs(); renderReminders();
    const parts = [d.added === 1 ? '1 documento nuovo' : `${d.added} documenti nuovi`];
    if (d.updated) parts.push(`${d.updated} aggiornati`);
    if (f.added) parts.push(f.added === 1 ? '1 cartella' : `${f.added} cartelle`);
    if (r.added) parts.push(`${r.added} promemoria`);
    toast('Importati: ' + parts.join(', '), 4000);
  } catch (e) {
    console.error(e);
    toast('Importazione interrotta: forse lo spazio sul telefono è finito', 4000);
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
  folders = await DB.all('folders') || [];
  reminders = await DB.all('reminders') || [];
  renderDocs();
  checkAI();
  // controlla le scadenze ogni volta che si torna sull'app
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAlertBar(); if (lastTab === 'reminders') renderReminders(); } });

  // chiede al sistema di non cancellare i dati
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('btnNewNote').onclick = () => openDoc(null);
  $('docList').onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) openDoc(li.dataset.id); };
  $('docFilter').oninput = renderDocs;
  $('fileInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('photoInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('btnBack').onclick = () => show(lastTab);
  $('btnSaveDoc').onclick = () => saveDoc();
  $('btnDeleteDoc').onclick = deleteDoc;

  // cartelle
  $('folderChips').onclick = async (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    const id = b.dataset.folder;
    if (id === 'new') {
      const f = await folderDialog(null);
      if (f) { currentFolder = f.id; renderDocs(); toast(`Cartella "${f.name}" creata`); }
    } else if (id === currentFolder && folderById(id)) {
      await folderDialog(folderById(id));
      renderDocs();
    } else { currentFolder = id; renderDocs(); }
  };
  $('docFolder').onchange = async () => {
    if ($('docFolder').value !== '__new') return;
    const f = await folderDialog(null);
    fillFolderSelect($('docFolder'), f ? f.id : null);
  };

  // foto a schermo intero
  $('docImages').onclick = (e) => {
    const img = e.target.closest('img');
    if (!img) return;
    $('imgViewer').querySelector('img').src = img.src;
    $('imgViewer').hidden = false;
  };
  $('imgViewer').onclick = () => { $('imgViewer').hidden = true; };

  // promemoria
  $('btnNewReminder').onclick = () => reminderDialog(null);
  $('btnDocReminder').onclick = async () => {
    const d = await saveDoc(true);
    reminderDialog(null, { title: d.title, docId: d.id });
  };
  $('reminderList').onclick = (e) => {
    const el = e.target.closest('[data-act]');
    const card = e.target.closest('.rem');
    if (!el || !card) return;
    const r = reminders.find((x) => x.id === card.dataset.id);
    if (!r) return;
    if (el.dataset.act === 'toggle') toggleReminder(r);
    else if (el.dataset.act === 'doc') openDoc(r.docId);
    else reminderDialog(r);
  };

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
    settings.url = cleanUrl($('setUrl').value);
    $('setUrl').value = settings.url;
    settings.model = $('setModel').value || settings.model;
    settings.k = Math.min(15, Math.max(2, +$('setK').value || 6));
    settings.save();
    toast('Impostazioni salvate');
    checkAI();
  };
  $('setModel').onchange = () => { settings.model = $('setModel').value; settings.save(); };
  const testConn = async () => {
    settings.url = cleanUrl($('setUrl').value);
    $('setUrl').value = settings.url;
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
      // capisce se il Mac risponde ma blocca l'app (permesso OLLAMA_ORIGINS mancante)
      let reachable = false;
      try { await fetchTimeout(baseUrl() + '/api/tags', { mode: 'no-cors' }, 6000); reachable = true; } catch (e2) { /* niente */ }
      out.textContent = reachable
        ? "✗ Il Mac mini risponde, ma blocca l'app. Sul Mac mini rifai il passo 2.4 (i due comandi launchctl) e poi chiudi e riapri Ollama."
        : '✗ Non riesco a raggiungere il Mac mini. Controlla che Tailscale sia acceso sul telefono, che il Mac mini sia acceso e che l\'indirizzo sia giusto.';
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
