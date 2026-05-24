; Mantis CLI installer — NSIS script.
;
; Inputs (passed via /D on the makensis command line):
;   /DVERSION=3.6.0
;   /DSRC_DIR=...\dist\release
;   /DOUT_FILE=...\dist\Mantis-CLI-Setup-3.6.0.exe
;
; Produces a Windows installer that drops mantis.exe + sidecar files into
;   %ProgramFiles%\Mantis\
; and prepends that dir to the SYSTEM PATH (machine-wide). Comes with an
; uninstaller registered in Add/Remove Programs.
;
; Requires NSIS 3.x on the build runner. Install with:
;   winget install NSIS.NSIS    or
;   choco install nsis

; Unicode + SetCompressor must come BEFORE any !include or directive that
; emits header data — NSIS 3.0.4.x errors out otherwise ("Can't change
; target charset after data already got compressed or header already
; changed!").
Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!ifndef VERSION
  !define VERSION "0.0.0-dev"
!endif
!ifndef SRC_DIR
  !define SRC_DIR "dist\release"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "Mantis-CLI-Setup-${VERSION}.exe"
!endif

!define APPNAME    "Mantis CLI"
!define COMPANY    "Mantis"
!define REG_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mantis-CLI"

Name "${APPNAME} ${VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\Mantis"
InstallDirRegKey HKLM "Software\Mantis" "InstallDir"
RequestExecutionLevel admin

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Mantis CLI Installer"
VIAddVersionKey "LegalCopyright" "MIT"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "Mantis CLI ${VERSION} has been installed to $INSTDIR and added to PATH.$\n$\nOpen a new terminal and type:$\n    mantis$\n$\nto start the REPL."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ── Path management ──────────────────────────────────────────────────
; NSIS doesn't bundle this in core; the snippet below appends $INSTDIR to
; HKLM PATH (system-wide) and broadcasts WM_SETTINGCHANGE so new shells pick
; it up without a reboot.
Function AddToSystemPath
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Skip if INSTDIR is already in PATH.
  ${WordFind} "$0" "$INSTDIR" "E+1{" $1
  ${If} ${Errors}
    StrCpy $1 ""
  ${EndIf}
  ${If} $1 != ""
    DetailPrint "PATH already contains $INSTDIR — skipping"
    Return
  ${EndIf}
  ; Append, semicolon-separated.
  ${If} $0 == ""
    StrCpy $0 "$INSTDIR"
  ${Else}
    StrCpy $0 "$0;$INSTDIR"
  ${EndIf}
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  DetailPrint "Added $INSTDIR to system PATH"
FunctionEnd

Function un.RemoveFromSystemPath
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${WordFind} "$0" ";$INSTDIR" "E+1{" $1
  ${If} ${Errors}
  ${Else}
    StrCpy $0 $1
  ${EndIf}
  ${WordFind} "$0" "$INSTDIR;" "E+1{" $1
  ${If} ${Errors}
  ${Else}
    StrCpy $0 $1
  ${EndIf}
  ${WordFind} "$0" "$INSTDIR"  "E+1{" $1
  ${If} ${Errors}
  ${Else}
    StrCpy $0 $1
  ${EndIf}
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd

; ── Install ──────────────────────────────────────────────────────────
Section "Install" SecInstall
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Mantis" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Mantis" "Version"    "${VERSION}"

  WriteRegStr HKLM "${REG_UNINST}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKLM "${REG_UNINST}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKLM "${REG_UNINST}" "Publisher"       "${COMPANY}"
  WriteRegStr HKLM "${REG_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REG_UNINST}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "${REG_UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${REG_UNINST}" "EstimatedSize" "$0"

  Call AddToSystemPath
SectionEnd

; ── Uninstall ────────────────────────────────────────────────────────
Section "Uninstall"
  Call un.RemoveFromSystemPath
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Mantis"
  DeleteRegKey HKLM "${REG_UNINST}"
SectionEnd
