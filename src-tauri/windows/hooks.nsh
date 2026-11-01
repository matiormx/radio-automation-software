; OmniCaster se llamaba MiRadio. El instalador de Windows registra cada
; programa por su nombre, asi que la version nueva se instala aparte: al
; terminar se quita la instalacion antigua «MiRadio» (sus accesos directos y
; su programa). Los datos (biblioteca, ajustes, listas) son los mismos y NO
; se tocan: estan en la carpeta de datos com.miradio.app, que no cambia.

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R9 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiRadio" "UninstallString"
  ${If} $R9 != ""
    DetailPrint "Quitando la instalación anterior (MiRadio)…"
    ; /S: sin preguntas; sin marcar «borrar datos», asi que los datos se quedan.
    ExecWait '$R9 /S'
  ${EndIf}
!macroend

; Al actualizar, OmniCaster se cierra solo justo después de lanzar este
; instalador, pero Windows puede tardar en liberar el proceso (drivers de
; audio, plugins VST…). Si el instalador intenta cerrarlo mientras aún se
; está cerrando, falla con «Failed to kill OmniCaster». Aquí se espera a que
; desaparezca (hasta 90 s) y, si sigue, se fuerza su cierre.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    DetailPrint "Esperando a que OmniCaster termine de cerrarse…"
    StrCpy $R8 0
    omni_wait_loop:
      nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
      Pop $R7
      ${If} $R7 != 0
        Goto omni_wait_done
      ${EndIf}
      IntOp $R8 $R8 + 1
      ${If} $R8 = 60
        DetailPrint "Forzando el cierre de OmniCaster…"
        nsExec::Exec 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
        Pop $R7
      ${EndIf}
      ${If} $R8 < 90
        Sleep 1000
        Goto omni_wait_loop
      ${EndIf}
    omni_wait_done:
  ${EndIf}
!macroend
