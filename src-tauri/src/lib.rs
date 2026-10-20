use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod library;
pub mod playlists;

pub struct AppState {
    pub data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(data_dir.join(library::MUSIC_DIR))?;
            fs::create_dir_all(data_dir.join(playlists::PLAYLISTS_DIR))?;
            app.manage(AppState { data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::import_files,
            library::list_tracks,
            library::delete_track,
            playlists::list_playlists,
            playlists::save_playlist,
            playlists::delete_playlist
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar MiRadio");
}
