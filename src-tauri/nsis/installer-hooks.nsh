; Stops VibeSquad.exe plus the node.exe processes it owns (the bundled server from $INSTDIR\runtime and the
; managed Paseo daemon under %LOCALAPPDATA%\com.vibesquad.desktop) so files can be replaced/removed.
!macro VS_STOP_PROCESSES
  nsExec::ExecToLog 'taskkill /F /IM VibeSquad.exe'
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq $\'node.exe$\' -and (($$_.ExecutablePath -like $\'$INSTDIR\runtime\*$\') -or ($$_.CommandLine -like $\'*com.vibesquad.desktop*$\')) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro VS_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; `vs` works without a system Node: prefer the bundled node.exe, then fall back to PATH node.
  CreateDirectory "$APPDATA\npm"
  FileOpen $0 "$APPDATA\npm\vs.cmd" w
  FileWrite $0 "@chcp 65001 >nul 2>nul$\r$\n"
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'if exist "$INSTDIR\runtime\node.exe" if exist "$INSTDIR\runtime\cli\vs.mjs" ($\r$\n'
  FileWrite $0 '  "$INSTDIR\runtime\node.exe" "$INSTDIR\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 '  exit /b %ERRORLEVEL%$\r$\n'
  FileWrite $0 ')$\r$\n'
  FileWrite $0 'if exist "$LOCALAPPDATA\com.vibesquad.desktop\runtime\node.exe" if exist "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" ($\r$\n'
  FileWrite $0 '  "$LOCALAPPDATA\com.vibesquad.desktop\runtime\node.exe" "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 '  exit /b %ERRORLEVEL%$\r$\n'
  FileWrite $0 ')$\r$\n'
  FileWrite $0 'if exist "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" ($\r$\n'
  FileWrite $0 '  node "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 ') else ($\r$\n'
  FileWrite $0 '  node "$USERPROFILE\.vibesquad\runtime\cli\vs.mjs" %*$\r$\n'
  FileWrite $0 ')$\r$\n'
  FileClose $0

  FileOpen $1 "$APPDATA\npm\vs.ps1" w
  FileWrite $1 '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8$\r$\n'
  FileWrite $1 '$$OutputEncoding = [System.Text.Encoding]::UTF8$\r$\n'
  FileWrite $1 'if ((Test-Path -LiteralPath "$INSTDIR\runtime\node.exe") -and (Test-Path -LiteralPath "$INSTDIR\runtime\cli\vs.mjs")) {$\r$\n'
  FileWrite $1 '  & "$INSTDIR\runtime\node.exe" "$INSTDIR\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '  exit $$LASTEXITCODE$\r$\n'
  FileWrite $1 '}$\r$\n'
  FileWrite $1 'if ((Test-Path -LiteralPath "$LOCALAPPDATA\com.vibesquad.desktop\runtime\node.exe") -and (Test-Path -LiteralPath "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs")) {$\r$\n'
  FileWrite $1 '  & "$LOCALAPPDATA\com.vibesquad.desktop\runtime\node.exe" "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '  exit $$LASTEXITCODE$\r$\n'
  FileWrite $1 '}$\r$\n'
  FileWrite $1 'if (Test-Path -LiteralPath "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs") {$\r$\n'
  FileWrite $1 '  & node "$LOCALAPPDATA\com.vibesquad.desktop\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '} else {$\r$\n'
  FileWrite $1 '  & node "$USERPROFILE\.vibesquad\runtime\cli\vs.mjs" @args$\r$\n'
  FileWrite $1 '}$\r$\n'
  FileWrite $1 'exit $$LASTEXITCODE$\r$\n'
  FileClose $1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro VS_STOP_PROCESSES
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
