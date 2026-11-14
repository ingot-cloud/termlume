#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void, CStr};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn termlume_terminal_fonts(
        context: *mut c_void,
        emit: extern "C" fn(*mut c_void, *const c_char),
    );
}

pub fn families() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" fn collect(context: *mut c_void, name: *const c_char) {
            // The bridge calls synchronously with a temporary NUL-terminated name.
            if let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() {
                if let Ok(name) = crate::store::checked(name, "字体", 240) {
                    unsafe { &mut *context.cast::<Vec<String>>() }.push(name);
                }
            }
        }

        let mut names: Vec<String> = Vec::new();
        unsafe { termlume_terminal_fonts((&mut names as *mut Vec<String>).cast(), collect) };
        names.sort_unstable();
        names.dedup();
        names
    }
    #[cfg(windows)]
    return crate::platform::windows::font_families();
    #[cfg(not(any(target_os = "macos", windows)))]
    Vec::new()
}
