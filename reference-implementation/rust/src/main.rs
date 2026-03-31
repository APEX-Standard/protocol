mod handlers;
mod helpers;
mod models;
mod notifications;
mod replay_buffer;
mod server;
mod state;
mod tick_engine;
mod transport;

use rmcp::service::RoleServer;
use rmcp::ServiceExt;

use crate::models::SERVER_VERSION;
use crate::server::ApexServer;

#[tokio::main]
async fn main() {
    // Parse --http <port>
    let args: Vec<String> = std::env::args().collect();
    let http_idx = args.iter().position(|a| a == "--http");

    if let Some(idx) = http_idx {
        let port_str = args
            .get(idx + 1)
            .expect("Usage: apex-reference --http <port>");
        let port: u16 = port_str.parse().expect("Port must be a valid number");
        transport::http::start_http_server(port).await;
        return;
    }

    // Stdio mode
    eprintln!(
        "APEX Protocol Reference Server v{SERVER_VERSION} — waiting for MCP client on stdin..."
    );

    let transport = rmcp::transport::io::stdio();
    let service: rmcp::service::RunningService<RoleServer, ApexServer> =
        match ApexServer::new().serve(transport).await {
            Ok(service) => service,
            Err(error) => {
                eprintln!("Server exiting: {error}");
                eprintln!("Note: This server communicates via MCP (JSON-RPC over stdio).");
                eprintln!(
                    "Connect an MCP client or use: npx @modelcontextprotocol/inspector cargo run"
                );
                std::process::exit(0);
            }
        };

    eprintln!("APEX Protocol Reference Server v{SERVER_VERSION} running");
    if let Err(error) = service.waiting().await {
        eprintln!("Server error: {error}");
    }
}
