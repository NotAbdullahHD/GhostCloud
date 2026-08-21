const { spawn } = require("child_process");
const path = require("path");

const server = spawn("node", [path.join(__dirname, "api/api.js")], {
  detached: true,
  stdio: "ignore",
  cwd: path.join(__dirname, "api"),
});

server.unref();
console.log("API server started, PID:", server.pid);
process.exit(0);
