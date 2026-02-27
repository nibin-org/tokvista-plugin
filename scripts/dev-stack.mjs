import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";

const isWindows = process.platform === "win32";
const demoDir = resolve("..", "tokvista", "demo");
const demoLockPath = resolve(demoDir, ".next", "dev", "lock");
const relayPort = Number(process.env.PORT || 8787);
const processes = [];
let isShuttingDown = false;

function createNpmInvocation(scriptName) {
  if (isWindows) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `npm run ${scriptName}`]
    };
  }

  return {
    command: "npm",
    args: ["run", scriptName]
  };
}

function runProcess(label, scriptName, cwd) {
  const invocation = createNpmInvocation(scriptName);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: "pipe"
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    if (isShuttingDown) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`[${label}] exited with ${reason}\n`);
    shutdown(1);
  });

  return child;
}

function isPortInUse(port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.on("error", () => resolvePort(false));
    socket.setTimeout(400, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGINT");
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const relayAlreadyRunning = await isPortInUse(relayPort);
if (relayAlreadyRunning) {
  process.stdout.write(`[stack] Relay port ${relayPort} already in use. Skipping relay:start.\n`);
} else {
  processes.push(runProcess("relay", "relay:start", process.cwd()));
}

if (existsSync(demoLockPath)) {
  process.stdout.write(`[stack] Demo appears to already be running (${demoLockPath}). Skipping demo start.\n`);
} else {
  processes.push(runProcess("tokvista-demo", "dev", demoDir));
}

if (processes.length === 0) {
  process.stdout.write("[stack] Nothing to start. Relay and demo are already running.\n");
  process.exit(0);
}
