!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM VibeSquad.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$APPDATA\npm"
  FileOpen $0 "$APPDATA\npm\vs.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'if exist "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" ($\r$\n'
  FileWrite $0 '  node "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 ') else ($\r$\n'
  FileWrite $0 '  node "$USERPROFILE\.vibesquad\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 ')$\r$\n'
  FileClose $0

  FileOpen $1 "$APPDATA\npm\vs.ps1" w
  FileWrite $1 'if (Test-Path -LiteralPath "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs") {$\r$\n'
  FileWrite $1 '  & node "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '  exit $$LASTEXITCODE$\r$\n'
  FileWrite $1 '} else {$\r$\n'
  FileWrite $1 '  & node "$USERPROFILE\.vibesquad\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '  exit $$LASTEXITCODE$\r$\n'
  FileWrite $1 '}$\r$\n'
  FileClose $1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM VibeSquad.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  IfSilent remove_data 0
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove VibeSquad saved servers, pairing tokens, and WebView2 app data (com.vibesquad.desktop)?" IDYES remove_data IDNO done_data
  remove_data:
    RMDir /r "$LOCALAPPDATA\com.vibesquad.desktop"
    RMDir /r "$APPDATA\com.vibesquad.desktop"
    RMDir /r "$APPDATA\VibeSquad"
  done_data:
!macroend
