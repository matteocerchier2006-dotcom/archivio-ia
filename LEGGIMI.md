# Archivio IA: come metterla in funzione

L'app ha due parti:

- **L'app sul telefono** (iPhone e Android). Tiene i documenti salvati nel telefono e la ricerca funziona sempre, anche senza internet.
- **L'IA sul Mac mini**. Risponde alle domande leggendo i vostri documenti. Serve solo per la schermata "Chiedi".

Si fa tutto una volta sola. Segui i passi in ordine.

---

## Passo 1: installare l'IA sul Mac mini (circa 15 minuti)

1. Sul Mac mini vai su **ollama.com**, scarica Ollama e installalo come una normale app.
2. Apri il **Terminale** (Applicazioni › Utility › Terminale) e scrivi:
   ```
   ollama pull qwen2.5:7b
   ```
   Scarica il modello, circa 5 GB. Questo modello va bene in italiano.
   Se il Mac mini ha 24 GB di RAM o più, puoi usare `ollama pull qwen2.5:14b`, che è più intelligente ma un po' più lento.
3. Permetti all'app di parlare con Ollama. Nel Terminale scrivi:
   ```
   launchctl setenv OLLAMA_ORIGINS "*"
   ```
   Poi **chiudi Ollama** (dall'icona del lama in alto, "Quit Ollama") e **riaprilo**.
   ⚠︎ Questo comando va ripetuto ogni volta che riavvii il Mac mini. Se vuoi, poi lo rendiamo automatico.
4. Nelle Impostazioni del Mac mini, in **Batteria/Risparmio energia**, fai in modo che non vada in stop: l'IA funziona solo se il Mac è acceso.

## Passo 2: collegare i telefoni al Mac mini con Tailscale (circa 10 minuti)

Tailscale crea una "rete privata" tra i vostri dispositivi. Funziona a casa e fuori casa ed è gratuito.

1. Installa **Tailscale** sul Mac mini (da tailscale.com o dal Mac App Store) e accedi, per esempio con il tuo account Google.
2. Installa l'app **Tailscale** sul tuo telefono e su quello di tuo padre, ed entra **con lo stesso account**.
3. Dal computer vai su **login.tailscale.com** › **DNS**, attiva **MagicDNS** e poi **HTTPS Certificates**.
4. Sul Mac mini, nel Terminale:
   ```
   tailscale serve --bg 11434
   ```
   Se il comando "tailscale" non viene trovato (succede con la versione dell'App Store), usa:
   ```
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 11434
   ```
   Il comando risponde con un indirizzo tipo **https://mac-mini.tail1234.ts.net**. **Copialo**: ti serve dopo.

## Passo 3: mettere l'app online (gratis, circa 10 minuti)

L'app deve stare su un indirizzo web per poterla installare sui telefoni. I vostri documenti **non** vanno online: restano solo nei telefoni.

1. Crea un account su **github.com**.
2. Clicca **New repository**, chiamalo `archivio-ia`, lascialo **Public** e crealo.
3. Clicca **uploading an existing file** e trascina dentro **tutto il contenuto** della cartella `archivio-ia` (anche le cartelle `lib` e `icons`). Poi premi **Commit changes**.
4. Vai in **Settings** › **Pages**. Sotto "Branch" scegli **main**, poi **Save**.
5. Dopo un minuto l'app è su **https://TUONOME.github.io/archivio-ia/**

## Passo 4: installare l'app sui telefoni

**iPhone:** apri l'indirizzo con **Safari** › tasto **Condividi** (il quadrato con la freccia) › **Aggiungi alla schermata Home**.

**Android:** apri l'indirizzo con **Chrome** › menu **⋮** › **Installa app** (oppure "Aggiungi a schermata Home").

Da quel momento si apre dall'icona "Archivio", anche senza internet.

## Passo 5: collegare l'app all'IA

Nell'app vai su **Impostazioni**:

1. In "Indirizzo del Mac mini" incolla l'indirizzo del Passo 2 (quello con https://…ts.net).
2. Premi **Prova collegamento**. Deve comparire "✓ Collegato".
3. Scegli il modello e premi **Salva**.

In alto comparirà **"IA: collegata"**.

---

## Come si usa

- **Documenti**: con "Nuova nota" scrivi informazioni; con "Aggiungi file" carichi PDF o file di testo.
- **Cerca**: scrivi una parola e trova dove compare, anche se la scrivi un po' sbagliata. Funziona sempre.
- **Chiedi**: fai una domanda normale ("quando scade la garanzia della lavatrice?"). L'IA risponde e indica da quale documento ha preso l'informazione. Se l'IA non è raggiungibile, ti mostra comunque i risultati della ricerca.
- **Impostazioni › Esporta archivio**: crea un file con tutti i documenti. Mandalo a tuo padre (WhatsApp, email…) e lui lo apre con **Importa archivio**. Fallo anche ogni tanto come copia di sicurezza.

## Novità della versione 1.1

- **📷 Foto**: fotografa una bolletta, una ricetta o un foglio e l'app legge il testo. Se scegli più foto insieme diventano un solo documento, con una pagina per ogni foto. Funziona anche senza internet, ma la prima volta l'app deve essere aperta con internet per scaricare il "lettore" (circa 10 MB).
- **PDF scansionati**: adesso l'app legge anche quelli.
- **Cartelle**: tocca "＋ Cartella" per crearne una. Tocca di nuovo una cartella già selezionata per rinominarla o eliminarla (i documenti non si cancellano). Quello che aggiungi mentre sei dentro una cartella finisce lì.
- **⏰ Promemoria**: scadenze con avviso in anticipo, anche ripetute ogni mese o ogni anno. Un promemoria si può collegare a un documento. Con "Metti nel calendario" lo aggiungi al calendario del telefono, così ti arriva l'avviso anche con l'app chiusa.

## Novità della versione 1.2

- **💬 Domanda libera**: in "Chiedi" scegli in alto "Domanda libera" per chiedere qualsiasi cosa (ricette, consigli, traduzioni, messaggi da scrivere). L'IA sul Mac mini non ha internet: per notizie, prezzi e orari controlla sempre.
- **🎬 Video e link**: salva i video di Facebook, YouTube, Instagram, TikTok o qualsiasi link, con un titolo e una nota. Il tasto ▶︎ apre il video. Si possono mettere nelle cartelle e si trovano con Cerca e con l'IA ("qual era il video del tiramisù?").
  - **Android**: da Facebook tocca **Condividi** e scegli **Archivio**: si apre già con il link dentro.
  - **iPhone**: da Facebook tocca **Condividi › Copia link**, poi nell'app tocca **🎬 Video** e **📋 Incolla**.
  - Il video resta su Facebook: l'app salva il collegamento, non il video. Per guardarlo serve internet, e se chi l'ha pubblicato lo cancella non si vede più.

## Novità della versione 1.3

- **🕘 Chat salvate**: ogni conversazione con l'IA si salva da sola. In "Chiedi" tocca **🕘 Chat salvate** per riaprirne una, continuarla o eliminarla (🗑). Con **＋ Nuova conversazione** ne inizi una nuova, e quella di prima resta salvata. Le chat sono incluse anche in "Esporta archivio".

## Novità della versione 2.0

- **Grafica nuova**: colori indaco e viola, riquadri colorati e tema scuro automatico quando il telefono è in modalità scura.
- **Home a riquadri**: ogni cartella è un riquadro con la sua icona e il suo colore. Toccalo per entrarci. Con ✎ la rinomini, cambi icona e colore, o la elimini. Tocca **Home** in basso per tornare alla schermata iniziale.
- **IA su una sola cartella**: in "Chiedi", sotto l'interruttore, c'è **Cerca in**: scegli una cartella e l'IA risponde solo con i documenti di quella cartella. Dentro una cartella c'è anche il pulsante **✨ Chiedi all'IA su questa cartella**.
- **🔊 Lettura ad alta voce**: sotto ogni risposta dell'IA c'è **Leggi**, e c'è anche nei documenti. Tocca di nuovo per fermare. La velocità si cambia in Opzioni › Voce.
- **🛒 Lista della spesa**: dalla Home. Scrivi cosa comprare (anche più cose separate da virgola), tocca per spuntare, **Manda la lista** per inviarla su WhatsApp. Quando l'IA ti dà una ricetta, tocca **🛒 Alla spesa** per mettere gli ingredienti nella lista.

## Da sapere

- La lettura delle foto funziona bene con testo stampato e foto dritte e ben illuminate. Con la scrittura a mano sbaglia spesso: controlla il testo letto e correggilo se serve.
- Se cancelli l'app dal telefono, cancelli anche i documenti. **Esporta prima.**
- Per aggiornare l'app: carica i file nuovi su GitHub. I telefoni prendono l'aggiornamento la volta dopo che la aprono con internet.
