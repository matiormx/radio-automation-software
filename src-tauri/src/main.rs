#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 deja de pintar las ventanas que cree tapadas o fuera de la
    // pantalla: la ventana «Lo que suena» (aparcada fuera de la vista y
    // capturada por FFmpeg) se quedaba en el ultimo fotograma del video al
    // pasar a una cancion de solo audio. Se desactiva para todas las ventanas
    // (todas deben compartir los mismos argumentos). Incluye los de Tauri.
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
             --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
             --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required",
        );
    }
    // Linux: tema GTK oscuro para lo que pinta el sistema (la lista que se
    // abre en los desplegables, dialogos), a juego con la app.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GTK_THEME").is_none() {
        std::env::set_var("GTK_THEME", "Adwaita:dark");
    }
    miradio_lib::run();
}
