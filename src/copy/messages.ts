/** Every sentence a person sees in the tour, license card, feedback, and settings.
 *  Rewrite these in your own voice. The components only read this file. */

export const messages = {
  whatsappUrl: "https://wa.me/qr/NCPPW4YCTTZ4K1",

  trialDays: (n: number) => (n === 1 ? "1 day left" : `${n} days left`),
  trialHome: (n: number) => (n === 1 ? "1 day left of trial" : `${n} days left of trial`),
  trialInfo: "You can still view and export notes after trial ends.",
  trialNotice:
    "5 days remaining until your first month of Paperlike. Enjoying Paperlike? Consider buying a license.",
  premiumOff: "Ask and Moodle stay off after the trial. You can still view and export notes.",
  priceDefault: "",
  trialEnded: "Trial ended",
  expiredCorner: "Expired",
  activated: "Activated.",
  activatedCorner: "Activated",
  readOnly:
    "\nTo get a key, simply send me a quick message on WhatsApp\n\"hi! I'm looking for a paperlike key. I'd like to go with Revolut/ cash/ bank transfer/...\" ",
  expiredBanner:
    "The trial is over. You can still read and export notes. Drawing, typing, and other features stay off until a key is activated.",
  activate: "Activate",
  keyPlaceholder: "Paste your key",
  whatsappHint: "Arrange a key on WhatsApp",

  settingsTitle: "Settings",
  settingsTabGeneral: "General",
  settingsTabDrawing: "Drawing",
  settingsTabFiles: "Files",
  settingsFiles: "Note files",
  settingsTabAbout: "About",
  settingsTabLicense: "License",
  licenseDays: (n: number) => (n === 1 ? "1 day left on this key" : `${n} days left on this key`),
  licenseCorner: (secs: number) => {
    const left = Math.max(0, Math.floor(secs));
    const piece = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
    if (left >= 86_400) {
      const days = Math.floor(left / 86_400);
      const months = Math.floor(days / 30);
      if (months >= 2) return `License activated. ${months} months remaining.`;
      return `License activated. ${piece(days, "day", "days")} remaining.`;
    }
    const hours = Math.floor(left / 3600);
    const minutes = Math.floor((left % 3600) / 60);
    const seconds = left % 60;
    if (left >= 3 * 3600) return `License activated. ${piece(hours, "hour", "hours")} remaining.`;
    if (left >= 10 * 60) {
      const parts = hours > 0 ? [piece(hours, "hour", "hours")] : [];
      parts.push(piece(minutes, "minute", "minutes"));
      return `License activated. ${parts.join(" ")} remaining.`;
    }
    const parts = minutes > 0 ? [piece(minutes, "minute", "minutes")] : [];
    parts.push(piece(seconds, "second", "seconds"));
    return `License activated. ${parts.join(" ")} remaining.`;
  },
  licensePermanent: "Permanently licensed.",
  settingsAppearance: "Appearance",
  settingsTheme: "Theme",
  settingsThemeBright: "Bright",
  settingsThemeMix: "Mix",
  settingsThemeMixHint: "Dark interface, bright page",
  settingsThemeDark: "Dark",
  settingsApp: "On this computer",
  settingsAboutApp: "Paperlike",
  settingsVersion: (v: string) => `Version ${v}`,
  settingsVersionLoading: "Version…",
  settingsLicense: "Your key",
  settingsDanger: "Uninstall",
  updateInstalledTitle: "Paperlike just got better.",
  updateInstalledVersion: (v: string) => `Welcome to new version ${v}.`,
  updateInstalledEmpty: "This version has no written notes.",
  updateHistoryTitle: "Update notes",
  updateHistoryEmpty: "Notes from updates will show up here.",
  updateOnExit: "Install updates when I close Paperlike",
  updateOnExitHint: "On by default. Paperlike quietly downloads a new version in the background and installs it when you close the window.",
  updateCheck: "Check for updates",
  updateChecking: "Checking for updates…",
  updateLatest: "You're on the latest version.",
  updateInstalling: (v: string) => `Updating to ${v}…`,
  autostart: "Run when I sign in",
  autostartHint: "Opens Paperlike after you sign in to Windows.",
  tray: "Keep running in the tray",
  trayHint: "Off by default. When on, closing the window leaves Paperlike in the notification area; use Quit on the tray icon to exit.",
  noteAssoc: "Make Paperlike the default app for .note files",
  noteAssocHint: "After this, double-clicking a .note file opens it in Paperlike.",
  noteAssocDone: "Paperlike will open .note files from File Explorer.",
  replayTour: "Play the welcome tour",

  saveSaving: "Saving…",
  saveUnsaved: "Unsaved",
  saveSaved: "Saved",
  openNoteFirst: "Open a note first",
  nothingToSave: "Nothing to save",
  noNotesToExport: "No notes to export",
  importMarkdownTitle: "Import a Paperlike Markdown export",
  homeDragHint:
    "Drag a notebook onto another to group them, and drag tiles to reorder.",
  shortcutsTitle: "Keyboard shortcuts",
  hideTitle: "Hide title",
  showTitle: "Show the title",
  titleAutoHide:
    "Auto-hide title when you scroll the canvas down. Show the title again when you scroll back to the top.",
  hideToolRow: "Hide the tool row",
  showToolRow: "Show the tool row",
  fullscreen: "Full screen (F11)",
  transfer: "Move this key to another computer",
  transferHint: "This computer lets go of the key. The next computer can paste it. Two moves in each 3-month window.",
  transferLeft: (n: number) =>
    n === 1 ? "1 move left in this 3-month window." : `${n} moves left in this 3-month window.`,
  transferGo: "Move the key",
  transferDone: "This computer let go of the key. Paste it on the next one.",
  uninstall: "Uninstall",
  uninstallTitle: "Uninstall Paperlike",
  uninstallWipe: "Also wipe your notes and Paperlike's data on this PC?",
  uninstallWarn:
    "If you turn this on, Paperlike deletes the notebooks on your Home, the Paperlike documents folder, and its settings and activation. This can't be undone.",
  uninstallGo: "Uninstall",
  uninstallCancel: "Cancel",
  personalUninstallNote: "This copy is the Paperlike.exe you launched. Delete that file when you're done.",

  feedbackButton: "Feedback",
  feedbackGuide:
    "Give feedback, send me good wishes, or simply write the most offensive thing you can think of. – No judging. – You can do all of these here anonymously and messages will land directly in my inbox. If I write back, you can answer on that same note.\nYours truly, the developer",
  feedbackSend: "Send",
  feedbackWriteBack: "Write back",
  feedbackFailed: "Couldn't send that. Try again.",
  feedbackPast: "Past messages",
  feedbackEmpty: "Nothing sent from this computer yet.",
  feedbackYou: "You",
  feedbackReply: "Reply",

  tourSkipLater: "No problem. You can replay the tour any time from Settings → General.",
  tourOk: "OK",
  tourBack: "Back",
  tourNext: "Next",
  tourSkip: "Skip tour",
  tourDone: "Finish",
  tourStart: "Show me around",
  tourLater: "Not now",
  tourDoThis: "Do that, then continue.",
  tourStepOf: (n: number, total: number) => `${n} of ${total}`,
  tourIntro:
    "Hi! Want a quick tour? It takes about two minutes, and you can leave at any point.",
  tourStudyTitle: "Your TUM folders",
  tourStudyReady: (root: string) =>
    `They're ready in ${root}: a notebook for each first-semester lecture, each with a Material folder for the PDFs, plus an Exercises folder per course.`,
  tourStudyOffer:
    "Studying Aerospace at TUM? Settings → Study can lay out a notebook for each first-semester lecture, with Material and Exercises folders. You can do that later too.",

  studyTitle: "Are you a TUM Aerospace student?",
  studyIntro:
    "Paperlike can make a TUM folder for the first semester: a notebook for each lecture, a Material folder in each one for the PDFs, and an Exercises folder for each course.",
  studyLocation: "Location",
  studyChange: "Change…",
  studyCreateFolders: "Create the folders and notebooks",
  studyMoodle: "Turn on the Moodle course browser",
  studyYes: "Yes, set it up",
  studyNo: "No",
  studyLater: "Ask me later",
  studyWorking: "Setting it up…",
  studyCreatedIn: (root: string) => `Created in ${root}`,
  studyKept: "Anything already there was left as it is.",
  studyNotebooksHeading: "Notebooks",
  studyFoldersHeading: "Folders",
  studyNone: "Nothing new was written.",
  studyOpenHome: "Open Home",
  studyThumbPlaceholder: "thumbnail.png",
  studyThumbHint: "src-tauri/resources/presets/tum-aerospace",
  settingsStudy: "Study",
  studyMoodleSwitch: "Moodle course browser",
  studyMoodleHint:
    "Shows a Moodle button in TUM notebooks that opens the matching course and its current week.",
  studyCreateButton: "Create the TUM Aerospace setup…",
  moodleSignIn: "Sign in to TUM Moodle in this pane.",
  moodleSigningIn: "Signing in…",
  moodleSaveOffer:
    "Save Moodle sign-in on this PC? Stored only locally and encrypted for your Windows user.",
  moodleSaveYes: "Save sign-in",
  moodleSaveNo: "Not now",
  moodleSaveDone: "Moodle sign-in saved on this PC.",
  moodleForgetLogin: "Forget saved Moodle sign-in",
  moodleForgetHint: "Removes the encrypted username and password stored for automatic Moodle sign-in.",
  moodleForgetDone: "Saved Moodle sign-in removed.",
  moodleNoSavedLogin: "No Moodle sign-in is saved on this PC.",

  settingsDrawing: "Drawing & pen",
  penEnabled: "Enable pen input",
  penEnabledHint: "Off treats the pen like a mouse.",
  penAlwaysDraws: "Pen draws while Select is on",
  penAlwaysDrawsHint: "A pen press uses the last pen or marker. Mouse and touch keep the current tool.",
  penPressure: "Use pen pressure",
  penPressureHint: "The line thickens where you press harder.",
  palmRejection: "Ignore touch while using the pen",
  palmRejectionHint: "A resting palm won't draw, select, or pan. Scrolling and the touchpad stay.",

};

export type TourUntil = "opened-notebook" | "ribbon-file" | "ribbon-edit" | "ribbon-draw" | "pdf-on" | "back-home";

export type TourStep = {
  /** Short heading above the text. */
  title: string;
  text: string;
  /** `data-tour` anchor, or "center" for a free-floating card. */
  at: string;
  /** Used when `at` is missing or is an empty container (e.g. Home with no notebooks yet). */
  fallbackAt?: string;
  /** Next stays off until this is true. */
  until?: TourUntil;
  /** Shown under the text while `until` is not met. */
  hint?: string;
  /**
   * Highlight with a ring only (no dim overlay) so the user can see and use the
   * target — tiles, the page, ribbon tabs, PDF Preview, etc.
   */
  clearSpot?: boolean;
};

/** The moving tour. Step 0 of the card is `messages.tourIntro`. */
export const tourSteps: TourStep[] = [
  {
    title: "Home",
    text: "This is Home. Every tile is a notebook — a plain folder on this PC with your notes inside. No account, no sync. The files are yours.",
    at: "home-grid",
    fallbackAt: "home-blank",
  },
  {
    title: "Adding notes",
    text: "Add brings in a folder you already have, or searches this PC for notes. Drag one tile onto another to group them, like apps on a phone.",
    at: "home-add",
  },
  {
    title: "Open a notebook",
    text: "Click any tile to open it. Or hit New note if you'd rather start blank. I'll meet you inside.",
    at: "home-grid",
    fallbackAt: "home-blank",
    until: "opened-notebook",
    hint: "Click a notebook tile or New note to continue.",
    clearSpot: true,
  },
  {
    title: "Your notes",
    text: "The notes in this notebook line up on the left. A new note starts unnamed; Add today puts the date in front when that's handy.",
    at: "nb-sidebar",
    clearSpot: true,
  },
  {
    title: "The page",
    text: "The page works like paper. Click anywhere to drop a text box, drag it where you like, paste an image, or draw straight on it.",
    at: "nb-canvas",
    clearSpot: true,
  },
  {
    title: "Moodle",
    text: "Course notebooks get a Moodle button up here — it opens the matching course beside your note.",
    at: "nb-moodle",
    fallbackAt: "nb-canvas",
  },
  {
    title: "Edit",
    text: "Click Edit. That's where text styling, lists, tables, and pictures live.",
    at: "nb-edit",
    until: "ribbon-edit",
    hint: "Click the Edit tab.",
    clearSpot: true,
  },
  {
    title: "Draw",
    text: "Now Draw — pens, markers, shapes, and arrows. A pen with pressure works out of the box.",
    at: "nb-draw",
    until: "ribbon-draw",
    hint: "Click the Draw tab.",
    clearSpot: true,
  },
  {
    title: "File",
    text: "Click File. Saving happens on its own a moment after you stop. From here you can also export one or many notes to PDF or Markdown.",
    at: "nb-file",
    until: "ribbon-file",
    hint: "Click the File tab.",
    clearSpot: true,
  },
  {
    title: "PDF Preview",
    text: "Try PDF Preview. It shows the pages an export would make, and you can keep editing right on them. Shift-click selects images, Shift-drag reorders pages, and right-click → Lock pins something in place.",
    at: "nb-pdf",
    until: "pdf-on",
    hint: "Turn on PDF Preview.",
    clearSpot: true,
  },
  {
    title: "Ask and Brief",
    text: "Need a hand? Type a quick question up here for a short answer, open Ask to chat beside the page, or use Brief to build a study sheet from several notes.",
    at: "nb-ask",
    clearSpot: true,
  },
  {
    title: "Back to Home",
    text: "Click Home to get back to your notebooks.",
    at: "nb-home",
    until: "back-home",
    hint: "Click the Home button.",
    clearSpot: true,
  },
  {
    title: "That's it",
    text: "Your notes are just files in folders — copy a notebook folder and you've made a backup. Enjoy Paperlike!",
    at: "center",
  },
];

/** Home explanation, then the study-folder step, then the rest of the tour. */
export function tourStepsFor(studyPreset?: string | null, studyRoot?: string | null): TourStep[] {
  const study: TourStep = {
    title: messages.tourStudyTitle,
    text: studyPreset
      ? messages.tourStudyReady(studyRoot?.trim() || "your TUM folder")
      : messages.tourStudyOffer,
    at: "home-grid",
    fallbackAt: "home-blank",
  };
  return [tourSteps[0], study, ...tourSteps.slice(1)];
}
