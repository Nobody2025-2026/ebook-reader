// 桌面版入口：把已有的前端（Vite + React）套进原生 WebView 窗口。
// 前端逻辑完全复用网页版，无需改动；这里只负责启动原生窗口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
