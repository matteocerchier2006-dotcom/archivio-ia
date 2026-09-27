/* Tiene l'app salvata sul telefono, così si apre anche senza internet. */
const CACHE = 'archivio-ia-v2.0.0';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
// lettore di foto (circa 10 MB): si scarica in sottofondo, se non ci riesce riprova la volta dopo
const OCR_FILES = [
  'lib/ocr/tesseract.min.js', 'lib/ocr/worker.min.js', 'lib/ocr/ita.traineddata.gz',
  'lib/ocr/tesseract-core-simd-lstm.wasm.js', 'lib/ocr/tesseract-core-lstm.wasm.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    // cache: 'reload' = prende sempre la versione nuova dal sito, non quella vecchia in memoria
    await c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    await Promise.allSettled(OCR_FILES.map((f) => c.add(new Request(f, { cache: 'reload' }))));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // le richieste all'IA (altro indirizzo) non passano dalla cache
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // file grandi del lettore di foto: prima la copia salvata (non cambiano mai)
  if (url.pathname.includes('/lib/')) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // il resto: prima la rete (così prendi gli aggiornamenti), se non c'è usa la copia salvata
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
