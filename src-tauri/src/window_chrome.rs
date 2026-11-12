use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{WebviewWindow, WindowEvent};

// Logical points, matching --titlebar-height in the renderer.
const TITLEBAR_HEIGHT: f64 = 50.0;
const CONTROLS_LEFT: f64 = 14.0;

fn align(window: &WebviewWindow) {
    if window.is_fullscreen().unwrap_or(true) {
        return;
    }
    let owner = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(pointer) = owner.ns_window() else { return };
        if pointer.is_null() { return; }
        // Tauri owns this NSWindow for the lifetime of `owner`. AppKit access
        // stays on its main thread; only the standard controls are repositioned.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let controls = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
            .into_iter().filter_map(|kind| native.standardWindowButton(kind)).collect::<Vec<_>>();
        let Some(close) = controls.first() else { return };
        let titlebar = unsafe { close.superview() };
        let Some(titlebar) = titlebar else { return };
        let container = unsafe { titlebar.superview() };
        let Some(container) = container else { return };
        let first = NSView::frame(close);
        let spacing = controls.get(1).map(|button| NSView::frame(button).origin.x - first.origin.x).unwrap_or(23.0);
        let mut frame = container.frame();
        frame.size.height = TITLEBAR_HEIGHT;
        frame.origin.y = native.frame().size.height - TITLEBAR_HEIGHT;
        container.setFrame(frame);
        let mut titlebar_frame = titlebar.frame();
        titlebar_frame.origin.y = 0.0;
        titlebar_frame.size.height = TITLEBAR_HEIGHT;
        titlebar.setFrame(titlebar_frame);
        for (index, button) in controls.iter().enumerate() {
            let mut rect = NSView::frame(button);
            rect.origin.x = CONTROLS_LEFT + index as f64 * spacing;
            rect.origin.y = (TITLEBAR_HEIGHT - rect.size.height) / 2.0;
            button.setFrameOrigin(rect.origin);
        }
    });
}

fn schedule(window: WebviewWindow, generation: Arc<AtomicU64>) {
    let current = generation.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        // AppKit can reset the controls during layout and again when an animated
        // zoom finishes. Stale resize requests never reposition the controls.
        for delay in [16, 500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            if generation.load(Ordering::Relaxed) != current {
                return;
            }
            align(&window);
        }
    });
}

pub fn install(window: &WebviewWindow) {
    let generation = Arc::new(AtomicU64::new(0));
    schedule(window.clone(), generation.clone());
    let owner = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Focused(true) | WindowEvent::ThemeChanged(_)) {
            schedule(owner.clone(), generation.clone());
        }
    });
}
