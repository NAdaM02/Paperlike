# Spec: Brief

A desk for turning selected notes into a study summary. Notes stay on disk.
Nothing leaves the machine until the user sends to Claude or Gemini, or presses
**Write it here**. Everything goes through the user's own claude.ai and
gemini.google.com logins; there are no API keys.

Opened from Home (**Brief**) or from a notebook / standalone note (header **Brief**).
The close button (×) and Esc close it. Esc inside the prompt box only leaves the
box. Ctrl+Enter sends to the chosen chat beside the note.

Task, length and lane (Claude / Gemini) are remembered for the next time
(`localStorage` key `ow.brief.prefs`).

When the Ask pane is open, the desk sits to its left instead of underneath it.

## Sources

- **Notebook:** every note in the open notebook. The current note starts checked.
  The topic field filters by title and text.
- **Standalone note:** that note starts checked.
- **Home:** type at least two letters. Matches come from the global search over
  notebooks and notes on Home. The first 24 unique notes are listed, checked.

The footer of the list shows how many notes are checked and how many words of
text that is.

## What is asked

Tasks: **Study sheet** (default), **Formulas**, **Quiz**, **Explain**.
Length: **Short**, **Study sheet** (default), **Thorough**.

The prompt tells the model to use only the notes, not to invent numbers or
formulas, to keep notation, and to name the source note.

The prompt shown is the one for the chat beside the note: the notes travel as
files (see below), so it names them and says how they are attached instead of
repeating their text. A checked note with no typed text still counts there,
because its pages go in as a PDF. **Write it here** sends no files, so the line
about the attachments (and anything after it) is replaced by the typed text of
each note, capped per note; edits above that line are kept.

The prompt is folded to one line (word count, "edited" once changed). **Read or
edit** unfolds it; **Reset** brings back the generated prompt.

## Quick question

A small field in the header of Home and of every note ("Quick question…",
**Ctrl+K** focuses it). Enter opens a floating card with the answer; the Ask
pane is not involved.

- The question goes to Claude or Gemini through the background chat (see
  "Background chat" below). The card's header switches between them; switching
  asks the last question again in a new conversation with the other one. The
  choice is shared with the Ask pane (`ow.ask.host`).
- The first message of a conversation ends with a line asking for a brief answer
  with exact formulas in LaTeX. The reply shows as it is written, formatted like
  Brief replies (headings, lists, code, LaTeX via KaTeX).
- Text selected in the note when the question is asked goes along as context
  and shows as a quote at the top of the card.
- **Note** (chip in the card's footer) sends the open note's typed text with the
  next question; the open note is saved first. Off by default; the choice is
  remembered (`ow.quick.note`).
- The footer line asks follow-ups in the same conversation. While an answer is
  being written, its send button becomes **Stop**, which keeps what arrived.
- Header of the card: drag to move (it stays left of the Ask pane), copy the
  last answer, **Continue in the Ask panel** (closes the card and opens the
  same conversation in the pane; before a reply exists, the pane opens with
  the question in its box), close. Esc also closes. The lower-right corner
  resizes the card.
- When the chat needs a sign-in, the card says so and offers **Sign in to
  Claude/Gemini**, which opens the Ask pane; the login then serves both.
- A new question from the header field replaces the card's conversation.

## Background chat

Quick questions and **Write it here** use a second browser view per site
(`quick-claude`, `quick-gemini`) with the same profile as the Ask pane, placed
outside the window so it never covers the app. Through the DevTools protocol
the app:

1. opens a new chat (`claude.ai/new`, `gemini.google.com/app`) unless the
   question follows up in the current one, and waits up to 15 s for the
   message box (no box: a sign-in page means "sign in", otherwise "no message
   box");
2. notes how many replies the page shows. A new conversation is switched to the
   site's private mode when the card's **Private** chip is on (Claude's
   incognito, Gemini's temporary chat; remembered as `ow.quick.private`, on by
   default), so it stays out of the site's history. Then the draft in the
   message box is replaced with the message and the site's send button is
   clicked (or Enter is pressed);
3. reads the newest reply every 350 ms, converted back to Markdown (KaTeX
   annotations and `data-math` become `$…$` / `$$…$$`; Claude's thinking
   summary, marked `data-find-omitted`, is left out), and streams it to the
   app as `quick` events. The reply is done when the site shows no Stop button
   and the text has not changed for about a second. No reply within 45 s is
   reported as "no answer".

The send and Stop buttons are found by Gemini's `send-button` / `stop` classes
or by a label that is exactly "Send message" / starts with "Stop" (also the
Hungarian "Üzenet küldése" / "Válasz leállítása"). Partial label matches are
not used: the sidebar's "More options for <chat title>" buttons would match.

Stop clicks the site's Stop button and keeps what arrived. A new question
ends the previous read.

A private chat has no address to reopen, so **Continue in the Ask panel** starts
a new chat whose first message is the conversation so far. The background views
close about two minutes after the card or a Brief write finishes, unless another
question starts first.

Each question rewrites `%APPDATA%\Paperlike\quick-log.txt` with the page's state
after each step (address, message box text, buttons, reply counts and the
reply's structure), for diagnosing a site change.

## Asking beside the note

**Ask** (header of a note, and Home) or **Ctrl+J** opens a chat pane on the right
of the window; Ctrl+J again closes it. The note stays usable beside it. The
pane opens with the host used last (`ow.ask.host`). Claude and Gemini each keep a
profile under `%APPDATA%\Paperlike\browser\`, so a login survives restarts.

Pane layout, top to bottom:

- **Host switch** (Claude | Gemini) and icon buttons: Back, Reload, New chat,
  hide/show the question box, half the window / narrow, Close.
- **Question box** (can be hidden for more chat room, remembered as
  `ow.ask.composer`): quick asks (Explain, Summarize, Quiz me, Check my work,
  Formulas), the question field (grows with the text; Enter sends, Shift+Enter
  adds a line), the attachment chip with the note title (click to send the
  question without the note), and **Send to Claude/Gemini**.
- A thin bar while the chat page loads, then the chat itself.

The left edge of the pane drags to resize (340 px minimum; the note keeps at
least 480 px). Double-click on the edge toggles half the window. The width is
remembered (`ow.ask.width`).

Text selected in the note is offered as context for the next question (a
"Selection" chip that can be dismissed); it is quoted above the question.

**Sending** saves the open note first, then exports, for each attached note, into
`Documents\Paperlike\briefs\attachments\` (emptied each time):

- `<title>.pdf`: the pages as they look, with drawings, slides and page numbers
- `<title>.md`: the same notes as Markdown
- `<title> - <file>.pdf`: every PDF stored in the note

They go to the chat the way a user would add them, through the browser's
DevTools protocol: first the page's own file input (as if picked in its file
dialog); if the file names do not show up on the page within about four
seconds, they are dropped on the message box (as if dragged from Explorer).
Then the question is typed into the box. The files are also left on the
clipboard. The pane reports what happened: files attached (check, then press
Enter in the chat), the chat did not show the files (Ctrl+V in its message
box), or the message box did not appear (sign in, then send again). The chat's
own send button is left to the user.

Claude and Gemini each get their own browser view in the window, created the
first time that host is picked and kept while the app runs.

From Brief, **Send to Claude beside the note** and **Send to Gemini beside the
note** close the desk, open the pane with the checked notes attached, and send
the prompt the same way. A long prompt shows folded in the question box, with
**click to read or edit**.

## Lanes

**Claude** is the lane for a summary the user will reread; **Gemini** has
roomier limits on a free account. Either one offers:

- **Send to Claude/Gemini beside the note**: the Ask pane with the files.
- **Write it here**: the background chat writes it with the inline prompt. The
  reply streams in; **Stop** ends it and keeps what arrived. It shows formatted
  (headings, lists, code, LaTeX via KaTeX), with a **Markdown** view of the raw
  text. It can be saved as a PDF (`write_summary_pdf`), copied, or saved as a
  note: `Summary — <topic>` in the current notebook, or a Home note when Brief
  was opened from Home or a standalone note.

Builtin PDF fonts cannot hold every symbol. Greek letters used in formulas are
spelled (`alpha`, `pi`, …) in the PDF. The on-screen reply and the saved note
keep the original characters.
