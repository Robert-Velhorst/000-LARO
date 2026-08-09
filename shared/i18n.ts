/** Dutch/English message catalog shared by the dashboard and scanner. */
export type Locale = "nl" | "en";
export const SUPPORTED_LOCALES: Locale[] = ["nl", "en"];
export const DEFAULT_LOCALE: Locale = "nl";

type Message = { nl: string; en: string };

export const messages = {
  "app.title": { nl: "LARO", en: "LARO" },
  "app.tagline": { nl: "Uw zelf-gehoste assistent voor juridisch bewijs", en: "Your self-hosted legal evidence agent" },
  "language.label": { nl: "Taal", en: "Language" },
  "language.dutch": { nl: "Nederlands", en: "Dutch" },
  "language.english": { nl: "Engels", en: "English" },
  "common.back": { nl: "Terug", en: "Back" },
  "common.cancel": { nl: "Annuleren", en: "Cancel" },
  "common.close": { nl: "Sluiten", en: "Close" },
  "common.loading": { nl: "Laden...", en: "Loading..." },
  "common.processing": { nl: "Bezig...", en: "Processing..." },
  "common.refresh": { nl: "Vernieuwen", en: "Refresh" },
  "common.remove": { nl: "Verwijderen", en: "Remove" },
  "common.retry": { nl: "Opnieuw proberen", en: "Retry" },
  "common.save": { nl: "Opslaan", en: "Save" },
  "nav.home": { nl: "Start", en: "Home" },
  "nav.cases": { nl: "Mijn zaken", en: "My Cases" },
  "nav.evidence": { nl: "Bewijs", en: "Evidence" },
  "nav.outreach": { nl: "Benadering", en: "Outreach" },
  "nav.help": { nl: "Hulp en informatie", en: "Help & Resources" },
  "nav.admin": { nl: "Beheer", en: "Admin" },
  "nav.adminPanel": { nl: "Beheerpaneel", en: "Admin Panel" },
  "nav.analytics": { nl: "Analyse", en: "Analytics" },
  "nav.settings": { nl: "Instellingen", en: "Settings" },
  "nav.signOut": { nl: "Afmelden", en: "Sign out" },
  "nav.expandSidebar": { nl: "Zijbalk uitklappen", en: "Expand sidebar" },
  "nav.collapseSidebar": { nl: "Zijbalk inklappen", en: "Collapse sidebar" },
  "nav.accountMenu": { nl: "Accountmenu openen", en: "Open account menu" },
  "route.notFound": { nl: "Pagina niet gevonden", en: "Page not found" },
  "route.notFoundHint": { nl: "Gebruik de zijbalk om te navigeren.", en: "Use the sidebar to navigate." },
  "legal.noticeLabel": { nl: "Melding juridische ondersteuning", en: "Legal assistance notice" },
  "legal.noticeTitle": { nl: "Juridische ondersteuning, geen juridisch advies.", en: "Legal assistance, not legal advice." },
  "legal.noticeBody": {
    nl: "Laat belangrijke analyses en gegenereerde documenten beoordelen door een bevoegde advocaat voordat u erop vertrouwt.",
    en: "Have important analyses and generated documents reviewed by a qualified lawyer before relying on them.",
  },
  "auth.signIn": { nl: "Inloggen", en: "Sign In" },
  "auth.signUp": { nl: "Account aanmaken", en: "Create Account" },
  "auth.submitSignUp": { nl: "Registreren", en: "Sign Up" },
  "auth.resetPassword": { nl: "Wachtwoord herstellen", en: "Reset Password" },
  "auth.enterResetCode": { nl: "Herstelcode invoeren", en: "Enter Reset Code" },
  "auth.signInDescription": { nl: "Voer uw gegevens in om uw juridische dashboard te openen", en: "Enter your credentials to access your legal dashboard" },
  "auth.signUpDescription": { nl: "Maak een LARO-account om uw juridische bewijs te bundelen", en: "Join LARO to start consolidating your legal evidence" },
  "auth.forgotDescription": { nl: "Voer uw e-mailadres in; wij sturen een zescijferige herstelcode", en: "Enter your email and we'll send you a 6-digit reset code" },
  "auth.resetDescription": { nl: "Voer de code uit uw e-mail in en kies een nieuw wachtwoord", en: "Enter the code from your email and choose a new password" },
  "auth.sendResetCode": { nl: "Herstelcode versturen", en: "Send Reset Code" },
  "auth.fullName": { nl: "Volledige naam", en: "Full Name" },
  "auth.email": { nl: "E-mailadres", en: "Email Address" },
  "auth.password": { nl: "Wachtwoord", en: "Password" },
  "auth.resetCode": { nl: "Herstelcode", en: "Reset Code" },
  "auth.newPassword": { nl: "Nieuw wachtwoord", en: "New Password" },
  "auth.passwordHint": { nl: "Minimaal 8 tekens", en: "At least 8 characters" },
  "auth.forgotPassword": { nl: "Wachtwoord vergeten?", en: "Forgot password?" },
  "auth.processing": { nl: "Bezig...", en: "Processing..." },
  "auth.noAccount": { nl: "Nog geen account? Registreren", en: "Don't have an account? Sign up" },
  "auth.hasAccount": { nl: "Al een account? Inloggen", en: "Already have an account? Sign in" },
  "auth.resendCode": { nl: "Geen code ontvangen? Opnieuw versturen", en: "Didn't get a code? Resend" },
  "auth.backToSignIn": { nl: "Terug naar inloggen", en: "Back to sign in" },
  "auth.welcomeBack": { nl: "Welkom terug bij LARO!", en: "Welcome back to LARO!" },
  "auth.accountCreated": { nl: "Account aangemaakt. Welkom bij LARO.", en: "Account created! Welcome to LARO." },
  "auth.resetRequested": { nl: "Als er een account bestaat, is een herstelcode verstuurd.", en: "If an account exists for that email, a reset code has been sent." },
  "auth.resetComplete": { nl: "Wachtwoord hersteld. U kunt nu inloggen.", en: "Password reset. You can now sign in." },
  "auth.genericError": { nl: "Er is iets misgegaan", en: "Something went wrong" },
  "auth.connectionError": { nl: "LARO is tijdelijk niet bereikbaar", en: "LARO is temporarily unavailable" },
  "auth.connectionErrorDetail": { nl: "Uw sessie is niet afgemeld. Controleer de verbinding en probeer opnieuw.", en: "Your session was not signed out. Check the connection and retry." },
  "case.create": { nl: "Zaak aanmaken", en: "Create case" },
  "case.status.Intake": { nl: "Intake", en: "Intake" },
  "case.status.Matching": { nl: "Matchen", en: "Matching" },
  "case.status.Outreach": { nl: "Benaderen", en: "Outreach" },
  "case.status.Matched": { nl: "Gematcht", en: "Matched" },
  "case.status.Closed": { nl: "Gesloten", en: "Closed" },
  "case.urgency.High": { nl: "Hoog", en: "High" },
  "case.urgency.Medium": { nl: "Middel", en: "Medium" },
  "case.urgency.Low": { nl: "Laag", en: "Low" },
  "outreach.pending": { nl: "Wacht op goedkeuring", en: "Pending approval" },
  "outreach.approved": { nl: "Goedgekeurd", en: "Approved" },
  "outreach.rejected": { nl: "Afgewezen", en: "Rejected" },
  "outreach.notSent": { nl: "Nog niet verzonden", en: "Not sent yet" },
  "validation.email": { nl: "Voer een geldig e-mailadres in", en: "Enter a valid email" },
  "validation.required": { nl: "Dit veld is verplicht", en: "This field is required" },
  "gdpr.exported": { nl: "Uw gegevens zijn geëxporteerd", en: "Your data has been exported" },
  "gdpr.deleted": { nl: "Uw account en gegevens zijn verwijderd", en: "Your account and data were deleted" },
  "matches.none": { nl: "Nog geen advocaten gevonden", en: "No lawyers found yet" },
  "scanner.preparing": { nl: "Bewijsscanner voorbereiden", en: "Preparing evidence scanner" },
  "scanner.verifySession": { nl: "Uw LARO-sessie wordt gecontroleerd...", en: "Verifying your LARO session..." },
  "scanner.signInRequired": { nl: "Inloggen vereist", en: "Sign in required" },
  "scanner.signInDetail": { nl: "Log in het hoofdvenster van LARO in en probeer opnieuw. De scanner maakt nooit een offline of anonieme sessie.", en: "Sign in in the main LARO window, then retry. The scanner never creates an offline or anonymous session." },
  "scanner.createSession": { nl: "Een kortdurende uploadsessie wordt aangemaakt...", en: "Creating a short-lived upload session..." },
  "scanner.collection": { nl: "Bewijs verzamelen", en: "Evidence Collection" },
  "scanner.collectionHint": { nl: "Selecteer een zaak en stel de scan in", en: "Select a case and configure scan settings" },
  "scanner.selectCase": { nl: "Zaak selecteren", en: "Select Case" },
  "scanner.loadingCases": { nl: "Zaken laden...", en: "Loading cases..." },
  "scanner.loadCasesError": { nl: "Zaken konden niet worden geladen.", en: "Failed to load cases." },
  "scanner.noCases": { nl: "Geen zaken gevonden voor uw account.", en: "No cases found for your account." },
  "scanner.noCasesHint": { nl: "Maak in het hoofdvenster van LARO een zaak aan en vernieuw daarna deze lijst.", en: "Create a case in the main LARO window, then refresh this list." },
  "scanner.folders": { nl: "Te scannen mappen", en: "Folders to scan" },
  "scanner.folderSafety": { nl: "Alleen expliciet geselecteerde mappen worden gescand. Er wordt niets geüpload voordat u de resultaten beoordeelt.", en: "Only folders you explicitly select are scanned. Nothing uploads until you review the results." },
  "scanner.selectedFolders": { nl: "Geselecteerde mappen", en: "Selected folders" },
  "scanner.chooseFolders": { nl: "Mappen kiezen", en: "Choose folders" },
  "scanner.noFolders": { nl: "Geen mappen geselecteerd.", en: "No folders selected." },
  "scanner.selectCaseFirst": { nl: "Selecteer eerst een zaak", en: "Please select a case first" },
  "scanner.selectFolderFirst": { nl: "Selecteer minimaal een map om te scannen", en: "Select at least one folder to scan" },
  "scanner.selectCaseContinue": { nl: "Selecteer een zaak om door te gaan", en: "Select a Case to Continue" },
  "scanner.chooseFolderContinue": { nl: "Kies een map om door te gaan", en: "Choose a Folder to Continue" },
  "scanner.scanFolders": { nl: "Geselecteerde mappen scannen", en: "Scan Selected Folders" },
  "scanner.startScanError": { nl: "Scan kon niet worden gestart: {message}", en: "Failed to start scan: {message}" },
  "scanner.newScan": { nl: "Nieuwe scan", en: "New scan" },
  "scanner.folderScan": { nl: "Bewijsmap scannen", en: "Evidence folder scan" },
  "scanner.filesFoundProgress": { nl: "{count} geschikte bestanden tot nu toe gevonden", en: "{count} eligible files found so far" },
  "scanner.filesFound": { nl: "{count} geschikte bestanden gevonden ({size})", en: "{count} eligible files found ({size})" },
  "scanner.resume": { nl: "Scan hervatten", en: "Resume scan" },
  "scanner.pause": { nl: "Scan pauzeren", en: "Pause scan" },
  "scanner.cancel": { nl: "Scan annuleren", en: "Cancel scan" },
  "scanner.review": { nl: "Bewijs beoordelen", en: "Review evidence" },
  "scanner.selected": { nl: "{count} geselecteerd, {size}", en: "{count} selected, {size}" },
  "scanner.selectAll": { nl: "Alles selecteren", en: "Select all" },
  "scanner.clear": { nl: "Wissen", en: "Clear" },
  "scanner.uploadSelected": { nl: "Selectie uploaden", en: "Upload selected" },
  "scanner.noSupportedFiles": { nl: "Geen ondersteunde bewijsbestanden tot 7 MB gevonden.", en: "No supported evidence files up to 7 MB were found." },
  "scanner.noActive": { nl: "Geen actieve scan", en: "No active scan" },
  "scanner.noActiveHint": { nl: "Selecteer een zaak en een of meer mappen voordat u begint.", en: "Select a case and one or more folders before starting." },
  "scanner.configure": { nl: "Scan instellen", en: "Configure scan" },
  "scanner.uploadStartError": { nl: "Uploaden van bewijs kon niet worden gestart", en: "Could not start the evidence upload" },
  "scanner.status.scanning": { nl: "Scannen", en: "Scanning" },
  "scanner.status.paused": { nl: "Gepauzeerd", en: "Paused" },
  "scanner.status.review": { nl: "Beoordelen", en: "Review" },
  "scanner.status.uploading": { nl: "Uploaden", en: "Uploading" },
  "scanner.status.completed": { nl: "Voltooid", en: "Completed" },
  "scanner.status.failed": { nl: "Mislukt", en: "Failed" },
  "scanner.status.cancelled": { nl: "Geannuleerd", en: "Cancelled" },
  "scanner.settingsSaved": { nl: "Instellingen opgeslagen", en: "Settings saved" },
  "scanner.settingsSaveError": { nl: "Instellingen konden niet worden opgeslagen", en: "Failed to save settings" },
  "scanner.defaultCase": { nl: "Standaardzaak", en: "Default case" },
  "scanner.defaultCaseId": { nl: "Standaard zaak-ID", en: "Default Case ID" },
  "scanner.defaultCaseHint": { nl: "Wordt gebruikt bij uploaden zonder opgegeven zaak", en: "Used when uploading without specifying a case" },
  "scanner.saveSettings": { nl: "Instellingen opslaan", en: "Save settings" },
  "scanner.saving": { nl: "Opslaan...", en: "Saving..." },
  "scanner.systemInfo": { nl: "Systeeminformatie", en: "System info" },
  "scanner.appVersion": { nl: "Appversie", en: "App version" },
  "scanner.device": { nl: "Apparaat", en: "Device" },
  "scanner.platform": { nl: "Platform", en: "Platform" },
  "scanner.username": { nl: "Gebruikersnaam", en: "Username" },
} as const satisfies Record<string, Message>;

export type TranslationKey = keyof typeof messages;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as string[]).includes(value);
}

export function normalizeLocale(input?: string | null): Locale {
  if (!input) return DEFAULT_LOCALE;
  const base = input.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : DEFAULT_LOCALE;
}

export function localeTag(locale: Locale): "nl-NL" | "en-US" {
  return locale === "nl" ? "nl-NL" : "en-US";
}

/** Translate a message id. Unknown ids remain visible instead of becoming blank. */
export function t(key: string, locale: Locale = DEFAULT_LOCALE, vars?: Record<string, string | number>): string {
  const entry = messages[key as TranslationKey];
  let value = entry ? entry[locale] : key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${name}\\}`, "g"), String(replacement));
    }
  }
  return value;
}
