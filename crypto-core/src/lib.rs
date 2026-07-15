pub mod client;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use client::{AddResult, ChatClient, CoreError, Event};
