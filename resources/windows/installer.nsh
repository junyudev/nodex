!define NODEX_PROTOCOL_KEY "Software\Classes\nodex"

!macro customCheckAppRunning
  ; Run the incoming helper before an older uninstaller can try to rename busy files.
  ; Both installer and uninstaller extract outside $INSTDIR so they can release it.
  InitPluginsDir
  File /oname=$PLUGINSDIR\nodex-core-maintenance.exe "${PROJECT_DIR}\.generated\codex-runtime\bin\nodex-core.exe"
  File /oname=$PLUGINSDIR\stop-installation.ps1 "${BUILD_RESOURCES_DIR}\windows\stop-installation.ps1"
  StrCpy $R0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  nsExec::ExecToLog /TIMEOUT=45000 '"$R0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installation.ps1" -InstallationDirectory "$INSTDIR" -CoreHelper "$PLUGINSDIR\nodex-core-maintenance.exe" -InstallerPid $1'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "Nodex could not release this installation (exit $R0)."
    SetErrorLevel 2
    Abort "Close Nodex processes from this installation and try again."
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    ; Older uninstallers can use name-wide or prefix-only process checks.
    ; Keep install-over maintenance under the incoming installer's scoped rules.
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      SetOverwrite on
      ClearErrors
      File "/oname=$INSTDIR\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ${If} ${Errors}
        SetErrorLevel 2
        Abort "Nodex could not prepare installation maintenance."
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customInstall
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}" "" "URL:Nodex Deep Link"
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Leave another installation's handler alone if the user has replaced ours.
  ReadRegStr $R0 HKCU "${NODEX_PROTOCOL_KEY}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "${NODEX_PROTOCOL_KEY}"
  ${EndIf}
!macroend
