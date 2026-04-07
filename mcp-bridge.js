import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
async function run() {
    const apiKey = process.env.AUTHORIZATION || "Bearer gm_048f3dc053ed20a897227268d347db1d18078fc63625838baf03834f7e56e973";
    const mcpUrl = "http://localhost:3000/mcp";
    // Connect to our express Stateless HTTP Endpoint
    const httpTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: {
            headers: { Authorization: apiKey }
        }
    });
    // Stdio transport for Claude Desktop to communicate with this script
    const stdioTransport = new StdioServerTransport();
    // Route messages between Claude (stdio) and our HTTP Server
    httpTransport.onmessage = (message) => {
        stdioTransport.send(message).catch(console.error);
    };
    stdioTransport.onmessage = (message) => {
        httpTransport.send(message).catch(console.error);
    };
    httpTransport.onerror = (err) => {
        console.error("HTTP Transport Error:", err);
    };
    stdioTransport.onerror = (err) => {
        console.error("Stdio Error:", err);
    };
    // Handle exits
    process.on("SIGINT", () => {
        httpTransport.close();
        stdioTransport.close();
        process.exit(0);
    });
    await httpTransport.start();
    await stdioTransport.start();
}
run().catch(error => {
    console.error("Bridge Error:", error);
    process.exit(1);
});
