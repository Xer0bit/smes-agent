export const config = {
    // Server
    port: parseInt(process.env.PORT || '5000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    // CORS
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',

    // Database
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',

    // AI
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    aiModel: process.env.AI_MODEL || 'gemini-2.5-pro',
    aiMaxTokens: parseInt(process.env.AI_MAX_TOKENS || '8192', 10),

    // Redis (optional)
    redisUrl: process.env.REDIS_URL || '',

    // Preview
    previewBaseUrl: process.env.PREVIEW_BASE_URL || 'http://localhost:3000',
    previewControlUrl: process.env.PREVIEW_CONTROL_URL || process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001',
    dockerManagerUrl: process.env.DOCKER_MANAGER_URL || 'http://localhost:9000',
    maxConcurrentPreviews: parseInt(process.env.MAX_CONCURRENT_PREVIEWS || '50', 10),
    previewIdleTimeoutMinutes: parseInt(process.env.PREVIEW_IDLE_TIMEOUT_MINUTES || '15', 10),

    // Limits
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10),
    maxProjectsPerUser: parseInt(process.env.MAX_PROJECTS_PER_USER || '100', 10),

    // eCG Auth (centralised authentication service)
    ecgAuthBaseUrl: process.env.ECG_AUTH_BASE_URL || '',
    ecgAuthApiKey: process.env.ECG_AUTH_API_KEY || '',
    ecgAuth2faActive: process.env.ECG_AUTH_2FA_ACTIVE === 'true',

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info'
};

export default config;
