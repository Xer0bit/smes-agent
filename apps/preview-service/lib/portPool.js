// Fixed local-port range for per-project Vite child processes (child-process
// preview isolation mode). Sized to MAX_ACTIVE_SERVERS + slack so the pool
// never runs out under normal LRU/idle-reaper churn, with room for a slow
// release racing a fresh allocation during eviction.
const BASE_PORT = 4100;

function createPortPool(maxActiveServers) {
    const size = maxActiveServers + 10;
    const inUse = new Set();

    function allocate() {
        for (let i = 0; i < size; i++) {
            const port = BASE_PORT + i;
            if (!inUse.has(port)) {
                inUse.add(port);
                return port;
            }
        }
        return null; // pool exhausted   caller must handle (should not happen under normal churn)
    }

    // Only ever call this from the child process's own 'exit' event, never at
    // the moment closeProjectServer sends the shutdown IPC/kill signal   a
    // slow-dying old child and a fast-starting new child could otherwise
    // collide on the same port during LRU eviction.
    function release(port) {
        inUse.delete(port);
    }

    return { allocate, release };
}

module.exports = { createPortPool, BASE_PORT };
