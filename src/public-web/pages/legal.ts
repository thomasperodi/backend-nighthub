import { LEGAL } from '../public-web.config';
import { escapeHtml, page } from './layout';

// DRAFT texts written from what the backend actually stores (prisma/schema.prisma).
// They must be reviewed by a lawyer before being relied upon, especially for users aged
// 14-17. Keep them in sync when new personal data starts being collected.

const owner = `${escapeHtml(LEGAL.ownerName)}, ${escapeHtml(LEGAL.ownerCity)}`;
const email = `<a href="mailto:${escapeHtml(LEGAL.contactEmail)}">${escapeHtml(LEGAL.contactEmail)}</a>`;
const updated = `<p class="muted">Ultimo aggiornamento: ${escapeHtml(LEGAL.lastUpdated)}</p>`;

export function renderPrivacy(): string {
  return page({
    title: 'Privacy · NightHub',
    body: `
    <h1>Informativa sulla privacy</h1>
    ${updated}

    <h2>Chi tratta i tuoi dati</h2>
    <p>Il titolare del trattamento è ${owner}. Per qualsiasi domanda o richiesta sui tuoi dati scrivi a ${email}.</p>

    <h2>Quali dati raccogliamo</h2>
    <ul>
      <li><strong>Account:</strong> nome, email, username, password (salvata solo in forma cifrata), data di nascita e, se li inserisci, telefono, sesso e foto profilo.</li>
      <li><strong>Serate:</strong> le liste e i tavoli a cui ti iscrivi, gli ingressi registrati al locale (QR) e l'eventuale PR che ti ha invitato.</li>
      <li><strong>Amici:</strong> richieste di amicizia, amici e gruppi. Di default i tuoi amici vedono a quali serate sei in lista: puoi nasconderlo in Profilo → Account e sicurezza → Privacy.</li>
      <li><strong>Permanenza nel locale:</strong> quando lo staff registra il tuo ingresso, e solo se ci dai il permesso, usiamo la posizione per capire quando esci dal locale (con "Consenti sempre" anche con l'app chiusa). Conserviamo solo orario di ingresso, uscita e durata, non il percorso. Ci serve per i badge e per consigliarti serate adatte a te; non la vedono né amici né locali (i locali vedono solo medie anonime). Puoi revocare il permesso dalle impostazioni del telefono.</li>
      <li><strong>Posizione condivisa con gli amici:</strong> solo se la attivi tu; puoi disattivarla in qualsiasi momento.</li>
      <li><strong>Dispositivo:</strong> il token per le notifiche push e le sessioni di accesso attive.</li>
      <li><strong>Badge e livelli:</strong> calcolati dalle serate a cui partecipi e dalle attività nell'app.</li>
      <li><strong>Segnalazioni e blocchi:</strong> se segnali o blocchi un utente conserviamo chi ha segnalato o bloccato chi, il motivo e la data. Chi viene segnalato o bloccato non lo sa e non sa chi è stato.</li>
    </ul>

    <h2>Perché li usiamo</h2>
    <ul>
      <li>Farti accedere, metterti in lista e generare il QR per l'ingresso (esecuzione del servizio).</li>
      <li>Permettere al locale di gestire l'ingresso e le prenotazioni della serata.</li>
      <li>Mostrarti cosa fanno i tuoi amici e inviarti notifiche sulle tue serate.</li>
      <li>Attribuire gli ingressi al PR che ti ha invitato.</li>
      <li>Sicurezza dell'account e prevenzione degli abusi.</li>
    </ul>
    <p>Non vendiamo i tuoi dati e non li usiamo per pubblicità di terzi.</p>

    <h2>Chi li vede</h2>
    <ul>
      <li><strong>Il locale</strong> della serata a cui ti iscrivi vede nome, lista e ingresso; lo staff alla porta vede il tuo nome quando scansiona il QR.</li>
      <li><strong>Il PR</strong> che ti ha invitato vede nome e foto profilo, mai email o telefono.</li>
      <li><strong>Il team di NightHub</strong> vede le segnalazioni (chi segnala, chi è segnalato, motivo, foto profilo e username) per decidere se rimuovere un contenuto o sospendere un account. Dei blocchi vede solo quante persone hanno bloccato un utente, mai chi.</li>
      <li><strong>Fornitori tecnici</strong> che ospitano il servizio per nostro conto: Vercel (server), Supabase (database e immagini), Expo (notifiche push).</li>
    </ul>

    <h2>Minori</h2>
    <p>Per registrarti devi avere almeno 14 anni: per questo ti chiediamo la data di nascita. L'ingresso ai singoli eventi può avere limiti di età più alti, decisi dal locale.</p>

    <h2>Per quanto tempo</h2>
    <p>Conserviamo i dati finché il tuo account è attivo. Se elimini l'account (Profilo → Account e sicurezza → Elimina account) i tuoi dati personali vengono cancellati o resi anonimi; restano solo dati aggregati e non riconducibili a te (per esempio il numero di ingressi di una serata).</p>

    <h2>I tuoi diritti</h2>
    <p>Puoi chiedere in qualsiasi momento di accedere ai tuoi dati, correggerli, cancellarli, limitarne l'uso, riceverne una copia o opporti al trattamento, scrivendo a ${email}. Hai anche diritto di presentare reclamo al Garante per la protezione dei dati personali (<a href="https://www.garanteprivacy.it">garanteprivacy.it</a>).</p>
    `,
  });
}

export function renderTerms(): string {
  return page({
    title: 'Termini di servizio · NightHub',
    body: `
    <h1>Termini di servizio</h1>
    ${updated}

    <h2>Il servizio</h2>
    <p>NightHub ti permette di scoprire le serate dei locali, metterti in lista, vedere a quali serate vanno i tuoi amici e mostrare un QR all'ingresso. Il servizio è offerto da ${owner} (${email}).</p>

    <h2>Il tuo account</h2>
    <ul>
      <li>Devi avere almeno 14 anni.</li>
      <li>I dati che inserisci devono essere veri, e l'account è personale: non cederlo e non condividere la password.</li>
      <li>Possiamo sospendere l'account in caso di abusi, contenuti offensivi o uso fraudolento dei QR.</li>
      <li>Puoi eliminare il tuo account quando vuoi dall'app.</li>
    </ul>

    <h2>Liste e ingresso</h2>
    <ul>
      <li>Mettersi in lista è gratuito. Il prezzo d'ingresso, se previsto, si paga al locale secondo il listino mostrato nell'app.</li>
      <li>Essere in lista non garantisce l'ingresso: il locale decide a sua discrezione e applica le proprie regole (età minima, dress code, capienza).</li>
      <li>La somministrazione di alcolici ai minori di 18 anni è vietata dalla legge.</li>
      <li>Il QR è personale: mostrarlo per far entrare un'altra persona può comportare la sospensione dell'account.</li>
    </ul>

    <h2>Eventi e locali</h2>
    <p>Le informazioni sugli eventi (orari, prezzi, programma) sono inserite dai locali, che ne sono responsabili. Un evento può essere modificato o annullato dal locale: in quel caso ti avvisiamo con una notifica quando possibile.</p>

    <h2>Comportamento</h2>
    <p>Non usare NightHub per molestare altri utenti, pubblicare contenuti illeciti o aggirare i controlli d'ingresso. Puoi segnalare o bloccare un utente dal suo profilo nell'app (oppure scrivere a ${email}): esaminiamo ogni segnalazione e possiamo rimuovere i contenuti inappropriati, come la foto profilo, o sospendere l'account. Chi blocchi viene rimosso dai tuoi amici e non può più trovarti né inviarti richieste; puoi sbloccarlo da Profilo → Account e sicurezza → Utenti bloccati.</p>

    <h2>Responsabilità</h2>
    <p>Facciamo il possibile perché il servizio funzioni sempre, ma non possiamo garantirlo senza interruzioni. Non siamo responsabili di quanto accade all'interno dei locali.</p>

    <h2>Modifiche</h2>
    <p>Possiamo aggiornare questi termini; se le modifiche sono importanti te lo diremo nell'app. Si applica la legge italiana.</p>

    <p class="muted"><a href="/legal/privacy">Informativa sulla privacy</a></p>
    `,
  });
}
