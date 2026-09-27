/* Archivio IA — note e documenti con ricerca offline e domande a un'IA locale (Ollama). */
'use strict';

const APP_VERSION = '2.0.0';
const $ = (id) => document.getElementById(id);

/* ---------------- Archivio (IndexedDB) ---------------- */
// versione 2 del database: aggiunge cartelle e promemoria senza toccare i documenti già salvati
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('archivio-ia', 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['docs', 'folders', 'reminders', 'chats', 'shop']) {
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
let chats = [];           // conversazioni salvate con l'IA
let currentChat = null;   // conversazione aperta adesso
let currentFolder = 'home';// 'home' = schermata iniziale; altrimenti id cartella o 'all' / 'links' / 'none'
let shopItems = [];       // lista della spesa
let chatScope = '';       // cartella in cui cerca l'IA ('' = tutto l'archivio)
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
  // un documento senza testo (es. un link senza note) si trova comunque dal titolo
  if (!chunks.length) chunks.push({ docId: doc.id, page: null, text: doc.type === 'link' ? (doc.url || '') : '' });
  // il titolo aiuta a trovare il documento
  chunks[0].title = true;
  return chunks;
}

function buildIndex() {
  const chunks = [];
  const vocab = new Map(); // parola -> numero di pezzi che la contengono
  for (const d of docs) {
    for (const c of chunkDoc(d)) {
      const extra = d.type === 'link' ? ' ' + linkInfo(d.url).site + ' video link' : '';
      const toks = tokens((c.title ? d.title + extra + ' ' : '') + c.text);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      tf.forEach((_, t) => vocab.set(t, (vocab.get(t) || 0) + 1));
      c.tf = tf; c.len = toks.length || 1;
      c.titleToks = new Set(tokens(d.title + extra));
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

function search(query, limit = 20, scope = '') {
  if (!index) buildIndex();
  const qt = [...new Set(tokens(query))];
  if (!qt.length) return { results: [], terms: new Set() };
  const N = index.chunks.length;
  const expanded = qt.map(expandTerm);
  const allTerms = new Set();
  expanded.forEach((m) => m.forEach((_, w) => allTerms.add(w)));
  const k1 = 1.2, b = 0.75;
  const results = [];
  const allowed = scope ? new Set(docsIn(scope).map((d) => d.id)) : null;
  for (const c of index.chunks) {
    if (allowed && !allowed.has(c.docId)) continue;
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
const TITLES = { docs: 'Archivio', shop: 'Lista della spesa', search: 'Cerca', ask: 'Chiedi all\'IA', reminders: 'Promemoria', settings: 'Impostazioni', doc: '' };
let lastTab = 'docs';

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  const tab = view === 'shop' ? 'docs' : view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
  Voice.stop();
  $('viewTitle').textContent = view === 'doc' ? ($('docTitle').value || 'Nota') : TITLES[view];
  if (view !== 'doc') lastTab = view;
  if (view === 'search') setTimeout(() => $('searchInput').focus(), 50);
  if (view === 'ask') checkAI();
  if (view === 'settings') showStorage();
  if (view === 'reminders') renderReminders();
  if (view === 'docs') renderDocs();
  if (view === 'shop') renderShop();
  if (view === 'ask') renderScope();
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
  if (d.type === 'link') { const li = linkInfo(d.url); return `${li.emoji} ${li.site}`; }
  return 'Nota';
}

/* ---------------- Video e link ---------------- */
function linkInfo(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\.|^m\.|^web\./, ''); } catch (e) { /* niente */ }
  const is = (re) => re.test(host);
  if (is(/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/)) return { site: 'Facebook', emoji: '🎬', color: '#1877f2' };
  if (is(/(^|\.)(youtube\.com|youtu\.be)$/)) {
    const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
    return { site: 'YouTube', emoji: '▶︎', color: '#e62117', ytId: m ? m[1] : null };
  }
  if (is(/(^|\.)instagram\.com$/)) return { site: 'Instagram', emoji: '📸', color: '#c13584' };
  if (is(/(^|\.)tiktok\.com$/)) return { site: 'TikTok', emoji: '🎵', color: '#111' };
  if (is(/(^|\.)(wa\.me|whatsapp\.com)$/)) return { site: 'WhatsApp', emoji: '💬', color: '#25d366' };
  return { site: host || 'Link', emoji: '🔗', color: '#6b716d' };
}
// trova il primo indirizzo web dentro un testo (Facebook spesso condivide "testo + link")
function extractUrl(t) {
  const m = String(t || '').match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[).,;!?]+$/, '');
  const w = String(t || '').match(/(?:^|\s)((?:www\.|m\.)?[a-z0-9-]+\.(?:com|it|be|watch|me)\/[^\s]*)/i);
  return w ? 'https://' + w[1] : '';
}
function openUrl(url) {
  if (!url) return toast('Manca il link');
  window.open(url, '_blank', 'noopener');
}
let newDocType = 'note';
function newLink(prefill = {}) {
  newDocType = 'link';
  openDoc(null);
  $('docUrl').value = prefill.url || '';
  $('docTitle').value = prefill.title || '';
  $('docText').value = prefill.note || '';
  if (!prefill.url) setTimeout(() => $('docUrl').focus(), 60);
}

/* ---------------- Cartelle ---------------- */
const FOLDER_COLORS = ['#5b4cf0', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
const FOLDER_EMOJIS = ['📁', '🏠', '💊', '🚗', '💡', '🧾', '🍝', '🎬', '👵', '🐶', '🎓', '💼', '🏦', '🛠️', '✈️', '❤️', '📷', '🌿', '⚽', '🎁', '📚', '🧸', '🏥', '💰'];
const folderById = (id) => folders.find((f) => f.id === id);
const dot = (color) => `<span class="dot" style="background:${esc(color || '#64748b')}"></span>`;
const folderEmoji = (f) => (f && f.emoji) || '📁';
const sortedFolders = () => [...folders].sort((a, b) => a.name.localeCompare(b.name, 'it'));

function folderTag(d) {
  const f = d.folderId && folderById(d.folderId);
  return f ? ` · <span class="fold">${dot(f.color)}${esc(f.name)}</span>` : '';
}

function fillFolderSelect(sel, value) {
  sel.innerHTML = '<option value="">Nessuna cartella</option>' +
    sortedFolders().map((f) => `<option value="${f.id}">${folderEmoji(f)} ${esc(f.name)}</option>`).join('') +
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
    const emoji = folder ? folderEmoji(folder) : '📁';
    $('folderColors').innerHTML = FOLDER_COLORS.map((c, i) =>
      `<input type="radio" name="fcolor" id="fc${i}" value="${c}" ${c === color ? 'checked' : ''}><label for="fc${i}" style="background:${c}"></label>`).join('');
    // se la cartella ha un colore vecchio che non è più in lista, lo teniamo selezionato
    if (!FOLDER_COLORS.includes(color)) $('folderColors').insertAdjacentHTML('afterbegin', `<input type="radio" name="fcolor" id="fcold" value="${esc(color)}" checked><label for="fcold" style="background:${esc(color)}"></label>`);
    $('folderEmojis').innerHTML = FOLDER_EMOJIS.map((e, i) =>
      `<input type="radio" name="femoji" id="fe${i}" value="${e}" ${e === emoji ? 'checked' : ''}><label for="fe${i}">${e}</label>`).join('');
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const action = dlg.returnValue;
      if (action === 'save') {
        const name = $('folderName').value.trim();
        if (!name) return resolve(null);
        const c = (dlg.querySelector('input[name=fcolor]:checked') || {}).value || FOLDER_COLORS[0];
        const e = (dlg.querySelector('input[name=femoji]:checked') || {}).value || '📁';
        const f = folder || { id: uid(), created: Date.now() };
        f.name = name; f.color = c; f.emoji = e; f.updated = Date.now();
        if (!folder) folders.push(f);
        await DB.put(f, 'folders');
        renderDocs();
        resolve(f);
      } else if (action === 'delete' && folder) {
        const n = docs.filter((d) => d.folderId === folder.id).length;
        if (!confirm(`Eliminare la cartella "${folder.name}"?` + (n ? `\nI suoi ${n} documenti NON vengono cancellati: restano "senza cartella".` : ''))) return resolve(null);
        for (const d of docs.filter((x) => x.folderId === folder.id)) { d.folderId = null; d.updated = Date.now(); await DB.put(d); }
        folders = folders.filter((x) => x.id !== folder.id);
        await DB.del(folder.id, 'folders');
        if (currentFolder === folder.id) currentFolder = 'home';
        if (chatScope === folder.id) chatScope = '';
        renderDocs();
        toast('Cartella eliminata');
        resolve(null);
      } else resolve(null);
    };
    dlg.showModal();
    if (!folder) setTimeout(() => $('folderName').focus(), 50);
  });
}

/* ---------------- Home e cartelle ---------------- */
// cartelle "speciali" che non sono vere cartelle
const SPECIAL = {
  all: { name: 'Tutti i documenti', emoji: '📚', color: '#64748b' },
  links: { name: 'Video e link', emoji: '🎬', color: '#0ea5e9' },
  none: { name: 'Senza cartella', emoji: '🗂️', color: '#94a3b8' },
};
const folderMeta = (id) => folderById(id) || SPECIAL[id] || SPECIAL.all;
function docsIn(id) {
  if (id === 'all') return docs;
  if (id === 'links') return docs.filter((d) => d.type === 'link');
  if (id === 'none') return docs.filter((d) => !folderById(d.folderId));
  return docs.filter((d) => d.folderId === id);
}

function docItem(d, showFolder) {
  return `<li data-id="${d.id}">${docIcon(d)}<div class="body"><div class="t">${esc(d.title || 'Senza titolo')}</div>` +
    `<div class="s">${typeLabel(d)} · ${fmtDate(d.updated)}${showFolder ? folderTag(d) : ''}</div></div>` +
    (d.type === 'link' ? '<button class="go" data-open="1" type="button" aria-label="Apri">▶︎</button>' : '') + '</li>';
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Buonanotte' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

function renderDocs() {
  if (currentFolder !== 'home' && !SPECIAL[currentFolder] && !folderById(currentFolder)) currentFolder = 'home';
  const home = currentFolder === 'home';
  $('hero').hidden = !home;
  $('homeOnly').hidden = !home;
  $('folderHead').hidden = home;
  $('folderOnly').hidden = home;
  renderAlertBar();
  if (home) {
    $('viewTitle').textContent = 'Archivio';
    $('hello').textContent = greeting() + ' 👋';
    const toBuy = shopItems.filter((i) => !i.done).length;
    $('heroSub').textContent = `${docs.length} ${docs.length === 1 ? 'documento' : 'documenti'} · ${folders.length} ${folders.length === 1 ? 'cartella' : 'cartelle'}` +
      (dueCount() ? ` · ${dueCount()} promemoria` : '');
    $('shopCount').textContent = toBuy ? `${toBuy} ${toBuy === 1 ? 'cosa' : 'cose'} da comprare` : 'Niente da comprare';
    const card = (id, m, n) => `<button class="fcard" type="button" data-folder="${id}" style="--c:${esc(m.color || '#64748b')}">` +
      `<span class="fe">${m.emoji || '📁'}</span><span><span class="fn">${esc(m.name)}</span><br><span class="fc">${n} ${n === 1 ? 'elemento' : 'elementi'}</span></span></button>`;
    let html = sortedFolders().map((f) => card(f.id, { ...f, emoji: folderEmoji(f) }, docsIn(f.id).length)).join('');
    html += card('all', SPECIAL.all, docs.length);
    const nLinks = docsIn('links').length;
    if (nLinks) html += card('links', SPECIAL.links, nLinks);
    const loose = docsIn('none').length;
    if (folders.length && loose) html += card('none', SPECIAL.none, loose);
    html += '<button class="fcard add" type="button" data-folder="new"><span class="fe">＋</span><span class="fn">Nuova cartella</span></button>';
    $('folderGrid').innerHTML = html;
    const recent = [...docs].sort((a, b) => b.updated - a.updated).slice(0, 5);
    $('recentList').innerHTML = recent.map((d) => docItem(d, true)).join('');
    $('recentTitle').hidden = !recent.length;
    $('emptyDocs').hidden = docs.length > 0;
    $('emptyDocs').innerHTML = 'Non c\'è ancora niente.<br>Scrivi una nota, fai una foto, salva un video o aggiungi un PDF per cominciare.';
    return;
  }
  // dentro una cartella
  const m = folderMeta(currentFolder);
  const real = !!folderById(currentFolder);
  $('viewTitle').textContent = m.name;
  $('fName').textContent = m.name;
  $('fIcon').textContent = real ? folderEmoji(m) : m.emoji;
  $('fIcon').style.background = `linear-gradient(135deg, ${m.color}, ${m.color}cc)`;
  $('btnFolderEdit').hidden = !real;
  $('btnAskFolder').hidden = !real && currentFolder !== 'links';
  const f = norm($('docFilter').value.trim());
  const list = docsIn(currentFolder).filter((d) => !f || norm(d.title).includes(f)).sort((a, b) => b.updated - a.updated);
  $('docList').innerHTML = list.map((d) => docItem(d, !real)).join('');
  $('emptyDocs').hidden = list.length > 0;
  $('emptyDocs').innerHTML = f ? 'Nessun documento con questo titolo.' : 'Questa cartella è vuota.<br>Usa i pulsanti qui sopra: quello che aggiungi finisce qui dentro.';
}

function openFolder(id) {
  currentFolder = id;
  $('docFilter').value = '';
  renderDocs();
  window.scrollTo(0, 0);
}

function docById(id) { return docs.find((d) => d.id === id); }
function docIcon(d) {
  if (d.type === 'link') {
    const li = linkInfo(d.url);
    if (li.ytId) return `<img class="mini" src="https://i.ytimg.com/vi/${li.ytId}/mqdefault.jpg" alt="" onerror="this.outerHTML='<span class=&quot;ico&quot; style=&quot;background:${li.color}&quot;>${li.emoji}</span>'">`;
    return `<span class="ico" style="background:${li.color}">${li.emoji}</span>`;
  }
  if (d.thumb) return `<img class="mini" src="${d.thumb}" alt="">`;
  if (d.type === 'pdf') return '<span class="ico pdf">📕</span>';
  if (d.type === 'file') return '<span class="ico file">📄</span>';
  return '<span class="ico note">✏️</span>';
}
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
  if (d) newDocType = d.type;
  const isLink = newDocType === 'link';
  $('docLinkBox').hidden = !isLink;
  $('docUrl').value = isLink && d ? (d.url || '') : '';
  $('docText').placeholder = isLink ? 'Di cosa parla? Es. "ricetta del tiramisù della nonna"' : 'Scrivi qui…';
  $('docText').classList.toggle('short', isLink);
  $('docMeta').textContent = d ? $('docMeta').textContent : (isLink ? 'Nuovo video o link' : 'Nuova nota');
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
  const type = d ? d.type : newDocType;
  let url = '';
  if (type === 'link') {
    url = extractUrl($('docUrl').value) || extractUrl($('docText').value);
    if (!url) { toast('Incolla il link del video (inizia con https://)', 3500); $('docUrl').focus(); return null; }
    $('docUrl').value = url;
  }
  const autoTitle = type === 'link' && !$('docTitle').value.trim() ? `Video ${linkInfo(url).site} del ${fmtDate(now)}` : title;
  if (d) {
    d.title = autoTitle;
    if (!d.pages) d.text = $('docText').value;
    if (type === 'link') d.url = url;
    d.folderId = folderId;
    d.updated = now;
  } else {
    d = { id: uid(), type, title: autoTitle, text: $('docText').value, folderId, created: now, updated: now };
    if (type === 'link') d.url = url;
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
    $('alertSlot').appendChild(bar);
  }
  bar.innerHTML = `<span style="font-size:22px">⏰</span><span style="flex:1">Hai <b>${n}</b> promemoria ${over ? `(${over} scadut${over === 1 ? 'o' : 'i'})` : 'in arrivo'}</span><span class="chev">›</span>`;
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

/* ---------------- Lettura ad alta voce (funziona anche senza internet) ---------------- */
const Voice = {
  btn: null,
  rate() { try { return +(localStorage.getItem('archivio-rate') || 1); } catch (e) { return 1; } },
  voice() {
    if (!('speechSynthesis' in window)) return null;
    const vs = speechSynthesis.getVoices().filter((v) => /^it/i.test(v.lang));
    // preferisce le voci migliori se ci sono
    return vs.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) || vs.find((v) => v.localService) || vs[0] || null;
  },
  clean(t) {
    return String(t || '')
      .replace(/\[\d+\]/g, '')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[*_#`>]+/g, '')
      .replace(/^\s*[-•·]\s+/gm, '')
      .replace(/—\s*(Pagina|Foto)\s*(\d+)\s*—/g, '$1 $2.')
      .replace(/[ \t]+/g, ' ')
      .trim();
  },
  // divide in frasi corte: alcuni telefoni si bloccano con testi lunghi
  pieces(t) {
    const out = [];
    for (const para of t.split(/\n+/)) {
      const sentences = para.match(/[^.!?;:]+[.!?;:]*/g) || [para];
      let buf = '';
      for (const s of sentences) {
        if ((buf + s).length > 220 && buf) { out.push(buf.trim()); buf = ''; }
        buf += s;
      }
      if (buf.trim()) out.push(buf.trim());
    }
    return out.filter((p) => /[\p{L}\p{N}]/u.test(p));
  },
  speak(text, btn) {
    if (!('speechSynthesis' in window)) return toast('Questo telefono non permette la lettura ad alta voce');
    const same = this.btn && this.btn === btn;
    this.stop();
    if (same) return; // secondo tocco = ferma
    const parts = this.pieces(this.clean(text));
    if (!parts.length) return toast('Non c\'è niente da leggere');
    this.btn = btn || null;
    if (btn) { btn.dataset.label = btn.textContent; btn.textContent = '⏹ Ferma'; btn.classList.add('on'); }
    const v = this.voice();
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = 'it-IT';
      if (v) u.voice = v;
      u.rate = this.rate();
      if (i === parts.length - 1) u.onend = () => { if (this.btn === btn) this.reset(); };
      u.onerror = () => { if (this.btn === btn) this.reset(); };
      speechSynthesis.speak(u);
    });
  },
  reset() {
    if (this.btn) { this.btn.textContent = this.btn.dataset.label || '🔊 Leggi'; this.btn.classList.remove('on'); }
    this.btn = null;
  },
  stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.reset();
  },
};
if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); }

/* ---------------- Lista della spesa ---------------- */
function renderShop() {
  const todo = shopItems.filter((i) => !i.done).sort((a, b) => a.created - b.created);
  const done = shopItems.filter((i) => i.done).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const li = (i) => `<li data-id="${i.id}" class="${i.done ? 'done' : ''}"><span class="box">${i.done ? '✓' : ''}</span>` +
    `<span class="txt">${esc(i.text)}</span><button class="x" type="button" data-del="1" aria-label="Togli">✕</button></li>`;
  $('shopList').innerHTML = todo.map(li).join('') + (done.length ? `<li class="sep">Nel carrello · ${done.length}</li>` + done.map(li).join('') : '');
  $('emptyShop').hidden = shopItems.length > 0;
  $('shopActions').hidden = !shopItems.length;
  $('btnShopClear').hidden = !done.length;
}

async function addShopItems(texts) {
  const have = new Set(shopItems.filter((i) => !i.done).map((i) => norm(i.text)));
  let n = 0;
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t || have.has(norm(t))) continue;
    have.add(norm(t));
    const now = Date.now();
    const item = { id: uid(), text: t, done: false, created: now + n, updated: now };
    shopItems.push(item);
    await DB.put(item, 'shop');
    n++;
  }
  return n;
}

// trova gli ingredienti o le cose da comprare dentro una risposta dell'IA
function parseListItems(answer) {
  const lines = String(answer || '').split('\n');
  const itemRe = /^\s*(?:[-*•·]|\d+[.)])\s+(.+)$/;
  const clean = (t) => t.replace(/\*\*/g, '').replace(/\[\d+\]/g, '').replace(/\s*[:：]\s*$/, '').trim();
  const start = lines.findIndex((l) => /ingredient|occorrente|ti serv|da comprare|lista della spesa|spesa/i.test(l));
  const collect = (from, onlyBullets) => {
    const out = [];
    for (let i = from; i < lines.length; i++) {
      const m = lines[i].match(itemRe);
      if (m) {
        if (onlyBullets && /^\s*\d/.test(lines[i])) continue;
        out.push(clean(m[1]));
      } else if (from > 0 && out.length && lines[i].trim()) break; // fine della lista degli ingredienti
    }
    return out;
  };
  let items = start >= 0 ? collect(start + 1, false) : [];
  if (items.length < 2) items = collect(0, true);
  return items.filter((t) => t.length > 1 && t.length <= 80);
}

function shareShop() {
  const todo = shopItems.filter((i) => !i.done);
  if (!todo.length) return toast('Non c\'è niente da comprare');
  const text = '🛒 Lista della spesa\n' + todo.map((i) => '• ' + i.text).join('\n');
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Lista copiata: incollala su WhatsApp')).catch(() => toast('Non riesco a copiare'));
  }
}

/* ---------------- Cartella in cui cerca l'IA ---------------- */
function renderScope() {
  const sel = $('askScope');
  if (chatScope && !folderById(chatScope) && chatScope !== 'links') chatScope = '';
  sel.innerHTML = '<option value="">📚 Tutto l\'archivio</option>' +
    sortedFolders().map((f) => `<option value="${f.id}">${folderEmoji(f)} ${esc(f.name)}</option>`).join('') +
    (docsIn('links').length ? '<option value="links">🎬 Video e link</option>' : '');
  sel.value = chatScope;
  $('scopeRow').hidden = chatMode === 'free';
}
function scopeName() { return chatScope ? folderMeta(chatScope).name : ''; }

function answerActions(bubble, answer) {
  const canShop = parseListItems(answer).length >= 2;
  const bar = document.createElement('div');
  bar.className = 'bactions';
  bar.innerHTML = '<button type="button" data-act="speak">🔊 Leggi</button>' +
    (canShop ? '<button type="button" data-act="shop">🛒 Alla spesa</button>' : '') +
    '<button type="button" data-act="copy">📋 Copia</button>';
  bar.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'speak') Voice.speak(answer, b);
    if (b.dataset.act === 'shop') {
      const n = await addShopItems(parseListItems(answer));
      toast(n ? `Aggiunt${n === 1 ? 'a 1 cosa' : `e ${n} cose`} alla lista della spesa 🛒` : 'Erano già tutte nella lista', 3000);
    }
    if (b.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(answer); toast('Risposta copiata'); } catch (err) { toast('Non riesco a copiare'); }
    }
  };
  bubble.appendChild(bar);
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
    return `<li data-id="${d.id}">${docIcon(d)}<div class="body"><div class="t">${highlight(d.title, terms)}</div>` +
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
    return `<a data-src="${i}">[${i + 1}] ${esc(d ? d.title : (s.title || '?'))}${s.page ? ' · pag. ' + s.page : ''}</a>`;
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
    if (!s) return;
    if (!docById(s.docId)) return toast('Questo documento è stato eliminato');
    openDoc(s.docId, terms);
  });
}

let chatMode = 'docs'; // 'docs' = risponde sui documenti, 'free' = domanda libera

/* ---------------- Chat salvate ---------------- */
async function saveChatTurn(q, answer, sources) {
  try {
    const now = Date.now();
    if (!currentChat) {
      currentChat = { id: uid(), mode: chatMode, scope: chatMode === 'free' ? '' : chatScope, title: q.replace(/\s+/g, ' ').slice(0, 70), messages: [], created: now };
      chats.push(currentChat);
    }
    currentChat.messages.push(
      { role: 'user', content: q },
      { role: 'assistant', content: answer, sources: sources.map((c) => ({ docId: c.docId, page: c.page, text: c.text, title: (docById(c.docId) || {}).title })) },
    );
    currentChat.scope = chatMode === 'free' ? '' : chatScope;
    currentChat.updated = now;
    await DB.put(currentChat, 'chats');
  } catch (e) { console.error(e); }
}

function clearChatView() {
  chatHistory = [];
  currentChat = null;
  [...$('chat').querySelectorAll('.bubble:not(.intro)')].forEach((b) => b.remove());
}

function setChatMode(m, silent) {
  chatMode = m === 'free' ? 'free' : 'docs';
  try { localStorage.setItem('archivio-chatmode', chatMode); } catch (e) { /* niente */ }
  document.querySelectorAll('#chatMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === chatMode));
  $('chatIntro').innerHTML = chatMode === 'free'
    ? 'Chiedimi quello che vuoi: una ricetta, un consiglio, una spiegazione, una traduzione, un messaggio da scrivere…<br><span class="muted small">Non guardo i tuoi documenti e non ho internet: per notizie, prezzi e orari controlla sempre.</span>'
    : 'Fammi una domanda sui vostri documenti. Rispondo usando solo quello che c\'è dentro l\'archivio.<br><span class="muted small">Se l\'IA non è raggiungibile, ti mostro comunque i risultati della ricerca.</span>';
  $('askInput').placeholder = chatMode === 'free' ? 'Chiedi quello che vuoi…' : 'Scrivi una domanda sui documenti…';
  if ($('scopeRow')) $('scopeRow').hidden = chatMode === 'free';
  if (!silent) clearChatView();
}

function openChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  setChatMode(c.mode, true);
  chatScope = c.scope && (folderById(c.scope) || c.scope === 'links') ? c.scope : '';
  clearChatView();
  currentChat = c;
  for (const m of c.messages) {
    if (m.role === 'user') addBubble('user', esc(m.content));
    else {
      const src = m.sources || [];
      const b = addBubble('ai', renderAnswer(m.content, src) + sourcesHtml(src));
      bindSources(b, src, new Set());
      answerActions(b, m.content);
    }
    chatHistory.push({ role: m.role, content: m.content });
  }
  show('ask');
  setTimeout(() => { const last = $('chat').lastElementChild; if (last) last.scrollIntoView({ block: 'end' }); }, 50);
}

function renderChatList() {
  const list = [...chats].sort((a, b) => b.updated - a.updated);
  $('chatList').innerHTML = list.length ? list.map((c) => {
    const n = c.messages.filter((m) => m.role === 'user').length;
    return `<li data-id="${c.id}"><div class="body"><div class="t">${esc(c.title)}</div>` +
      `<div class="s">${c.mode === 'free' ? '💬 Libera' : '📚 Documenti'} · ${fmtDate(c.updated)} · ${n} ${n === 1 ? 'domanda' : 'domande'}</div></div>` +
      '<button type="button" class="del" data-del="1" aria-label="Elimina">🗑</button></li>';
  }).join('') : '<p class="empty">Nessuna chat salvata.<br>Le conversazioni con l\'IA si salvano da sole qui.</p>';
}

const FREE_PROMPT = `Sei un assistente gentile e disponibile per una famiglia italiana.
Rispondi SEMPRE in italiano, in modo semplice, chiaro e non troppo lungo.
Puoi parlare di qualsiasi argomento: ricette, consigli, spiegazioni, traduzioni, messaggi da scrivere.
Non hai accesso a internet: se una domanda riguarda notizie recenti, prezzi o orari attuali, dillo e suggerisci di controllare.
Se non sei sicuro di qualcosa, dillo onestamente invece di inventare.
Quando dai una ricetta, scrivi prima la riga "Ingredienti:" e sotto l'elenco degli ingredienti, uno per riga, ognuno che inizia con "- ".`;

async function ask(question) {
  addBubble('user', esc(question));
  const q = question;
  const free = chatMode === 'free';
  // per le domande di seguito ("e quando scade?") usa anche la domanda precedente
  const prevQ = chatHistory.filter((m) => m.role === 'user').slice(-1)[0];
  const scope = free ? '' : chatScope;
  let { results, terms } = search(q, settings.k, scope);
  if (results.length < 2 && prevQ) ({ results, terms } = search(prevQ.content + ' ' + q, settings.k, scope));
  const found = results.map((r) => r.chunk);
  const sources = free ? [] : found;

  const online = await checkAI();
  if (!online || !settings.model) {
    const why = !baseUrl() ? "L'IA non è ancora configurata (vai in Impostazioni)."
      : !navigator.onLine ? 'Sei senza internet, quindi l\'IA non è raggiungibile.'
        : "Non riesco a raggiungere l'IA sul Mac mini (è acceso? Tailscale è attivo?).";
    const html = `<div class="warn">${why}</div>` + (found.length
      ? (free ? 'Senza IA non posso rispondere a domande libere, ma ecco cosa ho trovato nei tuoi documenti:' : 'Ecco cosa ho trovato nei documenti:') + found.map((c, i) => {
        const d = docById(c.docId);
        return `<div style="margin-top:10px"><a class="cite" data-src="${i}">${esc(d.title)}${c.page ? ' · pag. ' + c.page : ''}</a><div class="small">${snippet(c.text, terms, 220)}</div></div>`;
      }).join('')
      : (free ? 'Le domande libere funzionano solo quando l\'IA è collegata.' : 'E nella ricerca normale non ho trovato niente con queste parole.'));
    bindSources(addBubble('ai', html), found, terms);
    return;
  }

  let messages;
  if (free) {
    messages = [{ role: 'system', content: FREE_PROMPT }, ...chatHistory.slice(-8), { role: 'user', content: q }];
  } else {
    const context = sources.length
      ? sources.map((c, i) => {
        const d = docById(c.docId);
        const extra = d.type === 'link' ? `, link: ${d.url}` : '';
        return `[${i + 1}] Documento: "${d.title}"${c.page ? `, pagina ${c.page}` : ''}${extra}\n${c.text}`;
      }).join('\n\n---\n\n')
      : `(Nessun estratto trovato per questa domanda${scope ? ` nella cartella "${scopeName()}"` : ''}.)`;
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...chatHistory.slice(-6),
      { role: 'user', content: `Estratti dai documenti:\n\n${context}\n\nDomanda: ${q}` },
    ];
  }

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
    if (answer) answerActions(bubble, answer);
    chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
    saveChatTurn(q, answer, sources);
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
  const data = JSON.stringify({ app: 'archivio-ia', version: 4, exported: Date.now(), docs, folders, reminders, chats, shop: shopItems });
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
    const c = await mergeInto(chats, data.chats, 'chats');
    await mergeInto(shopItems, data.shop, 'shop');
    index = null;
    renderDocs(); renderReminders();
    const parts = [d.added === 1 ? '1 documento nuovo' : `${d.added} documenti nuovi`];
    if (d.updated) parts.push(`${d.updated} aggiornati`);
    if (f.added) parts.push(f.added === 1 ? '1 cartella' : `${f.added} cartelle`);
    if (r.added) parts.push(`${r.added} promemoria`);
    if (c.added) parts.push(c.added === 1 ? '1 chat' : `${c.added} chat`);
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
  chats = await DB.all('chats') || [];
  shopItems = await DB.all('shop') || [];
  renderDocs();
  checkAI();
  // controlla le scadenze ogni volta che si torna sull'app
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAlertBar(); if (lastTab === 'reminders') renderReminders(); } });

  // chiede al sistema di non cancellare i dati
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    // toccare "Home" quando sei già nell'archivio riporta alla schermata iniziale
    if (b.dataset.view === 'docs' && lastTab === 'docs' && $('view-docs').classList.contains('active')) currentFolder = 'home';
    show(b.dataset.view);
  }));
  $('btnNewNote').onclick = () => { newDocType = 'note'; openDoc(null); };
  $('btnNewLink').onclick = () => newLink();
  $('docList').onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('[data-open]')) { const d = docById(li.dataset.id); if (d) openUrl(d.url); return; }
    openDoc(li.dataset.id);
  };
  $('btnOpenUrl').onclick = () => openUrl(extractUrl($('docUrl').value));
  $('btnPasteUrl').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      const u = extractUrl(t);
      if (!u) return toast('Negli appunti non c\'è un link');
      $('docUrl').value = u;
      const rest = t.replace(u, '').replace(/\s{2,}/g, ' ').trim();
      if (rest && !$('docText').value.trim()) $('docText').value = rest;
    } catch (e) { toast('Tieni premuto nel campo del link e scegli "Incolla"', 3500); $('docUrl').focus(); }
  };

  // modalità della chat
  let savedMode = 'docs';
  try { savedMode = localStorage.getItem('archivio-chatmode') || 'docs'; } catch (e) { /* niente */ }
  setChatMode(savedMode, true);
  $('chatMode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b && b.dataset.mode !== chatMode) setChatMode(b.dataset.mode); };
  $('btnChats').onclick = () => { renderChatList(); $('chatsDialog').showModal(); };
  $('chatList').onclick = async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const c = chats.find((x) => x.id === li.dataset.id);
    if (!c) return;
    if (e.target.closest('[data-del]')) {
      if (!confirm(`Eliminare la chat "${c.title}"?`)) return;
      chats = chats.filter((x) => x.id !== c.id);
      await DB.del(c.id, 'chats');
      if (currentChat && currentChat.id === c.id) clearChatView();
      renderChatList();
      return;
    }
    $('chatsDialog').close();
    openChat(c.id);
  };

  // arrivato dal tasto "Condividi" di Facebook/YouTube (Android)
  const sp = new URLSearchParams(location.search);
  if (sp.has('share_url') || sp.has('share_text') || sp.has('share_title')) {
    const all = [sp.get('share_url'), sp.get('share_text'), sp.get('share_title')].filter(Boolean).join(' ');
    const url = extractUrl(all);
    const note = (sp.get('share_text') || '').replace(url, '').trim();
    history.replaceState(null, '', location.pathname);
    setTimeout(() => { newLink({ url, note, title: (sp.get('share_title') || '').slice(0, 80) }); toast('Scrivi di cosa parla e premi Salva', 3500); }, 100);
  }
  $('docFilter').oninput = renderDocs;
  $('fileInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('photoInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('btnBack').onclick = () => show(lastTab);
  $('btnSaveDoc').onclick = () => saveDoc();
  $('btnDeleteDoc').onclick = deleteDoc;

  // cartelle
  const newFolder = async () => {
    const f = await folderDialog(null);
    if (f) { openFolder(f.id); toast(`Cartella "${f.name}" creata`); }
  };
  $('folderGrid').onclick = (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    if (b.dataset.folder === 'new') newFolder(); else openFolder(b.dataset.folder);
  };
  $('btnNewFolder').onclick = newFolder;
  $('btnFolderBack').onclick = () => openFolder('home');
  $('btnFolderEdit').onclick = async () => { const f = folderById(currentFolder); if (f) { await folderDialog(f); renderDocs(); } };
  $('btnAskFolder').onclick = () => {
    const changed = chatMode !== 'docs' || chatScope !== currentFolder;
    chatScope = currentFolder;
    if (changed) setChatMode('docs');
    show('ask');
    toast(`L'IA ora cerca solo in "${folderMeta(currentFolder).name}"`, 3000);
  };
  $('heroSearch').onclick = () => show('search');
  $('recentList').onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('[data-open]')) { const d = docById(li.dataset.id); if (d) openUrl(d.url); return; }
    openDoc(li.dataset.id);
  };

  // lista della spesa
  $('shopCard').onclick = () => show('shop');
  $('btnShopBack').onclick = () => show('docs');
  $('shopForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('shopInput').value.trim();
    if (!v) return;
    await addShopItems(v.split(/[,\n]+/));
    $('shopInput').value = '';
    renderShop();
    $('shopInput').focus();
  };
  $('shopList').onclick = async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const it = shopItems.find((x) => x.id === li.dataset.id);
    if (!it) return;
    if (e.target.closest('[data-del]')) {
      shopItems = shopItems.filter((x) => x.id !== it.id);
      await DB.del(it.id, 'shop');
    } else {
      it.done = !it.done; it.updated = Date.now();
      await DB.put(it, 'shop');
    }
    renderShop();
  };
  $('btnShopClear').onclick = async () => {
    const done = shopItems.filter((x) => x.done);
    for (const it of done) await DB.del(it.id, 'shop');
    shopItems = shopItems.filter((x) => !x.done);
    renderShop();
    toast(`Tolte ${done.length} cose già prese`);
  };
  $('btnShopShare').onclick = shareShop;

  // voce
  $('btnSpeakDoc').onclick = (e) => Voice.speak(`${$('docTitle').value}.\n${$('docText').value}`, e.currentTarget);
  try { $('setRate').value = String(Voice.rate()); } catch (e) { /* niente */ }
  $('setRate').onchange = () => { try { localStorage.setItem('archivio-rate', $('setRate').value); } catch (e) { /* niente */ } };
  $('btnTestVoice').onclick = (e) => Voice.speak('Ciao! Sono la voce del tuo archivio. Posso leggerti le risposte e i documenti.', e.currentTarget);

  // cartella in cui cerca l'IA
  $('askScope').onchange = () => {
    chatScope = $('askScope').value;
    toast(chatScope ? `L'IA cerca solo in "${scopeName()}"` : 'L\'IA cerca in tutto l\'archivio');
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
    if (!d) return;
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
  $('btnClearChat').onclick = () => { clearChatView(); toast('Nuova conversazione (quella di prima è tra le chat salvate)', 3000); };

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
