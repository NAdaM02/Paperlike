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

; After install: move CLI binary to $INSTDIR and add $INSTDIR to the user PATH.
!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2

  ; paperlike.exe is bundled as a resource; move it beside Paperlike.exe.
  CopyFiles /SILENT "$INSTDIR\resources\paperlike.exe" "$INSTDIR\paperlike.exe"

  ; Write a small PowerShell script that appends $INSTDIR to HKCU PATH when absent.
  GetTempFileName $R0
  StrCpy $R1 "$R0.ps1"
  FileOpen $R2 $R1 w
  FileWrite $R2 "$$p = '$INSTDIR'$\n"
  FileWrite $R2 '$$cur = [Environment]::GetEnvironmentVariable("PATH","User")$\n'
  FileWrite $R2 'if (($cur -split ";") -notcontains $$p) {$\n'
  FileWrite $R2 '  $$new = if ($$cur) { $$cur + ";" + $$p } else { $$p }$\n'
  FileWrite $R2 '  [Environment]::SetEnvironmentVariable("PATH", $$new, "User")$\n'
  FileWrite $R2 '}$\n'
  FileClose $R2
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$R1"'
  Delete $R1
  Delete $R0

  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; Before uninstall: remove $INSTDIR from the user PATH and delete the CLI binary.
!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  Push $R1
  Push $R2

  Delete "$INSTDIR\paperlike.exe"

  ; Write a PowerShell script that strips $INSTDIR from HKCU PATH.
  GetTempFileName $R0
  StrCpy $R1 "$R0.ps1"
  FileOpen $R2 $R1 w
  FileWrite $R2 "$$p = '$INSTDIR'$\n"
  FileWrite $R2 '$$cur = [Environment]::GetEnvironmentVariable("PATH","User")$\n'
  FileWrite $R2 '$$parts = ($cur -split ";") | Where-Object { $$_ -ne $$p }$\n'
  FileWrite $R2 '[Environment]::SetEnvironmentVariable("PATH", ($$parts -join ";"), "User")$\n'
  FileClose $R2
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$R1"'
  Delete $R1
  Delete $R0

  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Pop $R2
  Pop $R1
  Pop $R0
!macroend
