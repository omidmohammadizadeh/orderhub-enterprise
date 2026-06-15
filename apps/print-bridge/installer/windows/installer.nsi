; OrderHub Print Bridge — Windows installer (NSIS).
;
; Drops the binary in Program Files, registers it as an auto-start
; Windows Service so the bridge runs in the background without the
; operator opening a console, and adds an uninstall entry to Add/Remove
; Programs.
;
; Service runs as LocalSystem so it survives operator logout. Config
; still lives at %USERPROFILE%\.orderhub-print-bridge — we set the
; service to run after the user logs in so $USERPROFILE resolves.
;
; Sign the resulting .exe with signtool against a Windows code-signing
; cert before shipping; without it, Windows SmartScreen warns operators
; the publisher is unverified.

!define PRODUCT_NAME "OrderHub Print Bridge"
!define PRODUCT_PUBLISHER "OrderHub Solutions"
!define PRODUCT_WEB_SITE "https://orderhubsolutions.com"
!define SERVICE_NAME "OrderHubPrintBridge"
!define BIN_NAME "orderhub-print-bridge.exe"

; Version is substituted in by build-installer.ps1 before invoking
; makensis so we keep one source of truth (the bridge package.json).
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0"
!endif

Name "${PRODUCT_NAME}"
OutFile "..\..\..\..\dist\print-bridge\orderhub-print-bridge-windows-x64.exe"
InstallDir "$PROGRAMFILES64\OrderHub Print Bridge"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey ProductName "${PRODUCT_NAME}"
VIAddVersionKey CompanyName "${PRODUCT_PUBLISHER}"
VIAddVersionKey LegalCopyright "© ${PRODUCT_PUBLISHER}"
VIAddVersionKey FileDescription "${PRODUCT_NAME}"
VIAddVersionKey FileVersion "${PRODUCT_VERSION}"

Page directory
Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  ; Built by build-installer.ps1 before makensis runs.
  File "..\..\dist-bin\${BIN_NAME}"

  ; ── Register as a Windows Service ──────────────────────────────
  ; sc.exe creates the service; we use `delayed-auto` so the bridge
  ; waits a few seconds after boot for the network stack + LaunchAgent
  ; equivalents to come up. NSSM would be more robust but adds a
  ; second dependency; sc + a small wrapper keeps the installer
  ; single-file.
  ;
  ; If the service already exists from a previous install, stop and
  ; delete it first so the new binary takes over.
  nsExec::Exec 'sc.exe stop "${SERVICE_NAME}"'
  nsExec::Exec 'sc.exe delete "${SERVICE_NAME}"'
  nsExec::ExecToLog 'sc.exe create "${SERVICE_NAME}" \
    binPath= "\"$INSTDIR\${BIN_NAME}\"" \
    start= delayed-auto \
    DisplayName= "OrderHub Print Bridge"'
  nsExec::ExecToLog 'sc.exe description "${SERVICE_NAME}" \
    "Forwards OrderHub print jobs to the local thermal printer."'
  nsExec::ExecToLog 'sc.exe failure "${SERVICE_NAME}" \
    reset= 0 actions= restart/5000/restart/5000/restart/5000'
  nsExec::ExecToLog 'sc.exe start "${SERVICE_NAME}"'

  ; ── Uninstall entry in Add/Remove Programs ─────────────────────
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'sc.exe stop "${SERVICE_NAME}"'
  nsExec::Exec 'sc.exe delete "${SERVICE_NAME}"'

  Delete "$INSTDIR\${BIN_NAME}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}"
SectionEnd
