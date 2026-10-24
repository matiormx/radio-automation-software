use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod ai;
pub mod analysis;
pub mod backup;
pub mod deezer;
pub mod engine;
pub mod rbapi;
pub mod library;
pub mod playlists;
pub mod settings;
pub mod nowplaying;
pub mod notify;
pub mod streaming;
pub mod update;
pub mod video;
pub mod netstream;

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
            fs::create_dir_all(&data_dir)?;
            // Importacion preparada desde Ajustes: se aplica antes de leer nada.
            backup::apply_pending(&data_dir);
            fs::create_dir_all(data_dir.join(library::LEGACY_MUSIC_DIR))?;
            fs::create_dir_all(data_dir.join(playlists::PLAYLISTS_DIR))?;
            app.manage(AppState { data_dir });
            app.manage(streaming::StreamingState::default());
            app.manage(engine::EngineState::default());
            app.manage(rbapi::ApiState::default());
            app.manage(notify::NotifyState::default());
            Ok(())
        })
        // Las ventanas de herramientas se ocultan al cerrarse: al cerrar la
        // principal la aplicacion termina del todo.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai::ai_models,
            ai::ai_suggest_metadata,
            library::import_files,
            deezer::deezer_search,
            deezer::deezer_track,
            library::list_tracks,
            library::scan_music_folder,
            library::update_track,
            library::set_track_cover,
            library::clear_track_cover,
            library::track_details,
            library::backfill_covers,
            library::backfill_quality,
            library::scan_folder,
            library::relink_track,
            library::delete_track,
            library::list_blocks,
            library::create_block,
            library::rename_block,
            library::delete_block,
            library::set_track_blocks,
            library::move_tracks_block,
            library::set_tracks_language,
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
            streaming::ndi_probe,
            streaming::stream_status,
            streaming::stream_start,
            streaming::stream_stop,
            streaming::stream_push_pcm,
            engine::engine_start,
            engine::engine_stop,
            engine::engine_cmd,
            engine::engine_devices,
            engine::engine_inputs,
            engine::engine_feed,
            engine::engine_return_pcm,
            rbapi::api_publish,
            notify::notify_fire,
            video::convert_videos,
            video::audio_fallback,
            netstream::netstream_url,
            backup::backup_export,
            backup::backup_inspect,
            backup::backup_import,
            backup::backup_last_import_log,
            notify::notify_test,
            rbapi::api_apply,
            rbapi::api_status,
            rbapi::api_set_login,
            rbapi::api_new_token,
            rbapi::api_set_update_token,
            update::app_version,
            update::open_url,
            nowplaying::write_now_playing,
            nowplaying::write_now_playing_image
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar MiRadio");
}
