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
    miradio_lib::run();
}
