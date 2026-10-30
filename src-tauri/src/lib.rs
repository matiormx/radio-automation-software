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
mod sysmon;
mod netcfg;
mod hwenc;
mod crashlog;
mod rt;
mod remote;
mod mobile;
pub mod nowplaying;
pub mod notify;
pub mod streaming;
pub mod update;
pub mod video;
pub mod netstream;
pub mod ndi;
pub mod cursor;
#[cfg(target_os = "linux")]
pub mod x11util;
pub mod ffmpeg_dl;
pub mod media;
pub mod explorer;
pub mod vstpkg;
pub mod monitor;

pub struct AppState {
    pub data_dir: PathBuf,
}

/// Cierra OmniCaster de verdad (la X solo minimiza). La confirmacion la pide la
/// ventana principal antes de llamar aqui.
/// Se llama justo antes de instalar una actualización (ver update.ts).
#[tauri::command]
async fn prepare_for_update(app: tauri::AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        cursor::release();
        remote::shutdown();
        if let Some(st) = app.try_state::<streaming::StreamingState>() {
            streaming::shutdown(&st);
        }
        if let Some(st) = app.try_state::<engine::EngineState>() {
            engine::shutdown_for_update(&st);
        }
    })
    .await;
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Reiniciar o apagar el equipo (Linux, modo quiosco). El usuario de la
/// sesion local activa puede hacerlo sin contraseña (logind/polkit).
#[tauri::command]
fn system_power(action: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let verb = match action.as_str() {
            "reboot" => "reboot",
            "poweroff" => "poweroff",
            _ => return Err("acción desconocida".into()),
        };
        for cmd in ["systemctl", "loginctl"] {
            if let Ok(st) = std::process::Command::new(cmd).arg(verb).status() {
                if st.success() {
                    return Ok(());
                }
            }
        }
        Err("El sistema no ha permitido reiniciar o apagar desde OmniCaster".into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = action;
        Err("Solo en Linux".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Primero de todo: si ya hay un OmniCaster abierto, se trae al frente y
    // este segundo arranque termina sin abrir nada.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        // .m4v (y similares) servidos como MP4: el protocolo normal les pone
        // un tipo que el WebView no reproduce.
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(media::handle(&request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // El actualizador oficial solo existe en escritorio.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            // Registro de errores internos y aviso si la vez anterior se cerró mal
            crashlog::init(data_dir.clone());
            // El sonido por delante de todo lo demás del equipo
            rt::boost_process();
            // Importacion preparada desde Ajustes: se aplica antes de leer nada.
            backup::apply_pending(&data_dir);
            fs::create_dir_all(data_dir.join(library::LEGACY_MUSIC_DIR))?;
            fs::create_dir_all(data_dir.join(playlists::PLAYLISTS_DIR))?;
            // Plugins actualizados que estaban en uso: se colocan antes de cargar la mesa.
            vstpkg::apply_pending(&data_dir);
            // Linux: si VNC estaba activado, se enciende otra vez.
            remote::on_startup(&settings::read_settings_public(&data_dir));
            app.manage(AppState { data_dir });
            app.manage(streaming::StreamingState::default());
            // Prueba en segundo plano qué compresor de vídeo por hardware hay
            hwenc::warm_up(app.handle());
            app.manage(sysmon::SysMon::default());
            app.manage(mobile::MobileState::default());
            app.manage(engine::EngineState::default());
            app.manage(rbapi::ApiState::default());
            app.manage(notify::NotifyState::default());
            // FFmpeg: si falta se descarga solo; si es el de OmniCaster, se mantiene al dia.
            ffmpeg_dl::on_startup(app.handle().clone());
            vstpkg::on_startup(app.handle().clone());
            Ok(())
        })
        // Las ventanas de herramientas se ocultan al cerrarse: al cerrar la
        // principal la aplicacion termina del todo.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    // La X (y Alt+F4, o cerrar desde la barra de tareas) no
                    // cierra la emisora: la manda a la barra de tareas. Para
                    // cerrar de verdad: Ajustes › Copia y actualizaciones.
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        // En el quiosco Linux no hay barra de tareas: una
                        // ventana minimizada se perdería. Se queda donde está.
                        if !cfg!(target_os = "linux") {
                            let _ = window.minimize();
                        }
                    }
                    tauri::WindowEvent::Destroyed => window.app_handle().exit(0),
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            system_power,
            sysmon::sys_stats,
            remote::remote_status,
            mobile::mobile_apply,
            mobile::mobile_status,
            mobile::mobile_publish,
            remote::remote_vnc,
            remote::remote_wg,
            remote::remote_smb,
            ai::ai_models,
            ai::ai_suggest_metadata,
            ai::ai_opencode_version,
            library::import_files,
            deezer::deezer_search,
            deezer::deezer_track,
            deezer::artist_image,
            library::list_tracks,
            library::scan_music_folder,
            library::update_track,
            library::set_track_cover,
            library::clear_track_cover,
            library::track_details,
            library::backfill_covers,
            library::backfill_quality,
            library::scan_folder,
            library::import_files_dedup,
            ndi::ndi_native,
            ndi::ndi_server,
            ndi::np_frame,
            cursor::cursor_wall,
            app_quit,
            ffmpeg_dl::ffmpeg_info,
            explorer::fs_list,
            vstpkg::vstpkg_list,
            vstpkg::vstpkg_install,
            vstpkg::vstpkg_check,
            vstpkg::vstpkg_remove,
            explorer::fs_places,
            explorer::picker_roots,
            explorer::picker_list,
            explorer::picker_mkdir,
            netcfg::net_status,
            netcfg::net_apply,
            netcfg::net_confirm,
            netcfg::net_revert,
            netcfg::net_share_add,
            netcfg::net_share_remove,
            hwenc::video_encoders,
            crashlog::last_crash,
            prepare_for_update,
            ffmpeg_dl::ffmpeg_update,
            monitor::monitor_server,
            monitor::monitor_thumbnail,
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
            streaming::stream_monitor_sync,
            engine::engine_start,
            engine::engine_stop,
            engine::engine_cmd,
            engine::engine_devices,
            engine::engine_inputs,
            engine::engine_feed,
            engine::vst_scan,
            engine::vst_editor,
            engine::vst_copy_state,
            engine::vst_latencies,
            engine::engine_return_pcm,
            rbapi::api_publish,
            notify::notify_fire,
            video::convert_videos,
            video::audio_fallback,
            video::video_capture_devices,
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
            update::update_log,
            update::update_trace_last,
            nowplaying::write_now_playing,
            nowplaying::write_now_playing_image
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar OmniCaster")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                cursor::release();
                remote::shutdown();
                if let Some(st) = _app.try_state::<streaming::StreamingState>() {
                    streaming::shutdown(&st);
                }
            }
        });
}
