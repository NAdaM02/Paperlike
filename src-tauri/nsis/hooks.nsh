; Shown on the installer's welcome page. currentUser installs do not offer an
; all-users choice, because that choice asks for administrator every time.
!define MUI_WELCOMEPAGE_TITLE "Install Paperlike"
!define MUI_WELCOMEPAGE_TEXT "Recommended for most users.$\r$\n$\r$\nPaperlike installs for your account, without an administrator prompt. Later updates install the same way.$\r$\n$\r$\nClick Next to continue."

; A close-time update does not pass /R. Hide the setup window and leave Paperlike closed.
; A manual update passes /R, so .onInstSuccess starts the app and this stays out of the way.
; Quiet mode already passes /S, so the language page and the progress UI never open.
; SetSilent only works in .onInit; calling it from this section can stop the copy.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    Push $R0
    ClearErrors
    ${GetOptions} $CMDLINE "/R" $R0
    ${If} ${Errors}
      HideWindow
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend
