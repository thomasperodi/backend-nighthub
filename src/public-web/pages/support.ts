import { LEGAL } from '../public-web.config';
import { escapeHtml, page } from './layout';

// Support URL given to App Store Connect: it must answer 200 and show a way to reach us.
// Menu paths below match the Expo app (Profilo → Account e sicurezza, login screen).

const email = `<a href="mailto:${escapeHtml(LEGAL.contactEmail)}">${escapeHtml(LEGAL.contactEmail)}</a>`;

const SUPPORT_STYLES = `
  .card { background: #11131a; border: 1px solid #1f2330; border-radius: 14px; padding: 16px; margin: 16px 0 8px; }
  .card p { margin: 0 0 8px; }
  .card p:last-child { margin: 0; }
  .cta { display: inline-block; margin-top: 4px; padding: 10px 16px; border-radius: 10px; background: #5b7cff; color: #fff; font-weight: 700; text-decoration: none; }
`;

export function renderSupport(): string {
  return page({
    title: 'Supporto · NightHub',
    extraStyles: SUPPORT_STYLES,
    body: `
    <h1>Supporto</h1>
    <p>Hai un problema con l'app, una lista o il tuo account? Scrivici: rispondiamo di solito entro 48 ore.</p>

    <div class="card">
      <p><strong>Email:</strong> ${email}</p>
      <p class="muted">Indica l'email o lo username del tuo account e, se riguarda una serata, il nome del locale e la data.</p>
      <a class="cta" href="mailto:${escapeHtml(LEGAL.contactEmail)}?subject=${encodeURIComponent('Supporto NightHub')}">Scrivi al supporto</a>
    </div>

    <h2>Non riesco ad accedere</h2>
    <p>Nella schermata di accesso inserisci email o username e tocca "Password dimenticata?": ti mandiamo un'email per impostarne una nuova. Se l'email non arriva controlla lo spam o scrivici.</p>

    <h2>Liste e QR d'ingresso</h2>
    <p>Mettersi in lista è gratis. Il QR lo trovi nella serata a cui sei in lista e va mostrato alla porta. Il prezzo d'ingresso, se previsto, si paga al locale. Essere in lista non garantisce l'ingresso: le regole della serata (età, dress code, capienza) le decide il locale.</p>

    <h2>Posizione</h2>
    <p>NightHub usa la posizione solo dopo che lo staff ha registrato il tuo ingresso in un locale, per capire quando esci. Le coordinate restano sul telefono e non sono mai mostrate ad amici o locali. Puoi revocare il permesso in qualsiasi momento dalle impostazioni del telefono.</p>

    <h2>Segnalare o bloccare un utente</h2>
    <p>Apri il profilo dell'utente, tocca "⋯" in alto a destra e scegli "Segnala" o "Blocca". Gli utenti bloccati sono in Profilo → Account e sicurezza → Utenti bloccati. Per casi urgenti scrivi anche a ${email}.</p>

    <h2>Eliminare l'account</h2>
    <p>Dall'app: Profilo → Account e sicurezza → "Elimina account". I tuoi dati personali vengono cancellati o resi anonimi. Se non riesci più ad accedere, scrivici dall'email dell'account e lo eliminiamo noi.</p>

    <h2>Locali, organizzazioni e PR</h2>
    <p>Gli account professionali vengono attivati da NightHub. Se gestisci un locale o lavori come PR e vuoi usare NightHub, scrivi a ${email}.</p>

    <p class="muted"><a href="/legal/privacy">Informativa sulla privacy</a> · <a href="/legal/termini">Termini di servizio</a></p>
    `,
  });
}
