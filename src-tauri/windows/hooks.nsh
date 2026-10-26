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
