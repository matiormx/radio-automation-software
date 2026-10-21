use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod analysis;
pub mod deezer;
pub mod library;
pub mod playlists;
pub mod settings;
pub mod nowplaying;
pub mod streaming;
pub mod update;

pub struct AppState {
    pub data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // El actualizador oficial solo existe en escritorio.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(data_dir.join(library::LEGACY_MUSIC_DIR))?;
            fs::create_dir_all(data_dir.join(playlists::PLAYLISTS_DIR))?;
            app.manage(AppState { data_dir });
            app.manage(streaming::StreamingState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::import_files,
            deezer::deezer_search,
            deezer::deezer_track,
            library::list_tracks,
            library::scan_music_folder,
            library::update_track,
            library::track_details,
            library::backfill_covers,
            library::relink_track,
            library::delete_track,
            library::list_blocks,
            library::create_block,
            library::rename_block,
            library::delete_block,
            library::set_track_blocks,
            library::import_playlist,
            library::set_track_library,
            library::save_track_trim,
            library::save_track_markers,
            library::auto_track_trim,
            analysis::analyze_track,
            analysis::track_waveform,
            playlists::list_playlists,
            playlists::save_playlist,
            playlists::delete_playlist,
            settings::get_settings,
            settings::save_settings,
            settings::set_branding_logo,
            settings::import_program_cover,
            settings::delete_program_cover,
            settings::report_started,
            settings::list_history,
            settings::save_session,
            settings::load_session,
            settings::auto_pick,
            streaming::stream_probe,
            streaming::stream_status,
            streaming::stream_start,
            streaming::stream_stop,
            streaming::stream_push_pcm,
            update::app_version,
            update::open_url,
            nowplaying::write_now_playing,
            nowplaying::write_now_playing_image
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar MiRadio");
}
