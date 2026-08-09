let viteApiPromise = null;

async function getViteApi() {
    if (!viteApiPromise) {
        viteApiPromise = Promise.all([
            import('vite'),
            import('@vitejs/plugin-react'),
        ]).then(([viteModule, reactModule]) => ({
            createViteServer: viteModule.createServer,
            transformWithEsbuild: viteModule.transformWithEsbuild,
            viteBuild: viteModule.build,
            reactPluginFactory: reactModule.default,
        })).catch((err) => {
            // Reset so the next call retries the import instead of re-using the
            // permanently-rejected promise, which would break all project creation.
            viteApiPromise = null;
            throw err;
        });
    }

    return viteApiPromise;
}

module.exports = { getViteApi };
