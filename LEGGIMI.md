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

## Da sapere

- I **PDF scansionati** (foto di fogli) non contengono testo, quindi l'app non ci può cercare dentro. Vanno bene i PDF "veri", quelli in cui puoi selezionare il testo.
- Se cancelli l'app dal telefono, cancelli anche i documenti. **Esporta prima.**
- Per aggiornare l'app: carica i file nuovi su GitHub. I telefoni prendono l'aggiornamento la volta dopo che la aprono con internet.
