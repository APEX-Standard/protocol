mod helpers;
mod models;
mod server;

use rmcp::ServiceExt;

use crate::models::SERVER_VERSION;
use crate::server::ApexServer;

#[tokio::main]
async fn main() {
    eprintln!(
        "APEX Protocol Reference Server v{SERVER_VERSION} — waiting for MCP client on stdin..."
    );

    let transport = rmcp::transport::io::stdio();
    let service = match ApexServer.serve(transport).await {
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
