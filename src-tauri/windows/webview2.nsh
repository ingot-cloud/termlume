!include LogicLib.nsh

; EdgeUpdate uses the 32-bit machine registry view, plus a per-user fallback.
!macro TermlumeReadWebView2Version OUT KEY
  SetRegView 32
  ReadRegStr ${OUT} HKLM "${KEY}" "pv"
  ${If} ${OUT} == ""
  ${OrIf} ${OUT} == "0.0.0.0"
    ReadRegStr ${OUT} HKCU "${KEY}" "pv"
  ${EndIf}
  SetRegView lastused
!macroend

; Parameters let native smoke tests use their own registry key and stub installer.
; The production hook supplies only the pinned binary and Microsoft's runtime key.
!macro TermlumeEnsureWebView2 INSTALLER KEY
  Push $R8
  Push $R9
  !insertmacro TermlumeReadWebView2Version $R9 "${KEY}"
  ${If} $R9 == ""
  ${OrIf} $R9 == "0.0.0.0"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${INSTALLER}"
    DetailPrint "Installing bundled WebView2 runtime (offline)"
    ClearErrors
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" /silent /install' $R8
    ${If} ${Errors}
      Delete "$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe"
      SetErrorLevel 1
      Abort "Could not run the bundled WebView2 installer."
    ${EndIf}
    Delete "$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe"
    ${If} $R8 == 3010
      SetRebootFlag true
    ${ElseIf} $R8 != 0
      SetErrorLevel 1
      Abort "WebView2 offline installation failed (exit code $R8)."
    ${EndIf}
    !insertmacro TermlumeReadWebView2Version $R9 "${KEY}"
    ${If} $R9 == ""
    ${OrIf} $R9 == "0.0.0.0"
      SetErrorLevel 1
      Abort "The bundled installer did not register a WebView2 runtime."
    ${EndIf}
  ${Else}
    DetailPrint "Reusing installed WebView2 runtime $R9"
  ${EndIf}
  ClearErrors
  Pop $R9
  Pop $R8
!macroend
