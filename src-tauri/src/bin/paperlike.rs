fn main() {
    if let Err(e) = paperlike_app_lib::cli::run() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
