import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

// Polyfill crypto globally for Node 18 environment
if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: false,
        configurable: true
    });
}
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: (() => {
                // Default to wildcard to allow all origins (most permissive, best for public streaming API)
                // Set CORS_RESTRICT=true AND CORS_ORIGIN=<comma-separated-origins> to restrict
                const restrict = process.env.CORS_RESTRICT === 'true';
                const raw = process.env.CORS_ORIGIN;
                if (!restrict || !raw || raw === '*') return '*';
                // Support comma-separated list of origins when restriction is enabled
                const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
                if (origins.length === 0) return '*';
                if (origins.length === 1) return origins[0];
                return origins;
            })(),
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));

    // Intercept and override /v1/proxy route to resolve double-decoding bug on nested target URLs (like VidRock/VidApi)
    const app = server.getInstance();
    app.addHook('preValidation', async (request, reply) => {
        if ((request as any).routerPath === '/v1/proxy') {
            const { data } = request.query as { data?: string };
            if (!data) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Missing required parameter: data',
                    },
                    traceId: request.id,
                });
            }

            let proxyDataRaw;
            try {
                // Since Fastify has already decoded the data parameter once, we try parsing it directly.
                proxyDataRaw = JSON.parse(data);
            } catch (error) {
                // Fallback: if client double-encoded it, try decoding once
                try {
                    const decoded = decodeURIComponent(data);
                    proxyDataRaw = JSON.parse(decoded);
                } catch (err2) {
                    return reply.code(400).send({
                        error: {
                            code: 'INVALID_PARAMETER',
                            message: 'Invalid data parameter format',
                        },
                        traceId: request.id,
                    });
                }
            }

            // Inject range headers
            const proxyData = {
                ...proxyDataRaw,
                headers: {
                    ...proxyDataRaw.headers,
                    ...(request.headers.range && { range: request.headers.range }),
                    ...(request.headers.Range && { Range: request.headers.Range }),
                },
            };

            const enhancedData = encodeURIComponent(JSON.stringify(proxyData));
            const response = await (server as any).proxyService.proxyRequest(enhancedData);

            const isStreamResponse = (res: any): boolean => res && 'stream' in res;

            if (isStreamResponse(response)) {
                reply.code(response.statusCode).headers(response.headers).type(response.contentType);
                return reply.send(response.stream);
            }

            return reply
                .code(response.statusCode)
                .headers(response.headers || {})
                .type(response.contentType)
                .send(response.data);
        }
    });

    await server.start();

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

main().catch(() => {
    process.exit(1);
});
