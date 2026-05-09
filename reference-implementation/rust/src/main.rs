mod handlers;
mod helpers;
mod models;
mod notifications;
mod replay_buffer;
mod state;
mod tick_engine;
mod transport;

const DEFAULT_HTTP_PORT: u16 = 8888;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = match args.get(1).map(String::as_str) {
        None => DEFAULT_HTTP_PORT,
        Some("--http") if args.len() == 2 => DEFAULT_HTTP_PORT,
        Some("--http") if args.len() == 3 => parse_port(&args[2]),
        _ => usage(),
    };

    transport::http::start_http_server(port).await;
}

fn usage() -> ! {
    eprintln!("Usage: apex-reference [--http <port>]");
    std::process::exit(1);
}

fn parse_port(value: &str) -> u16 {
    match value.parse::<u16>() {
        Ok(port) if port > 0 => port,
        _ => usage(),
    }
}
