export type Locale = 'en' | 'de';

export const DEFAULT_LOCALE: Locale = 'en';

const EN = {
  'signIn.title': 'Sign in',
  'signIn.pitch': 'Recurring events never land on a fixed date — festivals, markets, tours. dontforget keeps a standing search and puts each new date on your calendar automatically.',
  'signIn.noPassword': "No password — we'll email you a link.",
  'signIn.placeholder': 'you@example.com',
  'signIn.button': 'Email me a link',
  'linkSent.text': 'Check your inbox — the link signs you in.',
  'empty.label': 'What do you want to track?',
  'empty.placeholder': 'e.g. Auer Dult Munich',
  'empty.button': 'Search',
  'empty.howItWorks': 'Search once, approve the dates you want, then subscribe to your private calendar feed — we re-run the search on a schedule and add new dates automatically.',
  'noResults.message': 'No dates found for “{query}” yet. Try a different search term below, or let this search run again on schedule.',
  'noResults.searchAgain': 'Search again',
  'noResults.backToDashboard': 'Back to dashboard',
  'noResults.cancel': 'Cancel',
  'loading.status': 'Searching → extracting dates…',
  'loading.cancel': 'Cancel',
  'loading.longer': 'Still working — this is taking longer than usual…',
  'review.checkAgain': 'Check again',
  'review.aiSuggested': 'AI suggested {interval}',
  'review.subtext': 'Approve the dates you want — they land on your private calendar feed. We re-run this search on the cadence above and add new dates automatically.',
  'review.approve': 'Approve selected ({count})',
  'common.source': 'source',
  'feedReady.title': 'Your feed is ready',
  'feedReady.subtext': 'Add these to your calendar app to subscribe. Future runs add new dates automatically — nothing to approve next time.',
  'common.calendarIcs': 'Calendar (ICS)',
  'common.rss': 'RSS',
  'feedReady.dashboard': 'Go to dashboard',
  'feedReady.searchAnother': 'Search another topic',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'calendarAdd.google': 'Google Calendar',
  'calendarAdd.apple': 'Apple Calendar',
  'calendarAdd.outlook': 'Outlook',
  'calendarAdd.aria': 'Add to {name}',
  'interval.weekly': 'Every week',
  'interval.monthly': 'Every month',
  'interval.quarterly': 'Every quarter',
  'interval.yearly': 'Every year',
  'dashboard.savedQueries': 'Saved queries',
  'dashboard.yourCalendar': 'Your calendar',
  'dashboard.lastSynced': 'Last synced',
  'dashboard.never': 'Never',
  'dashboard.rotate': 'Rotate feed URL',
  'dashboard.rotateSubtext': 'Leaked or shared your calendar link by mistake? Rotating mints a new one and breaks the old link immediately.',
  'dashboard.noCalendar': 'No calendar yet — approve your first search results to mint your private feed link.',
  'dashboard.signOut': 'Sign out',
  'dashboard.confirmRotate': 'Confirm rotate?',
  'queryCard.reruns': 'Re-runs',
  'queryCard.lastRun': 'Last run',
  'queryCard.events': 'Events',
  'queryCard.approved': '{count} approved',
  'queryCard.pending': '{count} pending approval',
  'queryCard.noneYet': 'None yet',
  'queryCard.edit': 'Edit',
  'queryCard.delete': 'Delete',
  'queryCard.confirmDelete': 'Confirm delete?',
  'edit.events': 'Events',
  'edit.saveHint': 'Saving approves the selected pending dates. {summary}',
  'edit.noEvents': 'No events extracted yet for this query yet.',
  'edit.query': 'Query',
  'edit.saveAndApprove': 'Save and approve ({count})',
  'edit.cancel': 'Cancel',
  'common.approved': '✓ approved',
  'error.dismissAria': 'Dismiss error',
  'error.loadingDashboard': 'Something went wrong while loading your dashboard. Please try again.',
  'error.requestingLink': 'Something went wrong while requesting your sign-in link. Please try again.',
  'error.searching': 'Something went wrong while searching. Please try again.',
  'error.approving': 'Something went wrong while approving events. Please try again.',
  'error.loadingEvents': 'Something went wrong while loading events. Please try again.',
  'error.saving': 'Something went wrong while saving changes. Please try again.',
  'error.deleting': 'Something went wrong while deleting the query. Please try again.',
  'error.rotating': 'Something went wrong while rotating your feed URL. Please try again.',
  'error.signingOut': 'Something went wrong while signing out. Please try again.',
  'error.loadingApp': 'Something went wrong while loading dontforget. Please try again.',
} as const;

export type MessageKey = keyof typeof EN;

const DE: Record<MessageKey, string> = {
  'signIn.title': 'Anmelden',
  'signIn.pitch': 'Wiederkehrende Termine stehen nie fest — Feste, Märkte, Touren. dontforget führt eine dauerhafte Suche und legt jedes neue Datum automatisch in deinen Kalender.',
  'signIn.noPassword': 'Kein Passwort — wir schicken dir einen Link.',
  'signIn.placeholder': 'du@beispiel.de',
  'signIn.button': 'Link per E-Mail senden',
  'linkSent.text': 'Prüf dein Postfach — der Link meldet dich an.',
  'empty.label': 'Was möchtest du verfolgen?',
  'empty.placeholder': 'z. B. Auer Dult München',
  'empty.button': 'Suchen',
  'empty.howItWorks': 'Einmal suchen, die gewünschten Termine bestätigen und dann deinen privaten Kalender-Feed abonnieren — wir führen die Suche regelmäßig erneut aus und ergänzen neue Termine automatisch.',
  'noResults.message': 'Für „{query}“ wurden noch keine Termine gefunden. Versuch unten einen anderen Suchbegriff — oder lass diese Suche planmäßig erneut laufen.',
  'noResults.searchAgain': 'Erneut suchen',
  'noResults.backToDashboard': 'Zum Dashboard',
  'noResults.cancel': 'Abbrechen',
  'loading.status': 'Suche → Termine extrahieren…',
  'loading.cancel': 'Abbrechen',
  'loading.longer': 'Läuft noch — das dauert gerade länger als üblich…',
  'review.checkAgain': 'Erneut prüfen',
  'review.aiSuggested': 'KI empfohlen: {interval}',
  'review.subtext': 'Bestätige die gewünschten Termine — sie landen auf deinem privaten Kalender-Feed. Wir führen diese Suche in dem Rhythmus oben erneut aus und ergänzen neue Termine automatisch.',
  'review.approve': 'Auswahl bestätigen ({count})',
  'common.source': 'Quelle',
  'feedReady.title': 'Dein Feed ist bereit',
  'feedReady.subtext': 'Füge diese Links in deiner Kalender-App hinzu, um zu abonnieren. Zukünftige Läufe ergänzen neue Termine automatisch — nichts muss erneut bestätigt werden.',
  'common.calendarIcs': 'Kalender (ICS)',
  'common.rss': 'RSS',
  'feedReady.dashboard': 'Zum Dashboard',
  'feedReady.searchAnother': 'Ein anderes Thema suchen',
  'common.copy': 'Kopieren',
  'common.copied': 'Kopiert',
  'calendarAdd.google': 'Google Kalender',
  'calendarAdd.apple': 'Apple Kalender',
  'calendarAdd.outlook': 'Outlook',
  'calendarAdd.aria': 'Zu {name} hinzufügen',
  'interval.weekly': 'Jede Woche',
  'interval.monthly': 'Jeden Monat',
  'interval.quarterly': 'Jedes Quartal',
  'interval.yearly': 'Jedes Jahr',
  'dashboard.savedQueries': 'Gespeicherte Suchanfragen',
  'dashboard.yourCalendar': 'Dein Kalender',
  'dashboard.lastSynced': 'Zuletzt synchronisiert',
  'dashboard.never': 'Nie',
  'dashboard.rotate': 'Feed-URL rotieren',
  'dashboard.rotateSubtext': 'Deinen Kalender-Link verloren oder versehentlich geteilt? Beim Rotieren wird ein neuer erstellt und der alte sofort ungültig.',
  'dashboard.noCalendar': 'Noch kein Kalender — bestätige die erste Suche, um deinen privaten Feed-Link zu erstellen.',
  'dashboard.signOut': 'Abmelden',
  'dashboard.confirmRotate': 'Rotieren bestätigen?',
  'queryCard.reruns': 'Läufe',
  'queryCard.lastRun': 'Letzter Lauf',
  'queryCard.events': 'Termine',
  'queryCard.approved': '{count} bestätigt',
  'queryCard.pending': '{count} offen',
  'queryCard.noneYet': 'Noch keine',
  'queryCard.edit': 'Bearbeiten',
  'queryCard.delete': 'Löschen',
  'queryCard.confirmDelete': 'Löschen bestätigen?',
  'edit.events': 'Termine',
  'edit.saveHint': 'Beim Speichern werden die ausgewählten, noch offenen Termine bestätigt. {summary}',
  'edit.noEvents': 'Für diese Suchanfrage wurden noch keine Termine extrahiert.',
  'edit.query': 'Suchanfrage',
  'edit.saveAndApprove': 'Speichern und bestätigen ({count})',
  'edit.cancel': 'Abbrechen',
  'common.approved': '✓ bestätigt',
  'error.dismissAria': 'Fehler schließen',
  'error.loadingDashboard': 'Beim Laden deines Dashboards ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.requestingLink': 'Beim Anfordern deines Anmelde-Links ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.searching': 'Bei der Suche ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.approving': 'Beim Bestätigen der Termine ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.loadingEvents': 'Beim Laden der Termine ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.saving': 'Beim Speichern der Änderungen ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.deleting': 'Beim Löschen der Suchanfrage ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.rotating': 'Beim Rotieren deiner Feed-URL ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.signingOut': 'Beim Abmelden ist etwas schiefgegangen. Bitte versuch es erneut.',
  'error.loadingApp': 'Beim Laden von dontforget ist etwas schiefgegangen. Bitte versuch es erneut.',
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en: EN, de: DE };

const INTERPOLATION_RE = /\{(\w+)\}/g;

export function detectLocale(languages: readonly string[] = navigator.languages ?? []): Locale {
  for (const lang of languages) {
    const base = lang?.split('-')[0].toLowerCase() ?? '';
    if (base === 'de') return 'de';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

let currentLocale: Locale = detectLocale();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  document.documentElement.lang = locale;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(INTERPOLATION_RE, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate(MESSAGES[currentLocale][key], vars);
}

export const MONTH_ABBREVS: Record<Locale, readonly string[]> = {
  en: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  de: ['JAN', 'FEB', 'MÄR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'],
};

export const DAY_NAMES: Record<Locale, readonly string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
};

export const MONTH_NAMES: Record<Locale, readonly string[]> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  de: [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ],
};