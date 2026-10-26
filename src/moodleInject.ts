/**
 * Scripts evaluated inside the Moodle webview.
 *
 * They call `window.paperlikePost`, installed by Rust before any page script.
 * That posts JSON through WebView2 `postMessage` (prefix `PL1`). Rust listens
 * with WebMessageReceived — not Tauri IPC — and answers by setting
 * `window.__paperlikeAck`. If postMessage is missing, the helper navigates to
 * `https://paperlike.local/moodle-msg?d=...`, which Rust cancels.
 *
 * "Save PDF to Material" is for inline pluginfile.php PDFs, which never start
 * a download. It fetch()es the current URL with the session cookie and posts
 * the bytes as base64 chunks. Real download clicks are saved by WebView2's
 * DownloadStarting event instead.
 */

/** Language is handled in the page. Do not navigate or fetch ?lang=en; that sent Moodle back through the TUM login. */
export const ENGLISH_SCRIPT = `(function () {})();`;

export const COURSE_SCRIPT = `(async () => {
  const post = window.paperlikePost;
  if (typeof post !== "function") return;
  const host = location.hostname.toLowerCase();
  const sso = host.endsWith(".aai.dfn.de") || host === "aai.dfn.de" || /\\/(login|auth|idp|shibboleth|saml)(\\/|$)/i.test(location.pathname);
  if (sso) { await post({ type: "login-required" }); return; }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && !(window.M && window.M.cfg && window.M.cfg.sesskey)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!(window.M && window.M.cfg && window.M.cfg.sesskey)) {
    await post({ type: "login-required" });
    return;
  }
  if (!(host === "moodle.tum.de" || host.endsWith(".moodle.tum.de"))) return;
  const abs = (u, id) => (u && /^https?:/i.test(u) ? u : location.origin + "/course/view.php?id=" + id);
  const mapCourse = (c) => {
    const id = Number(c && c.id);
    if (!id) return null;
    const fullname = String(c.fullname || c.fullnamedisplay || "").replace(/\\s+/g, " ").trim().slice(0, 300);
    if (!fullname) return null;
    return { id: id, fullname: fullname, shortname: String(c.shortname || "").slice(0, 80), viewurl: abs(c.viewurl, id) };
  };
  const scrape = () => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="course/view.php?id="]')) {
      const m = String(a.href || "").match(/[?&]id=(\\d+)/);
      if (!m || seen.has(m[1])) continue;
      const fullname = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300);
      if (fullname.length < 2) continue;
      seen.add(m[1]);
      out.push({ id: Number(m[1]), fullname: fullname, shortname: "", viewurl: a.href });
      if (out.length >= 400) break;
    }
    return out;
  };
  const call = async (classification) => {
    const url = new URL("/lib/ajax/service.php", location.origin);
    url.searchParams.set("sesskey", window.M.cfg.sesskey);
    url.searchParams.set("info", "core_course_get_enrolled_courses_by_timeline_classification");
    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        index: 0,
        methodname: "core_course_get_enrolled_courses_by_timeline_classification",
        args: { classification: classification, limit: 0, offset: 0, sort: "fullname" }
      }])
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || row.error) throw new Error("moodle");
    const list = (row.data && row.data.courses) || [];
    return list.map(mapCourse).filter(Boolean);
  };
  try {
    let courses = [];
    const current = new Set();
    try {
      for (const c of await call("inprogress")) current.add(c.id);
    } catch (e) { /* the full list still works without the current marks */ }
    try { courses = await call("all"); }
    catch (e) {
      const merged = new Map();
      for (const kind of ["inprogress", "future", "past"]) {
        try {
          for (const c of await call(kind)) merged.set(c.id, c);
        } catch (e2) { /* try the next classification */ }
      }
      courses = Array.from(merged.values());
    }
    if (!courses.length) courses = scrape();
    for (const c of courses) c.current = current.has(c.id);
    await post({ type: "courses", courses: courses.slice(0, 400) });
  } catch (e) {
    const scraped = scrape();
    if (scraped.length) await post({ type: "courses", courses: scraped });
    else await post({ type: "login-required" });
  }
})();`;

export type LookColors = {
  bg: string;
  bg2: string;
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  accentInk: string;
  soft: string;
  border: string;
};

function paintColor(value: string, fallback: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\([\d.,%\s/]+\)$/i.test(v)) return v;
  return fallback;
}

/** Chrome labels TUM stores in German even when Moodle's language pack is English. Longer phrases first. */
const CHROME_EN: [string, string][] = [
  ["Teilnehmerinnen und Teilnehmer", "Participants"],
  ["Dokumentation zu dieser Seite", "Documentation for this page"],
  ["Moodle Docs für diese Seite", "Moodle Docs for this page"],
  ["Moodle-Dokumentation zu dieser Seite", "Moodle Docs for this page"],
  ["Häufig gestellte Fragen", "Frequently asked questions"],
  ["Sie sind in keinen Kursen eingeschrieben", "You are not enrolled in any courses"],
  ["Zum Hauptinhalt springen", "Skip to main content"],
  ["Eingeschriebene Nutzer/innen", "Enrolled users"],
  ["Manuell als erledigt markieren", "Mark as done"],
  ["Text- und Medienfeld", "Text and media area"],
  ["Gegenseitige Beurteilung", "Workshop"],
  ["Forum der Ankündigungen", "Announcements forum"],
  ["Letzte Ankündigungen", "Latest announcements"],
  ["Kürzlich besuchte Kurse", "Recently accessed courses"],
  ["Kürzlich besucht", "Recently accessed"],
  ["Meine Kursübersicht", "My courses"],
  ["Kursübersicht filtern", "Filter courses"],
  ["Bewertungsübersicht", "Grades overview"],
  ["Kurs-Einstellungen", "Course settings"],
  ["Kursverwaltung", "Course administration"],
  ["Fragensammlung", "Question bank"],
  ["Aktivitätsabschluss", "Activity completion"],
  ["Abschlussverfolgung", "Activity completion"],
  ["Selbsteinschreibung", "Self enrolment"],
  ["Private Dateien", "Private files"],
  ["Datenschutzerklärung", "Privacy policy"],
  ["Nutzungsbedingungen", "Policies"],
  ["Barrierefreiheit", "Accessibility"],
  ["Kontextbezogene Hilfe", "Contextual help"],
  ["Weitere Informationen", "More information"],
  ["Hilfe und Unterstützung", "Help and support"],
  ["Moodle-Dokumentation", "Moodle documentation"],
  ["Änderungen speichern", "Save changes"],
  ["Bearbeiten einschalten", "Turn editing on"],
  ["Bearbeiten ausschalten", "Turn editing off"],
  ["Alles ausklappen", "Expand all"],
  ["Alles einklappen", "Collapse all"],
  ["Als erledigt markieren", "Mark as done"],
  ["Kursindex öffnen", "Open course index"],
  ["Kursindex schließen", "Close course index"],
  ["Blockleiste öffnen", "Open block drawer"],
  ["Blockleiste schließen", "Close block drawer"],
  ["Meine Startseite", "Dashboard"],
  ["Website-Startseite", "Site home"],
  ["Dieser Kurs", "This course"],
  ["Meine Kurse", "My courses"],
  ["Kursübersicht", "Course overview"],
  ["Kursbereiche", "Course categories"],
  ["Kursinhalte", "Course content"],
  ["Kursabschluss", "Course completion"],
  ["Kursindex", "Course index"],
  ["Teilnehmer/innen", "Participants"],
  ["Benachrichtigungen", "Notifications"],
  ["Ankündigungen", "Announcements"],
  ["Bewertungen", "Grades"],
  ["Aktivitäten", "Activities"],
  ["Einstellungen", "Settings"],
  ["Einrichtung", "School"],
  ["Ausgeblendete Kurse verwalten", "Manage hidden courses"],
  ["Sie haben", "You have"],
  ["ausgeblendete Kurse |", "hidden courses |"],
  ["ausgeblendeten Kurs |", "hidden course |"],
  ["Suche nach Aktivitätstyp oder Aktivitätsname", "Search by activity type or name"],
  ["Keine Aktivität erfordert ein Handeln", "No activities require action"],
  ["Zeitleiste nach Datum filtern", "Filter timeline by date"],
  ["Zeitleiste-Einträge sortieren", "Sort timeline items"],
  ["Sortiert nach Datum", "Sort by dates"],
  ["Sortiert nach Kursen", "Sort by courses"],
  ["Nächste 7 Tage", "Next 7 days"],
  ["Nächste 30 Tage", "Next 30 days"],
  ["Nächste 3 Monate", "Next 3 months"],
  ["Nächste 6 Monate", "Next 6 months"],
  ["Fälligkeitsdatum", "Due date"],
  ["Überfällig", "Overdue"],
  ["Weitere Kurse", "More courses"],
  ["Aktuelle Termine", "Upcoming events"],
  ["Keine weiteren Termine", "There are no upcoming events"],
  ["Zum Kalender ...", "Go to calendar…"],
  ["Vollständiger Kalender", "Full calendar"],
  ["Import und Export", "Import or export calendars"],
  ["Neuer Termin", "New event"],
  ["Kursliste", "Course list"],
  ["Meine Dateien verwalten...", "Manage private files…"],
  ["Keine Dateien vorhanden", "No files available"],
  ["Meine Dateien", "Private files"],
  ["Verwaltung der ausgeblendeten Kurse beenden", "Done managing hidden courses"],
  ["Kurs in der Kursübersichtsliste ausblenden", "Hide course"],
  ["Kurs anzeigen", "Show course"],
  ["Bearbeitungsmodus", "Edit mode"],
  ["Nutzerbericht", "User report"],
  ["Neuigkeiten", "Announcements"],
  ["Allgemeines", "General"],
  ["Aktuelle Woche", "Current week"],
  ["Diese Woche", "This week"],
  ["Nicht verfügbar", "Not available"],
  ["Nicht erledigt", "Not done"],
  ["Mehr anzeigen", "Show more"],
  ["Weniger anzeigen", "Show less"],
  ["Sortieren nach", "Sort by"],
  ["Letzter Zugriff", "Last accessed"],
  ["Zuletzt genutzt", "Last accessed"],
  ["Sternmarkierung", "Starred"],
  ["Alle Kurse", "All courses"],
  ["Download-Center", "Download Center"],
  ["Downloadcenter", "Download Center"],
  ["Externes Tool", "External tool"],
  ["Interaktiver Inhalt", "H5P"],
  ["Einschreibeschlüssel", "Enrolment key"],
  ["Gastzugang", "Guest access"],
  ["Hilfemenü", "Help menu"],
  ["Hilfeseite", "Help page"],
  ["Erste Schritte", "Getting started"],
  ["Fragen und Antworten", "Questions and answers"],
  ["Anleitungen", "Guides"],
  ["Unterstützung", "Support"],
  ["Hauptmenü", "Main menu"],
  ["Nutzermenü", "User menu"],
  ["Profil anzeigen", "View profile"],
  ["Profil bearbeiten", "Edit profile"],
  ["Vollständiges Profil", "Full profile"],
  ["Angemeldet als", "Logged in as"],
  ["Präferenzen", "Preferences"],
  ["Mitteilungen", "Messages"],
  ["Nachrichten", "Messages"],
  ["Kalender", "Calendar"],
  ["Startseite", "Home"],
  ["Teilnehmer", "Participants"],
  ["Übersicht", "Overview"],
  ["Zusammenfassung", "Summary"],
  ["Zeitleiste", "Timeline"],
  ["Favoriten", "Starred"],
  ["Laufend", "In progress"],
  ["Zukünftig", "Future"],
  ["Vergangen", "Past"],
  ["Berichte", "Reports"],
  ["Verwaltung", "Administration"],
  ["Kompetenzen", "Competencies"],
  ["Abzeichen", "Badges"],
  ["Einschreibung", "Enrolment"],
  ["Gruppen", "Groups"],
  ["Abschluss", "Completion"],
  ["Voraussetzungen", "Restrictions"],
  ["Fortschritt", "Progress"],
  ["Beschreibung", "Description"],
  ["Kursname", "Course name"],
  ["Kursbild", "Course image"],
  ["Trainer/innen", "Teachers"],
  ["Lehrende", "Teachers"],
  ["Aufgabe", "Assignment"],
  ["Verzeichnis", "Folder"],
  ["Glossar", "Glossary"],
  ["Abstimmung", "Choice"],
  ["Datenbank", "Database"],
  ["Umfrage", "Survey"],
  ["Lektion", "Lesson"],
  ["Textfeld", "Label"],
  ["Abschnitt", "Section"],
  ["Anzeigen", "Show"],
  ["Verbergen", "Hide"],
  ["Versteckt", "Hidden"],
  ["Sichtbar", "Visible"],
  ["Bearbeiten", "Edit"],
  ["Löschen", "Delete"],
  ["Duplizieren", "Duplicate"],
  ["Verschieben", "Move"],
  ["Speichern", "Save"],
  ["Abbrechen", "Cancel"],
  ["Schließen", "Close"],
  ["Ausklappen", "Expand"],
  ["Einklappen", "Collapse"],
  ["Herunterladen", "Download"],
  ["Suchen", "Search"],
  ["Suche", "Search"],
  ["Sprache", "Language"],
  ["Deutsch", "German"],
  ["Abmelden", "Log out"],
  ["Anmelden", "Log in"],
  ["Profil", "Profile"],
  ["Dateien", "Files"],
  ["Blöcke", "Blocks"],
  ["Blockleiste", "Block drawer"],
  ["Optionen", "Options"],
  ["Aktionen", "Actions"],
  ["Rollen", "Roles"],
  ["Inhalt", "Content"],
  ["Informationen", "Information"],
  ["Notizen", "Notes"],
  ["Noten", "Grades"],
  ["Hilfe", "Help"],
  ["Zurück", "Back"],
  ["Weiter", "Next"],
  ["Öffnen", "Open"],
  ["Menü", "Menu"],
  ["Thema", "Topic"],
  ["Woche", "Week"],
  ["Kurse", "Courses"],
  ["Kurs", "Course"],
  ["Mehr", "More"],
  ["Alle", "All"],
  ["Liste", "List"],
  ["Karten", "Cards"],
  ["Anzeige", "View"],
  ["Filter", "Filter"],
  ["Details", "Details"],
  ["Impressum", "Legal notice"],
  ["Datenschutz", "Privacy"],
  ["Kontakt", "Contact"],
  ["Willkommen", "Welcome"],
  ["Erledigt", "Done"],
  ["Verfügbar", "Available"],
  ["Datei", "File"],
  ["Seite", "Page"],
  ["Buch", "Book"],
  ["Test", "Quiz"],
  ["Forum", "Forum"],
];
CHROME_EN.sort((a, b) => b[0].length - a[0].length);

/**
 * Restyle the Moodle page that is already on screen. Custom never replaces the page:
 * it adds a stylesheet, shortens course titles, and filters the course list.
 * `on: false` removes all of that and puts the original text back.
 */
export function customLookScript(
  on: boolean,
  tab: "lectures" | "exercises",
  names: Record<string, string>,
  colors: LookColors,
): string {
  const safeTab = tab === "exercises" ? "exercises" : "lectures";
  const safeNames: Record<string, string> = {};
  for (const [id, name] of Object.entries(names)) {
    if (!/^\d+$/.test(id)) continue;
    const cleaned = name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
    if (cleaned) safeNames[id] = cleaned;
  }
  const c: LookColors = {
    bg: paintColor(colors.bg, "#f6f4ef"),
    bg2: paintColor(colors.bg2, "#efece5"),
    surface: paintColor(colors.surface, "#ffffff"),
    ink: paintColor(colors.ink, "#23201c"),
    ink2: paintColor(colors.ink2, "#6f6a62"),
    ink3: paintColor(colors.ink3, "#908a80"),
    accent: paintColor(colors.accent, "#6d4fc4"),
    accentInk: paintColor(colors.accentInk, "#ffffff"),
    soft: paintColor(colors.soft, "#ece7f9"),
    border: paintColor(colors.border, "#e2ddd3"),
  };
  const paper = "#f6f4ef";
  const paperInk = "#23201c";
  const paperMuted = "#6f6a62";
  const paperFaint = "#908a80";
  const paperLine = "#e2ddd3";
  const paperHead = "#efece5";
  const css = `
html.pl-look, html.pl-look body,
html.pl-look #page, html.pl-look #page-wrapper, html.pl-look #page-content, html.pl-look #topofscroll {
  background: ${c.bg} !important;
  color: ${c.ink} !important;
  font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif !important;
}
html.pl-look .navbar, html.pl-look #page-header, html.pl-look .primary-navigation,
html.pl-look .secondary-navigation, html.pl-look .secondary-navigation .navigation,
html.pl-look .tertiary-navigation, html.pl-look .moremenu, html.pl-look .moremenu .nav,
html.pl-look ul.nav-tabs, html.pl-look .nav-tabs, html.pl-look .drawer, html.pl-look .drawercontent,
html.pl-look #nav-drawer, html.pl-look #page-footer, html.pl-look .popover-region-container {
  background: ${c.surface} !important;
  background-color: ${c.surface} !important;
  color: ${c.ink} !important;
  border-color: ${c.border} !important;
}
html.pl-look .navbar a, html.pl-look .navbar .nav-link, html.pl-look .primary-navigation a,
html.pl-look .secondary-navigation a, html.pl-look .moremenu .nav-link, html.pl-look .nav-tabs .nav-link,
html.pl-look .drawer a, html.pl-look .list-group-item, html.pl-look .list-group-item-action,
html.pl-look #page-header, html.pl-look #page-header h1, html.pl-look .page-header-headings,
html.pl-look .page-context-header, html.pl-look .page-context-header a {
  background: transparent !important;
  color: ${c.ink} !important;
}
html.pl-look .nav-tabs .nav-link.active, html.pl-look .moremenu .nav-link.active,
html.pl-look .moremenu .active > .nav-link, html.pl-look .secondary-navigation .nav-link.active {
  color: ${c.accent} !important;
  background: transparent !important;
  box-shadow: inset 0 -2px 0 ${c.accent};
}
html.pl-look #page-footer, html.pl-look #page-footer a { color: ${c.ink2} !important; }
html.pl-look .headertummoodle, html.pl-look .headertummoodle a, html.pl-look .headertummoodle p,
html.pl-look .headertummoodle span, html.pl-look .headertummoodle div {
  color: ${c.ink2} !important;
  background: transparent !important;
}
html.pl-look #region-main-box, html.pl-look #region-main,
html.pl-look #region-main .course-content, html.pl-look #region-main .course-section,
html.pl-look #region-main li.section, html.pl-look #region-main .activity,
html.pl-look #region-main .activity-item, html.pl-look #region-main .generaltable,
html.pl-look #region-main .no-overflow, html.pl-look #region-main .card,
html.pl-look .dashboard-card, html.pl-look .course-card, html.pl-look .coursebox,
html.pl-look [data-region="courses-view"], html.pl-look [data-region="course-content"] {
  background: ${paper} !important;
  color: ${paperInk} !important;
  border-color: ${paperLine} !important;
}
html.pl-look #region-main h1, html.pl-look #region-main h2, html.pl-look #region-main h3,
html.pl-look #region-main h4, html.pl-look #region-main .sectionname,
html.pl-look #region-main .sectionname a, html.pl-look #region-main .coursename,
html.pl-look #region-main .activityname, html.pl-look #region-main .aalink,
html.pl-look #region-main .instancename, html.pl-look #region-main .collapsemenu,
html.pl-look #region-main .collapsemenu a, html.pl-look #region-main .section-collapsemenu,
html.pl-look #region-main button.btn-link, html.pl-look .dashboard-card, html.pl-look .course-card,
html.pl-look .pl-short {
  color: ${paperInk} !important;
  font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
}
html.pl-look #region-main .collapsemenu, html.pl-look #region-main .collapsemenu a,
html.pl-look #region-main button.btn-link { color: ${paperMuted} !important; }
html.pl-look #region-main .activity .aalink:hover,
html.pl-look #region-main .activity .aalink:hover .instancename { color: ${c.accent} !important; }
html.pl-look #region-main .no-overflow a, html.pl-look #region-main .activity-description a {
  color: ${c.accent} !important;
}
html.pl-look #region-main td, html.pl-look #region-main th,
html.pl-look .generaltable td, html.pl-look .generaltable th,
html.pl-look table td, html.pl-look table th {
  color: ${paperInk} !important;
}
html.pl-look #region-main th, html.pl-look .generaltable th, html.pl-look table th {
  background: ${paperHead} !important;
}
html.pl-look .dashboard-card, html.pl-look .course-card, html.pl-look li.section,
html.pl-look .course-section {
  border-radius: 16px !important;
  box-shadow: 0 1px 2px rgba(35, 32, 28, 0.06) !important;
}
html.pl-look #region-main .btn,
html.pl-look #region-main .btn-primary,
html.pl-look #region-main .bg-primary,
html.pl-look #region-main .list-group-item,
html.pl-look #region-main a[href*="course/view.php"],
html.pl-look #region-main a[href*="course/view.php"]::before,
html.pl-look [data-region="courses-view"] .btn,
html.pl-look [data-region="courses-view"] .btn-primary,
html.pl-look [data-region="courses-view"] .bg-primary {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: ${paperInk} !important;
}
html.pl-look .block_course_overview_campus,
html.pl-look .block_course_overview_campus .card-body,
html.pl-look .block_course_overview_campus .card-text,
html.pl-look #coc-courselist,
html.pl-look .coc-course,
html.pl-look .hidecoursediv,
html.pl-look .termdiv,
html.pl-look .categorydiv,
html.pl-look .block_course_overview_campus .btn,
html.pl-look .block_course_overview_campus .btn-primary,
html.pl-look .block_course_overview_campus .bg-primary,
html.pl-look .block_course_overview_campus a::before {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
}
html.pl-look .block_course_overview_campus .coursebox {
  display: flex !important;
  flex-direction: row-reverse !important;
  align-items: center !important;
  gap: 12px;
  padding: 12px 14px !important;
  background: #fff !important;
  background-color: #fff !important;
  border: 1px solid ${paperLine} !important;
  border-radius: 12px !important;
  margin: 0 0 8px !important;
  color: ${paperInk} !important;
  box-shadow: 0 1px 2px rgba(35, 32, 28, 0.04) !important;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
html.pl-look .block_course_overview_campus .coursebox:hover {
  border-color: ${paperMuted} !important;
  box-shadow: 0 2px 6px rgba(35, 32, 28, 0.08) !important;
}
html.pl-look .block_course_overview_campus .coursebox h3 {
  flex: 1 1 auto;
  min-width: 0;
}
html.pl-look .block_course_overview_campus .coursebox:has(a[id^="coc-showcourseicon"]:not(.coc-hidden)) h3 {
  opacity: 0.5;
}
html.pl-look .block_course_overview_campus .coursebox .pl-short { font-size: 15px; }
html.pl-look #coc-courselist { padding: 0 !important; }
html.pl-look .block_course_overview_campus .row:has(#coc-hiddencoursescount) {
  display: block !important;
  margin: 6px 0 0 !important;
  text-align: center;
  font-size: 12.5px;
  color: ${paperMuted} !important;
}
html.pl-look #coc-hiddencoursescount { color: ${paperInk} !important; font-weight: 650; }
html.pl-look .block_course_overview_campus .row:has(#coc-hiddencoursescount) a {
  color: ${paperInk} !important;
  font-weight: 600;
  text-decoration: underline !important;
  text-underline-offset: 2px;
}
html.pl-look .block_course_overview_campus .coursebox h3,
html.pl-look .block_course_overview_campus .coursebox h3 a,
html.pl-look .block_course_overview_campus a[data-pl-shown],
html.pl-look .block_course_overview_campus .pl-short {
  display: block;
  position: static !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  color: ${paperInk} !important;
  text-decoration: none !important;
}
html.pl-look .block_course_overview_campus .hidecourseicon {
  position: relative;
  z-index: 4;
  flex: 0 0 auto;
  display: flex !important;
  width: auto !important;
  float: none !important;
  margin: 0 !important;
  pointer-events: auto !important;
  background: transparent !important;
  opacity: 0.55;
}
html.pl-look .block_course_overview_campus .coursebox:hover .hidecourseicon,
html.pl-look .block_course_overview_campus .hidecourseicon:focus-within { opacity: 1; }
html.pl-look .block_course_overview_campus .hidecourseicon a:not(.coc-hidden) {
  position: relative;
  z-index: 5;
  display: inline-flex !important;
  align-items: center;
  pointer-events: auto !important;
  background: transparent !important;
  color: ${paperInk} !important;
}
html.pl-look .block_course_overview_campus .fa-toggle-on,
html.pl-look .block_course_overview_campus .fa-toggle-off {
  color: ${paperInk} !important;
}
html.pl-look .pl-full { color: ${paperMuted} !important; }
html.pl-look .editmode-switch-form,
html.pl-look .editing-switch {
  display: none !important;
}
html.pl-look .drawer-toggler .btn,
html.pl-look .drawer-left-toggle .btn,
html.pl-look button[data-toggler="drawers"],
html.pl-look button[aria-controls*="courseindex"],
html.pl-look button[data-target*="courseindex"] {
  background: ${c.surface} !important;
  background-color: ${c.surface} !important;
  border: 1px solid ${c.border} !important;
  color: ${c.ink} !important;
}
html.pl-look .navbar-toggler-icon {
  background-image: none !important;
  background-color: ${c.ink} !important;
  -webkit-mask: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 30'%3e%3cpath stroke='black' stroke-linecap='round' stroke-width='2' d='M4 7h22M4 15h22M4 23h22'/%3e%3c/svg%3e") center / 100% 100% no-repeat;
  mask: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 30'%3e%3cpath stroke='black' stroke-linecap='round' stroke-width='2' d='M4 7h22M4 15h22M4 23h22'/%3e%3c/svg%3e") center / 100% 100% no-repeat;
}
html.pl-look .drawer-toggler .btn .icon,
html.pl-look button[data-toggler="drawers"] .icon,
html.pl-look button[aria-controls*="courseindex"] .icon {
  color: ${c.ink} !important;
}
html.pl-look .form-switch,
html.pl-look .form-check,
html.pl-look .custom-control,
html.pl-look input[type="checkbox"],
html.pl-look [data-action="hide"],
html.pl-look [data-action="show"] {
  pointer-events: auto !important;
}
html.pl-look .usermenu,
html.pl-look .usermenu .dropdown,
html.pl-look .navbar .dropdown,
html.pl-look .primary-navigation,
html.pl-look .moremenu,
html.pl-look .secondary-navigation {
  overflow: visible !important;
}
html.pl-look .dropdown-menu,
html.pl-look .usermenu .dropdown-menu,
html.pl-look .popover,
html.pl-look .popover-body,
html.pl-look .modal-content,
html.pl-look .moodle-dialogue,
html.pl-look [role="dialog"],
html.pl-look [role="menu"] {
  background: ${c.surface} !important;
  color: ${c.ink} !important;
  border: 1px solid ${c.border} !important;
  border-radius: 12px !important;
  z-index: 2000 !important;
  box-shadow: 0 8px 24px rgba(35, 32, 28, 0.14) !important;
}
html.pl-look .dropdown-item,
html.pl-look .dropdown-menu a,
html.pl-look .usermenu .dropdown-menu a,
html.pl-look .navbar .dropdown-menu a,
html.pl-look .popover a,
html.pl-look [role="menuitem"] {
  background: transparent !important;
  color: ${c.ink} !important;
  pointer-events: auto !important;
}
html.pl-look .dropdown-item:hover,
html.pl-look .dropdown-item:focus,
html.pl-look .dropdown-menu a:hover,
html.pl-look .dropdown-menu a:focus,
html.pl-look .usermenu .dropdown-menu a:hover,
html.pl-look .navbar .dropdown-menu a:hover,
html.pl-look [role="menuitem"]:hover {
  background: ${c.bg2} !important;
  color: ${c.ink} !important;
}
html.pl-look .usermenu .dropdown-toggle,
html.pl-look .usermenu > .dropdown > a,
html.pl-look .userbutton {
  background: ${c.surface} !important;
  color: ${c.ink} !important;
  border-radius: 999px !important;
}
html.pl-look .pl-short { display: block; font-weight: 650; }
html.pl-look .pl-full {
  display: block; margin-top: 2px; font-size: 12.5px; font-weight: 450; line-height: 1.35;
  color: ${paperMuted} !important; white-space: normal;
}
html.pl-look [data-pl-hide="1"],
html.pl-look .block_course_overview_campus .coursebox[data-pl-hide="1"] { display: none !important; }
html.pl-look #pl-tabs {
  position: sticky; top: 8px; z-index: 40; display: flex; flex-wrap: wrap; gap: 4px;
  margin: 0 0 16px; padding: 4px; background: #fff !important;
  border: 1px solid ${paperLine}; border-radius: 14px;
  box-shadow: 0 1px 3px rgba(35, 32, 28, 0.08);
}
html.pl-look #pl-tabs button {
  flex: 1 1 0; border: 0; background: transparent !important; color: ${paperMuted} !important;
  font: inherit; font-size: 15px; font-weight: 650; letter-spacing: 0.01em;
  padding: 10px 18px; border-radius: 10px; cursor: pointer;
}
html.pl-look #pl-tabs button[aria-selected="true"] {
  background: ${c.accent} !important; color: ${c.accentInk} !important;
}
html.pl-look #pl-tabs .pl-tab-note {
  flex: 1 1 100%; margin: 0; padding: 2px 10px 4px; font-size: 12.5px; color: ${paperFaint} !important;
}
html.pl-look #region-main .nav,
html.pl-look #region-main .nav-tabs,
html.pl-look #region-main .nav-pills,
html.pl-look #region-main .onetopic,
html.pl-look #region-main #onetopic-tabs,
html.pl-look #region-main .format-buttons,
html.pl-look #region-main #buttonsectioncontainer,
html.pl-look #region-main .menutopic,
html.pl-look #region-main #menuTopic,
html.pl-look #region-main .section-navigation,
html.pl-look .pl-topmenu {
  background: ${paper} !important;
  background-color: ${paper} !important;
}
html.pl-look #region-main .nav a,
html.pl-look #region-main .nav a[href*="course/view.php"],
html.pl-look #region-main .nav-link,
html.pl-look #region-main .onetopic a,
html.pl-look #region-main #onetopic-tabs a,
html.pl-look #region-main .format-buttons a,
html.pl-look #region-main #buttonsectioncontainer a,
html.pl-look #region-main .menutopic a,
html.pl-look #region-main #menuTopic a,
html.pl-look #region-main .section-navigation a,
html.pl-look #region-main a[href*="section="],
html.pl-look #region-main a[href*="section="] *,
html.pl-look .pl-topmenu-item,
html.pl-look .pl-topmenu-item * {
  background: #fff !important;
  background-color: #fff !important;
  background-image: none !important;
  color: ${paperInk} !important;
  border-color: ${paperLine} !important;
}
html.pl-look #region-main .nav-link.active,
html.pl-look #region-main .nav .active > a,
html.pl-look .pl-topmenu-item.active,
html.pl-look .pl-topmenu .active > .pl-topmenu-item {
  background: ${c.accent} !important;
  background-color: ${c.accent} !important;
  color: #fff !important;
  border-color: transparent !important;
}
`.trim();

  return `(function () {
  var ON = ${on ? "true" : "false"};
  var TAB0 = ${JSON.stringify(safeTab)};
  var NAMES = ${JSON.stringify(safeNames)};
  var CSS = ${JSON.stringify(css)};
  var PHRASES = ${JSON.stringify(CHROME_EN)};
  var root = document.documentElement;
  if (window.__plLookObs) { window.__plLookObs.disconnect(); window.__plLookObs = null; }
  function restore() {
    var renamed = document.querySelectorAll("[data-pl-html]");
    for (var i = 0; i < renamed.length; i++) {
      renamed[i].innerHTML = renamed[i].getAttribute("data-pl-html");
      renamed[i].removeAttribute("data-pl-html");
      renamed[i].removeAttribute("data-pl-text");
      renamed[i].removeAttribute("data-pl-shown");
    }
    var hidden = document.querySelectorAll("[data-pl-hide]");
    for (var j = 0; j < hidden.length; j++) hidden[j].removeAttribute("data-pl-hide");
    var style = document.getElementById("pl-look");
    if (style) style.remove();
    var bar = document.getElementById("pl-tabs");
    if (bar) bar.remove();
    root.classList.remove("pl-look");
  }
  var hostName = (location.hostname || "").toLowerCase();
  var idp = hostName === "aai.dfn.de" || hostName.endsWith(".aai.dfn.de");
  if (!ON || idp) { restore(); return; }
  var style = document.getElementById("pl-look");
  if (!style) {
    style = document.createElement("style");
    style.id = "pl-look";
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
  root.classList.add("pl-look");
  var TAB = TAB0;
  try {
    var saved = sessionStorage.getItem("pl-tab");
    if (saved === "lectures" || saved === "exercises") TAB = saved;
  } catch (e) {}
  function fold(s) {
    return String(s || "").normalize("NFD").replace(/\\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();
  }
  var EX = /\\b(ubung|uebung|ubungen|uebungen|exercise|exercises|tutorial|tutorials|tutorium)\\b/;
  function courseId(a) {
    try {
      var u = new URL(a.href, location.origin);
      if (!/\\/course\\/view\\.php$/i.test(u.pathname)) return "";
      if (u.searchParams.get("section")) return "";
      return u.searchParams.get("id") || "";
    } catch (e) { return ""; }
  }
  function shortOf(id, text) {
    if (NAMES[id]) return NAMES[id];
    var raw = String(text || "");
    var folded = raw.normalize("NFD").replace(/\\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();
    if (/\\bcad\\s*\\/\\s*td\\b/.test(folded) || /\\bcad\\s+td\\b/.test(folded) || /\\btechnical drawing\\b/.test(folded) || /\\btechnisches zeichnen\\b/.test(folded)) {
      return "CAD & Technical Drawing";
    }
    var cleaned = raw
      .replace(/\\b(übung|übungen|uebung|uebungen|exercise|exercises|tutorial|tutorials|tutorium|vorlesung|lecture)\\b/gi, " ")
      .replace(/\\b(ws|ss|wise|sose)\\s*\\d{0,4}\\b/gi, " ")
      .replace(/\\b[ws]\\d{2}\\s*\\/\\s*\\d{2}\\b/gi, " ")
      .replace(/\\b(19|20)\\d{2}\\b/g, " ")
      .replace(/\\b\\d{6,}\\b/g, " ")
      .replace(/\\b(winter|summer|sommer)semester\\b/gi, " ")
      .replace(/[()[\\]]/g, " ")
      .replace(/\\s+/g, " ")
      .trim();
    return cleaned || raw.trim();
  }
  function cardOf(a) {
    var card = a.closest(".dashboard-card, .course-card, .coursebox, .course-listitem, tr, .card");
    if (!card) return a;
    if (card.querySelector("#pl-tabs")) return a;
    if (card.querySelectorAll('a[href*="course/view.php"]').length > 3) return a;
    return card;
  }
  function inNav(a) {
    return !!a.closest(".navbar, .primary-navigation, .secondary-navigation, .moremenu, .usermenu, .dropdown-menu, .popover, .breadcrumb, #page-footer, #courseindex, .tertiary-navigation");
  }
  function letter(ch) {
    return !!ch && /[A-Za-z0-9\\u00c4\\u00d6\\u00dc\\u00e4\\u00f6\\u00fc\\u00df]/.test(ch);
  }
  function translateValue(s) {
    if (!s || s.length > 900) return s;
    var out = String(s);
    var trimmed = out.replace(/\\s+/g, " ").trim();
    for (var i = 0; i < PHRASES.length; i++) {
      if (PHRASES[i][0] !== trimmed) continue;
      var pad = out.match(/^\\s*/)[0];
      var end = out.match(/\\s*$/)[0];
      return pad + PHRASES[i][1] + end;
    }
    for (var j = 0; j < PHRASES.length; j++) {
      var from = PHRASES[j][0];
      if (from.length < 14) continue;
      var to = PHRASES[j][1];
      var at = 0;
      while (at <= out.length - from.length) {
        var i0 = out.indexOf(from, at);
        if (i0 < 0) break;
        var before = i0 === 0 ? "" : out.charAt(i0 - 1);
        var after = i0 + from.length >= out.length ? "" : out.charAt(i0 + from.length);
        if (!letter(before) && !letter(after)) {
          out = out.slice(0, i0) + to + out.slice(i0 + from.length);
          at = i0 + to.length;
        } else at = i0 + 1;
      }
    }
    return out;
  }
  function translateEl(el) {
    if (!el || !el.querySelectorAll) return;
    if (el.closest && el.closest(".pl-full, .pl-short, #pl-tabs, textarea, input, script, style")) return;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
      var parent = n.parentElement;
      if (!parent || parent.closest(".pl-full, .pl-short, #pl-tabs, .activity-description, .coursebox h3, .coc-metainfo, textarea, script, style")) continue;
      var next = translateValue(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    }
    var labeled = el.querySelectorAll("[aria-label], [title], [placeholder]");
    for (var i = 0; i < labeled.length; i++) {
      var node = labeled[i];
      ["aria-label", "title", "placeholder"].forEach(function (attr) {
        var v = node.getAttribute(attr);
        if (!v) return;
        var t = translateValue(v);
        if (t !== v) node.setAttribute(attr, t);
      });
    }
  }
  function translateChrome() {
    var sel = ".navbar, .primary-navigation, .secondary-navigation, .tertiary-navigation, .moremenu, .usermenu, .dropdown-menu, .popover, .popover-region-container, .drawerheader, .breadcrumb, #page-header, #page-footer, .modal, [role='dialog'], [role='menu'], [role='tooltip'], .block .card-title, .block .card-header, .page-header-headings, .helpdoc, .popover-body, .modal-body, .block_course_overview_campus, #page-footer, footer, .block_timeline, .block_calendar_upcoming, .block_calendar_month, .block_private_files";
    var roots = document.querySelectorAll(sel);
    for (var i = 0; i < roots.length; i++) translateEl(roots[i]);
  }
  function apply() {
    if (window.__plLookBusy) return;
    window.__plLookBusy = true;
    try {
      translateChrome();
      var links = document.querySelectorAll("#region-main a[href*='course/view.php'], [data-region='courses-view'] a[href*='course/view.php']");
      var best = {};
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        if (inNav(a)) continue;
        var id = courseId(a);
        if (!id) continue;
        var live = (a.innerText || "").replace(/\\s+/g, " ").trim();
        var text = a.getAttribute("data-pl-text") || live;
        if (!text || text.length < 8) continue;
        if (/^(enter|open|view|go|ansehen|öffnen|offnen)$/i.test(text)) continue;
        var prev = best[id];
        if (!prev || text.length > prev.text.length) best[id] = { a: a, text: text };
      }
      var ids = Object.keys(best);
      var overview = ids.length >= 2 && !/\\/course\\/view\\.php/i.test(location.pathname);
      if (!overview) {
        var stale = document.querySelectorAll("[data-pl-html]");
        for (var s = 0; s < stale.length; s++) {
          stale[s].innerHTML = stale[s].getAttribute("data-pl-html");
          stale[s].removeAttribute("data-pl-html");
          stale[s].removeAttribute("data-pl-text");
          stale[s].removeAttribute("data-pl-shown");
        }
        var unhide = document.querySelectorAll("[data-pl-hide]");
        for (var u = 0; u < unhide.length; u++) unhide[u].removeAttribute("data-pl-hide");
      }
      var shown = 0;
      for (var n = 0; n < ids.length && overview; n++) {
        var idn = ids[n];
        var item = best[idn];
        var link = item.a;
        var original = link.getAttribute("data-pl-text") || item.text;
        var short = shortOf(idn, original);
        var isEx = EX.test(fold(original));
        if (isEx && !/ – (Exercise|Tutorial)$/.test(short)) short += /\\btutori(al|als|um)\\b/.test(fold(original)) ? " – Tutorial" : " – Exercise";
        var visible = !overview || (TAB === "exercises" ? isEx : !isEx);
        if (visible) shown++;
        var card = cardOf(link);
        if (visible) card.removeAttribute("data-pl-hide");
        else card.setAttribute("data-pl-hide", "1");
        var want = short + "|" + original;
        if (link.getAttribute("data-pl-shown") === want) continue;
        if (!link.getAttribute("data-pl-html")) link.setAttribute("data-pl-html", link.innerHTML);
        link.setAttribute("data-pl-text", original);
        var kept = [];
        var kids = link.querySelectorAll("input, button, .form-switch, .form-check, .custom-control, .dropdown, .action-menu");
        for (var k = 0; k < kids.length; k++) kept.push(kids[k]);
        link.textContent = "";
        var main = document.createElement("span");
        main.className = "pl-short";
        main.textContent = short;
        link.appendChild(main);
        if (short !== original) {
          var sub = document.createElement("span");
          sub.className = "pl-full";
          sub.textContent = original;
          link.appendChild(sub);
        }
        for (var r = 0; r < kept.length; r++) link.appendChild(kept[r]);
        link.setAttribute("data-pl-shown", want);
      }
      root.classList.remove("pl-overview");
      var host = document.getElementById("region-main") || document.getElementById("page-content") || document.body;
      var bar = document.getElementById("pl-tabs");
      if (!overview) {
        if (bar) bar.remove();
      } else if (host) {
        if (!bar) {
          bar = document.createElement("div");
          bar.id = "pl-tabs";
          bar.setAttribute("role", "tablist");
          ["lectures", "exercises"].forEach(function (tid) {
            var b = document.createElement("button");
            b.type = "button";
            b.setAttribute("data-pl-tab", tid);
            b.textContent = tid === "lectures" ? "Lectures" : "Exercises";
            b.addEventListener("click", function () {
              if (TAB === tid) return;
              TAB = tid;
              try { sessionStorage.setItem("pl-tab", tid); } catch (e) {}
              var post = window.paperlikePost;
              if (typeof post === "function") post({ type: "custom-tab", tab: tid });
              apply();
            });
            bar.appendChild(b);
          });
          var note = document.createElement("span");
          note.className = "pl-tab-note";
          bar.appendChild(note);
        }
        if (bar.parentElement !== host) host.insertBefore(bar, host.firstChild);
        var buttons = bar.querySelectorAll("button");
        for (var k = 0; k < buttons.length; k++) {
          var sel = buttons[k].getAttribute("data-pl-tab") === TAB ? "true" : "false";
          if (buttons[k].getAttribute("aria-selected") !== sel) buttons[k].setAttribute("aria-selected", sel);
        }
        var noteEl = bar.querySelector(".pl-tab-note");
        var noteText = shown ? "" : "Nothing on this tab.";
        if (noteEl && noteEl.textContent !== noteText) noteEl.textContent = noteText;
      }
    } finally {
      window.__plLookBusy = false;
    }
  }
  apply();
  var queued = false;
  var obs = new MutationObserver(function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; apply(); });
  });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  window.__plLookObs = obs;
})();`;
}

/**
 * Sections and activities of one course for the Custom view. Runs on any signed-in
 * Moodle page: it asks the course format state service first, then reads the
 * course page HTML when that service is missing.
 */
export function contentScript(courseId: number): string {
  const id = Math.max(0, Math.floor(Number(courseId) || 0));
  return `(async () => {
  const post = window.paperlikePost;
  if (typeof post !== "function") return;
  const courseId = ${id};
  const host = location.hostname.toLowerCase();
  if (!(host === "moodle.tum.de" || host.endsWith(".moodle.tum.de"))) return;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(window.M && window.M.cfg && window.M.cfg.sesskey)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!(window.M && window.M.cfg && window.M.cfg.sesskey)) { await post({ type: "login-required" }); return; }
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, 300);
  const abs = (u) => { try { return u ? new URL(u, location.origin).href : ""; } catch (e) { return ""; } };
  let budget = 700;
  const viaState = async () => {
    const url = new URL("/lib/ajax/service.php", location.origin);
    url.searchParams.set("sesskey", window.M.cfg.sesskey);
    url.searchParams.set("info", "core_courseformat_get_state");
    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ index: 0, methodname: "core_courseformat_get_state", args: { courseid: courseId } }])
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || row.error || typeof row.data !== "string") throw new Error("state");
    const state = JSON.parse(row.data);
    const cms = new Map();
    for (const cm of state.cm || []) cms.set(String(cm.id), cm);
    const out = [];
    for (const s of state.section || []) {
      if (s.uservisible === false) continue;
      const items = [];
      for (const cmid of s.cmlist || []) {
        const cm = cms.get(String(cmid));
        if (!cm || cm.uservisible === false || budget <= 0) continue;
        budget--;
        items.push({ id: Number(cm.id) || 0, name: clean(cm.name), kind: String(cm.module || cm.modname || ""), url: abs(cm.url) });
      }
      const number = Number(s.number != null ? s.number : s.section);
      out.push({ title: clean(s.title), number: isFinite(number) ? number : out.length, current: !!s.current, url: abs(s.sectionurl), items: items });
    }
    return out;
  };
  const viaPage = async () => {
    const res = await fetch(location.origin + "/course/view.php?id=" + courseId, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const nodes = [];
    for (const n of doc.querySelectorAll("li.section, div.section, [data-sectionid]")) {
      if (n.parentElement && n.parentElement.closest("li.section, div.section, [data-sectionid]")) continue;
      if (nodes.indexOf(n) < 0) nodes.push(n);
    }
    const out = [];
    nodes.forEach((section, index) => {
      const head = section.querySelector(".sectionname") || section.querySelector("h3, h4");
      const title = clean((head && head.textContent) || section.getAttribute("aria-label"));
      const items = [];
      const seen = new Set();
      for (const el of section.querySelectorAll("li.activity, [data-for='cmitem']")) {
        if (seen.has(el) || budget <= 0) continue;
        seen.add(el);
        let kind = "";
        el.classList.forEach((c) => { if (c.indexOf("modtype_") === 0) kind = c.slice(8); });
        const link = el.querySelector("a.aalink") || el.querySelector("a[href*='/mod/']");
        const nameEl = el.querySelector(".instancename") || link;
        let name = "";
        if (nameEl) {
          const copy = nameEl.cloneNode(true);
          copy.querySelectorAll(".accesshide, .sr-only").forEach((x) => x.remove());
          name = clean(copy.textContent);
        }
        if (!name) name = clean(el.textContent);
        if (!name) continue;
        budget--;
        const idm = String(el.id || "").match(/(\\d+)$/);
        items.push({ id: idm ? Number(idm[1]) : 0, name: name, kind: kind, url: abs(link && link.getAttribute("href")) });
      }
      const more = section.querySelector("a[href*='section.php'], a[href*='section=']");
      const number = Number(section.getAttribute("data-number") || section.getAttribute("data-sectionnum") || index);
      out.push({
        title: title,
        number: isFinite(number) ? number : index,
        current: section.classList.contains("current"),
        url: abs(more && more.getAttribute("href")),
        items: items
      });
    });
    return out;
  };
  let sections = [];
  try { sections = await viaState(); } catch (e) { sections = []; }
  if (!sections.length) {
    try { sections = await viaPage(); }
    catch (e) {
      await post({ type: "content-error", courseId: courseId, message: "Moodle did not return this course." });
      return;
    }
  }
  await post({ type: "content", courseId: courseId, sections: sections.slice(0, 150) });
})();`;
}

export const WEEK_SCRIPT = `(async () => {
  const post = window.paperlikePost;
  if (typeof post !== "function") return;
  const host = location.hostname.toLowerCase();
  if (host.endsWith(".aai.dfn.de") || host === "aai.dfn.de" || /\\/(login|auth|idp|shibboleth|saml)(\\/|$)/i.test(location.pathname)) {
    await post({ type: "login-required" });
    return;
  }
  if (!/course\\/view\\.php/i.test(location.pathname)) return;
  if (!(window.M && window.M.cfg)) {
    await post({ type: "login-required" });
    return;
  }
  const fold = (s) => String(s || "").normalize("NFD").replace(/\\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();
  const months = { januar:1, jan:1, january:1, februar:2, feb:2, february:2, marz:3, mrz:3, mar:3, march:3, april:4, apr:4, mai:5, may:5, juni:6, jun:6, june:6, juli:7, jul:7, july:7, august:8, aug:8, september:9, sep:9, sept:9, oktober:10, okt:10, october:10, oct:10, november:11, nov:11, dezember:12, dez:12, december:12, dec:12 };
  const yearOf = (y) => {
    if (!y) return new Date().getFullYear();
    const n = Number(y);
    if (n < 100) return 2000 + n;
    return n;
  };
  const containsToday = (a, b) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const start = new Date(a.y, a.m - 1, a.d).getTime();
    const end = new Date(b.y, b.m - 1, b.d).getTime();
    if (end < start) {
      const endNext = new Date(b.y + 1, b.m - 1, b.d).getTime();
      if (today >= start && today <= endNext) return true;
      const startPrev = new Date(a.y - 1, a.m - 1, a.d).getTime();
      return today >= startPrev && today <= end;
    }
    return today >= start && today <= end;
  };
  const rangeOf = (title) => {
    const s = fold(title).replace(/[–—]/g, "-").replace(/\\bbis\\b/g, "-");
    let m = s.match(/(\\d{1,2})\\.(\\d{1,2})\\.(\\d{2,4})?\\s*-\\s*(\\d{1,2})\\.(\\d{1,2})\\.(\\d{2,4})?/);
    if (m) return containsToday({ d: +m[1], m: +m[2], y: yearOf(m[3]) }, { d: +m[4], m: +m[5], y: yearOf(m[6] || m[3]) });
    m = s.match(/(\\d{1,2})\\.?\\s+([a-z]{3,12})\\.?\\s*(\\d{4})?\\s*-\\s*(\\d{1,2})\\.?\\s+([a-z]{3,12})\\.?\\s*(\\d{4})?/);
    if (m && months[m[2]] && months[m[5]]) return containsToday({ d: +m[1], m: months[m[2]], y: yearOf(m[3]) }, { d: +m[4], m: months[m[5]], y: yearOf(m[6] || m[3]) });
    m = s.match(/([a-z]{3,12})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\,?\\s*(\\d{4})?\\s*-\\s*([a-z]{3,12})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\,?\\s*(\\d{4})?/);
    if (m && months[m[1]] && months[m[4]]) return containsToday({ d: +m[2], m: months[m[1]], y: yearOf(m[3]) }, { d: +m[5], m: months[m[4]], y: yearOf(m[6] || m[3]) });
    return false;
  };
  const sections = [];
  const seen = new Set();
  for (const n of document.querySelectorAll("li.section, div.section, [data-sectionid]")) {
    if (seen.has(n)) continue;
    if (n.parentElement && n.parentElement.closest("li.section, [data-sectionid]")) continue;
    seen.add(n);
    sections.push(n);
  }
  const titleOf = (section) => {
    const name = section.querySelector(".sectionname") || section.querySelector("h3, h4");
    return ((name && name.textContent) || section.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
  };
  const marked = (section) => {
    if (section.classList.contains("current")) return true;
    const header = section.querySelector(".course-section-header") || section.querySelector(".sectionname") || section;
    const text = (header.innerText || header.textContent || "").toLowerCase();
    return text.indexOf("aktuelle woche") >= 0 || text.indexOf("current week") >= 0;
  };
  let picked = null;
  let confidence = "low";
  let currentHit = false;
  let phaseN = -1;
  for (const section of sections) {
    const title = titleOf(section);
    if (!title || /^general$/i.test(title) || title.toLowerCase() === "allgemein") continue;
    if (marked(section)) {
      if (!currentHit) { picked = section; confidence = "high"; currentHit = true; }
    } else if (!currentHit && confidence !== "high" && rangeOf(title)) { picked = section; confidence = "high"; }
    const pm = title.match(/\\b(phase|woche|week)\\s*(\\d{1,2})\\b/i);
    if (pm && confidence !== "high") {
      const n = Number(pm[2]);
      if (n >= phaseN) { phaseN = n; picked = section; }
    }
  }
  if (!picked) { await post({ type: "week", title: "", confidence: "low" }); return; }
  const title = titleOf(picked).slice(0, 240);
  const buttons = picked.querySelectorAll("[aria-expanded='false']");
  for (const el of buttons) {
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      if (href && href !== "#" && href.indexOf("javascript:") !== 0) continue;
    }
    el.click();
    break;
  }
  try { picked.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
  picked.style.outline = "2px solid #6d4fc4";
  picked.style.outlineOffset = "2px";
  setTimeout(() => { picked.style.outline = ""; picked.style.outlineOffset = ""; }, 1600);
  await post({ type: "week", title: title, confidence: confidence });
})();`;

/** Fetch one Moodle file with the signed-in session and hand it to the note. */
export function fileGrabScript(url: string, name: string, token = 0): string {
  return `(async function () {
    var post = window.paperlikePost;
    var url = ${JSON.stringify(url)};
    var name = ${JSON.stringify(name)};
    var token = ${token};
    var grab = window.__plGrabFile;
    if (typeof grab === "function") { grab(url, name, false, token); return; }
    if (typeof post !== "function") return;
    try {
      if (!/^https:\\/\\/([a-z0-9-]+\\.)*moodle\\.tum\\.de\\//i.test(url)) {
        await post({ type: "pdf-error", message: "That link is not a note file." });
        return;
      }
      var res = await fetch(url, { credentials: "include" });
      if (!res.ok) { await post({ type: "pdf-error", message: "The file returned " + res.status }); return; }
      var buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 40 * 1024 * 1024) { await post({ type: "pdf-error", message: "That file is larger than 40 MB." }); return; }
      if (buf.length < 5) { await post({ type: "pdf-error", message: "The file was empty." }); return; }
      var block = 32766;
      var b64 = "";
      for (var i = 0; i < buf.length; i += block) b64 += btoa(String.fromCharCode.apply(null, buf.subarray(i, i + block)));
      var size = 200000;
      var n = Math.ceil(b64.length / size) || 1;
      await post({ type: "pdf-begin", name: name || "file", insert: true });
      for (var c = 0; c < n; c++) await post({ type: "pdf-chunk", i: c, b64: b64.slice(c * size, c * size + size) });
      await post({ type: "pdf-end", count: n });
    } catch (e) {
      try { await post({ type: "pdf-error", message: String(e).slice(0, 300) }); } catch (e2) {}
    }
  })();`;
}

/**
 * "Add to note" on course files, and a drag that lands on the note.
 * Runs on the original page and the custom look.
 */
export const FILE_ACTIONS_SCRIPT = `(function () {
  var post = window.paperlikePost;
  if (typeof post !== "function" || window.__plFiles) return;
  window.__plFiles = true;
  var style = document.getElementById("pl-files");
  if (!style) {
    style = document.createElement("style");
    style.id = "pl-files";
    style.textContent = ".pl-file-row{display:flex !important;align-items:center;flex-wrap:nowrap;gap:8px}.pl-file-row>a{flex:1 1 auto;min-width:0;cursor:grab}.pl-add{position:relative;z-index:6;flex:0 0 auto;margin:0;padding:2px 8px;border:1px solid #e2ddd3;border-radius:999px;background:#fff;color:#23201c;font:600 12px/1.4 \\"Segoe UI\\",system-ui,sans-serif;cursor:pointer;white-space:nowrap}.pl-add:hover{border-color:#6d4fc4;color:#6d4fc4}";
    document.head.appendChild(style);
  }
  function moodleFile(url) {
    try {
      var u = new URL(url, location.origin);
      var host = u.hostname.toLowerCase();
      if (!(host === "moodle.tum.de" || host.endsWith(".moodle.tum.de"))) return false;
      if (u.protocol !== "https:") return false;
      var path = u.pathname.toLowerCase();
      if (/\\/course\\/view\\.php/.test(path)) return false;
      return /pluginfile\\.php/.test(path) || /\\/mod\\/resource\\/view\\.php/.test(path) || /\\.(pdf|png|jpe?g|gif|webp)$/.test(path);
    } catch (e) { return false; }
  }
  function nameOf(a) {
    var inst = a.querySelector(".instancename");
    var text = ((inst || a).innerText || a.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
    return text.replace(/\\b(file|datei|bild|image)\\s*$/i, "").trim() || "file";
  }
  function looksHtml(buf) {
    var n = Math.min(buf.length, 400);
    var s = "";
    for (var i = 0; i < n; i++) s += String.fromCharCode(buf[i]);
    return /<!doctype|<html|<head|<body/i.test(s);
  }
  function isPdfBytes(buf) {
    if (looksHtml(buf)) return false;
    var n = Math.min(buf.length, 1024);
    for (var i = 0; i < n - 4; i++) {
      if (buf[i] === 0x25 && buf[i + 1] === 0x50 && buf[i + 2] === 0x44 && buf[i + 3] === 0x46) return true;
    }
    return false;
  }
  function isFileBytes(buf) {
    if (isPdfBytes(buf)) return true;
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    return buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45;
  }
  function directUrl(url) {
    try {
      var u = new URL(url, location.origin);
      if (/\\/mod\\/resource\\/view\\.php$/i.test(u.pathname) && u.searchParams.get("redirect") !== "1") {
        u.searchParams.set("redirect", "1");
        return u.toString();
      }
    } catch (e) {}
    return url;
  }
  function findFileUrl(html, base) {
    var text = String(html || "").split("\\\\/").join("/").split("&amp;").join("&");
    var abs = text.match(/https?:\\/\\/[^"'\\s<>]*pluginfile\\.php[^"'\\s<>]*/i);
    if (abs) return abs[0];
    var rel = text.match(/(?:\\/|\\.)[^"'\\s<>]*pluginfile\\.php[^"'\\s<>]*/i);
    if (rel) {
      try { return new URL(rel[0], base).toString(); } catch (e1) {}
    }
    var again = text.match(/https?:\\/\\/[^"'\\s<>]*\\/mod\\/resource\\/view\\.php\\?[^"'\\s<>]*redirect=1[^"'\\s<>]*/i);
    return again ? again[0] : "";
  }
  function pdfShape(buf) {
    function countIn(from, to) {
      var best = 0;
      var end = Math.min(buf.length, to);
      for (var i = from; i < end - 12; i++) {
        if (buf[i] !== 47 || buf[i + 1] !== 80 || buf[i + 2] !== 97 || buf[i + 3] !== 103 || buf[i + 4] !== 101 || buf[i + 5] !== 115) continue;
        var stop = Math.min(end, i + 160);
        for (var j = i + 6; j < stop - 6; j++) {
          if (buf[j] !== 47 || buf[j + 1] !== 67 || buf[j + 2] !== 111 || buf[j + 3] !== 117 || buf[j + 4] !== 110 || buf[j + 5] !== 116) continue;
          var k = j + 6;
          while (k < stop && (buf[k] === 32 || buf[k] === 10 || buf[k] === 13 || buf[k] === 9)) k++;
          var num = 0, any = false;
          while (k < stop && buf[k] >= 48 && buf[k] <= 57) { any = true; num = num * 10 + (buf[k] - 48); if (num > 4000) break; k++; }
          if (any && num > best && num <= 4000) best = num;
          break;
        }
      }
      return best;
    }
    function aspectIn(from, to) {
      var end = Math.min(buf.length, to);
      for (var i = from; i < end - 16; i++) {
        if (buf[i] !== 47 || buf[i + 1] !== 77 || buf[i + 2] !== 101 || buf[i + 3] !== 100 || buf[i + 4] !== 105) continue;
        var k = i + 9;
        var stop = Math.min(end, i + 90);
        while (k < stop && buf[k] !== 91) k++;
        if (buf[k] !== 91) continue;
        var nums = [], cur = "", sign = 1, seen = false;
        for (var t = k + 1; t < stop && buf[t] !== 93; t++) {
          var c = buf[t];
          if (c === 45) { sign = -1; continue; }
          if (c >= 48 && c <= 57) { seen = true; cur += String.fromCharCode(c); continue; }
          if (c === 46 && seen) { cur += "."; continue; }
          if (seen) { nums.push(sign * parseFloat(cur)); cur = ""; sign = 1; seen = false; }
        }
        if (seen) nums.push(sign * parseFloat(cur));
        if (nums.length >= 4) {
          var w = nums[2] - nums[0];
          var h = nums[3] - nums[1];
          if (w > 20 && h > 20) return h / w;
        }
      }
      return 0;
    }
    var tail = Math.max(0, buf.length - 700000);
    var pages = countIn(tail, buf.length) || 1;
    var aspect = aspectIn(0, Math.min(buf.length, 1200000)) || aspectIn(tail, buf.length) || 1.294;
    if (!(aspect > 0.15 && aspect < 8)) aspect = 1.294;
    if (pages > 400) pages = 400;
    return { pages: pages, aspect: aspect };
  }
  async function grab(url, name, hopped, token) {
    token = token || 0;
    try {
      if (!hopped) url = directUrl(url);
      if (!moodleFile(url)) { await post({ type: "pdf-error", message: "That link is not a note file.", token: token }); return; }
      var res = await fetch(url, { credentials: "include" });
      if (!res.ok) { await post({ type: "pdf-error", message: "The file returned " + res.status, token: token }); return; }
      var buf = new Uint8Array(await res.arrayBuffer());
      if (!hopped && !isFileBytes(buf)) {
        var html = "";
        try { html = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024))); } catch (e0) {}
        var found = findFileUrl(html, url);
        if (found) { await grab(found, name, true, token); return; }
      }
      if (buf.length > 40 * 1024 * 1024) { await post({ type: "pdf-error", message: "That file is larger than 40 MB.", token: token }); return; }
      if (buf.length < 5 || !isFileBytes(buf)) { await post({ type: "pdf-error", message: "That file can't be added to a note.", token: token }); return; }
      if (token && isPdfBytes(buf)) {
        var shape = pdfShape(buf);
        await post({ type: "pdf-ghost", pages: shape.pages, aspect: shape.aspect, token: token });
      }
      var block = 32766;
      var b64 = "";
      for (var i = 0; i < buf.length; i += block) b64 += btoa(String.fromCharCode.apply(null, buf.subarray(i, i + block)));
      var size = 200000;
      var n = Math.ceil(b64.length / size) || 1;
      await post({ type: "pdf-begin", name: name || "file", insert: true, token: token });
      for (var c = 0; c < n; c++) await post({ type: "pdf-chunk", i: c, b64: b64.slice(c * size, c * size + size) });
      await post({ type: "pdf-end", count: n });
    } catch (e) {
      try { await post({ type: "pdf-error", message: String(e).slice(0, 300), token: token }); } catch (e2) {}
    }
  }
  window.__plGrabFile = grab;
  function inChrome(a) {
    return !!a.closest(".navbar, .primary-navigation, .secondary-navigation, .moremenu, .usermenu, .dropdown-menu, .popover, .breadcrumb, #page-footer, #courseindex, .tertiary-navigation, #pl-tabs");
  }
  function markTopMenu() {
    var labels = ["organizational issues", "lecture material", "exercise material", "knowledge tests", "recommended literature", "information examination"];
    var nodes = document.querySelectorAll("#region-main a, #region-main button, #page-header a, .secondary-navigation a, .tertiary-navigation a");
    var hits = [];
    for (var i = 0; i < nodes.length; i++) {
      var text = (nodes[i].textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (!text || text.length > 80) continue;
      for (var k = 0; k < labels.length; k++) {
        if (text.indexOf(labels[k]) !== -1) { hits.push(nodes[i]); break; }
      }
    }
    if (hits.length < 2) return;
    var parent = hits[0].parentElement;
    while (parent && parent !== document.body) {
      var n = 0;
      for (var h = 0; h < hits.length; h++) if (parent.contains(hits[h])) n++;
      if (n >= Math.min(hits.length, 3) && parent.id !== "region-main" && parent.id !== "page" && parent.id !== "page-wrapper" && parent.id !== "page-content") break;
      parent = parent.parentElement;
    }
    if (parent && parent !== document.body && parent.id !== "region-main" && parent.id !== "page" && parent.id !== "page-content") parent.classList.add("pl-topmenu");
    for (var h = 0; h < hits.length; h++) hits[h].classList.add("pl-topmenu-item");
  }
  function decorate() {
    markTopMenu();
    var links = document.querySelectorAll("#region-main a[href], [data-region='course-content'] a[href]");
    for (var i = 0; i < links.length; i++) {
      (function (a) {
        if (inChrome(a) || !moodleFile(a.href) || a.dataset.plFile === "1") return;
        a.dataset.plFile = "1";
        a.setAttribute("draggable", "false");
        var fileUrl = a.href;
        var fileName = nameOf(a);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pl-add";
        btn.textContent = "Add to note";
        btn.title = "Put this file on the note. You can also drag the file name onto the page.";
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          grab(fileUrl, fileName);
        });
        btn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        var row = a.closest(".activity-name") || a.closest(".activityname") || a.parentElement || a;
        row.classList.add("pl-file-row");
        row.appendChild(btn);
        var suppressClick = false;
        a.addEventListener("dragstart", function (e) {
          e.preventDefault();
          e.stopPropagation();
        }, true);
        // Start tracking on press. Pointer events die when the cursor leaves this
        // webview, so the app follows the mouse from here — a click that never
        // moves still opens the file.
        a.addEventListener("pointerdown", function (e) {
          if (e.button !== 0) return;
          var sx = e.screenX, sy = e.screenY;
          var dragged = false;
          post({ type: "file-drag-begin", url: fileUrl, name: fileName, cx: e.clientX, cy: e.clientY });
          function move(ev) {
            if (!dragged && Math.hypot((ev.screenX || 0) - sx, (ev.screenY || 0) - sy) > 6) {
              dragged = true;
              suppressClick = true;
            }
          }
          function up() {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            document.removeEventListener("pointercancel", up, true);
          }
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", up, true);
        });
        a.addEventListener("click", function (e) {
          if (!suppressClick) return;
          suppressClick = false;
          e.preventDefault();
          e.stopPropagation();
        }, true);
      })(links[i]);
    }
  }
  decorate();
  var queued = false;
  new MutationObserver(function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; decorate(); });
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
})();`;

export const SAVE_PDF_SCRIPT = `(async () => {
  const post = window.paperlikePost;
  if (typeof post !== "function") return;
  const fail = async (message) => { try { await post({ type: "pdf-error", message: String(message).slice(0, 300) }); } catch (e) {} };
  try {
    const res = await fetch(location.href, { credentials: "include" });
    if (!res.ok) { await fail("The page returned " + res.status); return; }
    const buf = new Uint8Array(await res.arrayBuffer());
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const pdf = ctype.indexOf("pdf") >= 0 || (buf.length >= 4 && buf[0] === 37 && buf[1] === 80 && buf[2] === 68 && buf[3] === 70);
    if (!pdf) { await fail("This page is not a PDF. Open the file, then use Save PDF to Material."); return; }
    if (buf.length > 40 * 1024 * 1024) { await fail("That PDF is larger than 40 MB."); return; }
    if (buf.length < 5) { await fail("The PDF was empty."); return; }
    let name = "";
    const cd = res.headers.get("content-disposition") || "";
    const star = /filename\\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
    if (star) { try { name = decodeURIComponent(star[1].trim()); } catch (e) { name = star[1].trim(); } }
    else if (plain) name = plain[1].trim();
    if (!name) {
      try { name = decodeURIComponent((location.pathname.split("/").pop() || "")); } catch (e) { name = "download.pdf"; }
    }
    const block = 32766;
    let b64 = "";
    for (let i = 0; i < buf.length; i += block) {
      let s = "";
      const end = Math.min(buf.length, i + block);
      for (let j = i; j < end; j++) s += String.fromCharCode(buf[j]);
      b64 += btoa(s);
    }
    await post({ type: "pdf-begin", name: name || "download.pdf" });
    const size = 200000;
    const n = Math.max(1, Math.ceil(b64.length / size));
    for (let i = 0; i < n; i++) await post({ type: "pdf-chunk", i: i, b64: b64.slice(i * size, i * size + size) });
    await post({ type: "pdf-end", count: n });
  } catch (e) {
    await fail(e && e.message ? e.message : e);
  }
})();`;
