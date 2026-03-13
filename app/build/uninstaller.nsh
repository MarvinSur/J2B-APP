; Run after default uninstaller — delete all app data except user output files
!macro customUnInstall
  RMDir /r "$APPDATA\j2b-converter"
!macroend
