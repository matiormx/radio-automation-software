//! Cache de pistas decodificadas con decodificacion en segundo plano.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use super::pcm::{decode_file, Pcm};
use super::player::{Load, Loader, TrackInfo};

/// PCM que se conservan en memoria (una cancion son ~90 MB en f32).
const CACHE_LIMIT: usize = 4;
/// Decodificaciones a la vez.
const MAX_JOBS: usize = 2;

enum Slot {
    Pending,
    Ready(Arc<Pcm>),
    Failed(String),
}

pub struct DecodeCache {
    rate: u32,
    map: HashMap<String, Slot>,
    /// Orden de llegada de las listas (para descartar las mas antiguas)
    order: VecDeque<String>,
    queue: VecDeque<(String, String)>,
    jobs: usize,
    keep: Vec<String>,
    tx: Sender<(String, Result<Arc<Pcm>, String>)>,
    rx: Receiver<(String, Result<Arc<Pcm>, String>)>,
}

impl DecodeCache {
    pub fn new(rate: u32) -> Self {
        let (tx, rx) = mpsc::channel();
        DecodeCache {
            rate,
            map: HashMap::new(),
            order: VecDeque::new(),
            queue: VecDeque::new(),
            jobs: 0,
            keep: Vec::new(),
            tx,
            rx,
        }
    }

    fn collect(&mut self) {
        while let Ok((id, res)) = self.rx.try_recv() {
            self.jobs = self.jobs.saturating_sub(1);
            match res {
                Ok(pcm) => {
                    self.map.insert(id.clone(), Slot::Ready(pcm));
                    self.order.retain(|x| *x != id);
                    self.order.push_back(id);
                }
                Err(e) => {
                    self.map.insert(id, Slot::Failed(e));
                }
            }
        }
        self.evict();
        self.spawn();
    }

    fn evict(&mut self) {
        let mut ready = self.order.len();
        let mut i = 0;
        while ready > CACHE_LIMIT && i < self.order.len() {
            if self.keep.contains(&self.order[i]) {
                i += 1;
                continue;
            }
            if let Some(id) = self.order.remove(i) {
                self.map.remove(&id);
            }
            ready -= 1;
        }
    }

    fn spawn(&mut self) {
        while self.jobs < MAX_JOBS {
            let Some((id, file)) = self.queue.pop_front() else { break };
            self.jobs += 1;
            let tx = self.tx.clone();
            let rate = self.rate;
            let spawned = std::thread::Builder::new()
                .name("miradio-decode".into())
                .spawn(move || {
                    let path = Path::new(&file);
                    let res = if file.trim().is_empty() || !path.is_file() {
                        Err("el archivo no está disponible".to_string())
                    } else {
                        decode_file(path, rate)
                    };
                    let _ = tx.send((id, res));
                });
            if spawned.is_err() {
                self.jobs -= 1;
                break;
            }
        }
    }
}

impl Loader for DecodeCache {
    fn get(&mut self, t: &TrackInfo) -> Load {
        self.collect();
        match self.map.get(&t.id) {
            Some(Slot::Ready(p)) => Load::Ready(p.clone()),
            Some(Slot::Pending) => Load::Pending,
            Some(Slot::Failed(_)) => {
                // Se informa una vez; el siguiente intento vuelve a decodificar.
                if let Some(Slot::Failed(e)) = self.map.remove(&t.id) {
                    Load::Failed(e)
                } else {
                    Load::Pending
                }
            }
            None => {
                self.map.insert(t.id.clone(), Slot::Pending);
                self.queue.push_back((t.id.clone(), t.file.clone()));
                self.spawn();
                Load::Pending
            }
        }
    }

    fn keep(&mut self, ids: &[&str]) {
        if self.keep.len() == ids.len() && self.keep.iter().zip(ids).all(|(a, b)| a == b) {
            return;
        }
        self.keep = ids.iter().map(|s| s.to_string()).collect();
        self.evict();
    }
}
