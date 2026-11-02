!define NODEX_PROTOCOL_KEY "Software\Classes\nodex"

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
