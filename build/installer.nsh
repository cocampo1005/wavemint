; Custom NSIS hooks for WaveMint's assisted installer (electron-builder).
;
; electron-builder's assisted installer has no option for an *optional*
; desktop shortcut, so the finish page gets a "Create a desktop shortcut"
; checkbox next to "Run WaveMint". The uninstaller removes that shortcut
; itself because createDesktopShortcut is false in electron-builder.yml.

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function CreateDesktopShortcut
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Run WaveMint"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInstall
  ; Keep these during in-place updates; remove them on a real uninstall.
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

    ; The installer keeps a copy of itself in %LOCALAPPDATA%\wavemint-updater
    ; for future differential updates; electron-builder never removes it.
    !ifdef APP_INSTALLER_STORE_FILE
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R9
      RMDir "$R9"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    !endif
  ${endIf}
!macroend
