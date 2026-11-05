!define NODEX_PROTOCOL_KEY "Software\Classes\nodex"
!define NODEX_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define NODEX_STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define NODEX_MAINTENANCE_LOG "$LOCALAPPDATA\Nodex\installer-maintenance.log"

!macro nodexMaintenanceLog message
  Push $8
  Push $R9
  System::Call 'kernel32::GetTickCount() i .r8'
  FileOpen $R9 "${NODEX_MAINTENANCE_LOG}" a
  ; NSIS preserves contents in append mode but still opens at byte zero.
  FileSeek $R9 0 END
  FileWrite $R9 "${message} uptimeMs=$8$\r$\n"
  FileClose $R9
  Pop $R9
  Pop $8
!macroend

!macro customCheckAppRunning
  ; Run the incoming maintenance before an older uninstaller can try to rename busy files.
  ; Both installer and uninstaller extract outside $INSTDIR so they can release it.
  InitPluginsDir
  ; Maintenance must not inherit an installation-directory handle through its cwd.
  SetOutPath "$TEMP"
  CreateDirectory "$LOCALAPPDATA\Nodex"
  !ifdef BUILD_UNINSTALLER
    ; Install-over's nested uninstaller must retain the incoming shutdown evidence.
    ${IfNot} ${isUpdated}
      Delete "${NODEX_MAINTENANCE_LOG}"
    ${EndIf}
    !insertmacro nodexMaintenanceLog "operation=uninstall"
  !else
    Delete "${NODEX_MAINTENANCE_LOG}"
    !insertmacro nodexMaintenanceLog "operation=install"
  !endif
  !insertmacro nodexMaintenanceLog "step=process-shutdown started"
  File /oname=$PLUGINSDIR\nodex-maintenance.exe "${PROJECT_DIR}\.generated\codex-runtime\maintenance\nodex-maintenance.exe"
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  ; The helper bounds confirmed shutdown itself. Startup and client preparation
  ; must not consume an inactivity timeout before shutdown can even begin.
  nsExec::ExecToLog '"$PLUGINSDIR\nodex-maintenance.exe" --installation-directory "$INSTDIR" --helper-directory "$PLUGINSDIR" --installer-pid $1 --log-path "${NODEX_MAINTENANCE_LOG}"'
  Pop $R0
  ${If} $R0 != 0
    !insertmacro nodexMaintenanceLog "step=process-shutdown failed exit=$R0"
    DetailPrint "Nodex could not release this installation (exit $R0)."
    SetErrorLevel 2
    Abort "Close Nodex processes from this installation and try again."
  ${EndIf}
  !insertmacro nodexMaintenanceLog "step=process-shutdown completed"
  !ifndef BUILD_UNINSTALLER
    ; Older uninstallers can use name-wide or prefix-only process checks.
    ; Keep install-over maintenance under the incoming installer's scoped rules.
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      SetOverwrite on
      ClearErrors
      File "/oname=$INSTDIR\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ${If} ${Errors}
        !insertmacro nodexMaintenanceLog "step=refresh-uninstaller failed"
        SetErrorLevel 2
        Abort "Nodex could not prepare installation maintenance."
      ${EndIf}
      !insertmacro nodexMaintenanceLog "step=refresh-uninstaller completed"
    ${EndIf}
  !endif
!macroend

!macro customUnInstallCheck
  ; Preserve the nested uninstaller's result before installer result handling exits.
  ${If} ${Errors}
    !insertmacro nodexMaintenanceLog "step=remove-previous-installation failed launch"
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
    SetErrors
  ${ElseIf} $R0 != 0
    !insertmacro nodexMaintenanceLog "step=remove-previous-installation failed exit=$R0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${Else}
    !insertmacro nodexMaintenanceLog "step=remove-previous-installation completed"
  ${EndIf}
!macroend

!macro customInstall
  ; Windows owns startup approval. Never reset a user's disabled state on upgrade.
  ReadRegStr $R0 HKCU "${NODEX_RUN_KEY}" "Nodex"
  ${If} $R0 == ""
    WriteRegStr HKCU "${NODEX_RUN_KEY}" "Nodex" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --startup'
  ${EndIf}
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}" "" "URL:Nodex Deep Link"
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "${NODEX_PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    ; This installer never elevates. Launch directly so NODEX_HOME and the
    ; selected Profile survive instead of borrowing Explorer's environment.
    HideWindow
    ; Detached descendants must not retain $INSTDIR as their working directory.
    SetOutPath "$PROFILE"
    ClearErrors
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
    ${If} ${Errors}
      !insertmacro nodexMaintenanceLog "step=relaunch failed"
      SetErrorLevel 2
      Abort "Nodex was updated but could not restart. Open Nodex to continue."
    ${EndIf}
    !insertmacro nodexMaintenanceLog "step=relaunch completed"
    ; Skip electron-builder's ShellExecuteAsUser relaunch: one update, one host.
    !insertmacro quitSuccess
  ${EndIf}
!macroend

!macro customUnInstall
  ; Install-over preserves both registration and Windows' approval decision.
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 HKCU "${NODEX_RUN_KEY}" "Nodex"
    ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --startup'
      DeleteRegValue HKCU "${NODEX_RUN_KEY}" "Nodex"
      DeleteRegValue HKCU "${NODEX_STARTUP_APPROVED_KEY}" "Nodex"
    ${EndIf}
  ${EndIf}
  ; Leave another installation's handler alone if the user has replaced ours.
  ReadRegStr $R0 HKCU "${NODEX_PROTOCOL_KEY}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "${NODEX_PROTOCOL_KEY}"
  ${EndIf}
!macroend
