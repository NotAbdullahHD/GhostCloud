const { spawn } = require("child_process");
const path = require("path");

const server = spawn("node", [path.join(__dirname, "api/api.js")], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  cwd: path.join(__dirname, "api"),
});

server.stdout.on("data", (d) => process.stdout.write(d));
server.stderr.on("data", (d) => process.stderr.write(d));
server.on("exit", (code) => console.log("Server exited with code", code));

server.unref();
console.log("API server started, PID:", server.pid);
process.exit(0);
