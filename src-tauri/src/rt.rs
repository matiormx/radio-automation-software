//! Prioridad de los hilos del sonido.
//!
//! El hilo de audio de la tarjeta ya va en prioridad máxima, pero comparte
//! candado con el hilo de control del motor (y recibe de otros hilos). Si
//! esos van en prioridad normal y el equipo está ocupado (la interfaz, el
//! vídeo…), Windows los aparta justo cuando tienen el candado, el audio se
//! queda esperando y se oye un corte. Por eso los hilos del motor suben a
//! prioridad alta y OmniCaster entero (no la interfaz web, que va en sus
//! propios procesos) a «por encima de lo normal».

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThread() -> isize;
        pub fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        pub fn GetCurrentProcess() -> isize;
        pub fn SetPriorityClass(process: isize, class: u32) -> i32;
    }
    #[link(name = "winmm")]
    extern "system" {
        pub fn timeBeginPeriod(ms: u32) -> u32;
    }
    pub const THREAD_PRIORITY_HIGHEST: i32 = 2;
    pub const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;
}

/// Sube la prioridad del hilo actual (hilos del motor de sonido).
pub fn boost_thread() {
    #[cfg(windows)]
    unsafe {
        win::SetThreadPriority(win::GetCurrentThread(), win::THREAD_PRIORITY_HIGHEST);
    }
}

/// Una vez al arrancar: OmniCaster por encima de lo normal y temporizador
/// de 1 ms (las esperas de 15–20 ms del motor no se alargan a 31 ms).
pub fn boost_process() {
    #[cfg(windows)]
    unsafe {
        win::SetPriorityClass(win::GetCurrentProcess(), win::ABOVE_NORMAL_PRIORITY_CLASS);
        win::timeBeginPeriod(1);
    }
}
