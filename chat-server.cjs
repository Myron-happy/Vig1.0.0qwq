const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { createSiteApi } = require('./site-admin.cjs');

const lan = process.argv.includes('--lan');
const host = lan ? '0.0.0.0' : '127.0.0.1';
const portSetting = process.env.VIG_CHAT_PORT ?? '8787';
const port = Number(portSetting);

if (!/^\d+$/.test(portSetting) || port > 65535) {
    console.error('VIG_CHAT_PORT 必须是 0 到 65535 之间的整数。');
    process.exit(1);
}

const pages = new Map([['/', 'index.html'], ['/admin', 'Admin.html'], ['/admin/', 'Admin.html']]);
for (const filename of ['index.html', 'About.html', 'Weather.html', '403.html', '404.html', 'Chat.html', 'Admin.html']) {
    pages.set('/' + filename, filename);
}

const history = [];
const clients = new Map();
const rateWindows = new Map();
const maxBodyBytes = 8192;
const rateWindowMs = 10_000;
const postsPerWindow = 20;

function sendJson(res, status, value, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    });
    res.end(JSON.stringify(value));
}

function reject(req, res, status, error, headers) {
    req.resume();
    sendJson(res, status, { error }, headers);
}

const handleSiteApi = createSiteApi({ sendJson, reject });

function writeEvent(res, event) {
    if (res.destroyed || res.writableEnded || res.writableLength > 256 * 1024) {
        clients.delete(res);
        res.destroy();
        return;
    }
    res.write(event);
}

function openEvents(req, res, ip) {
    let sameAddress = 0;
    for (const address of clients.values()) {
        if (address === ip) sameAddress++;
    }
    if (clients.size >= 48 || sameAddress >= 8) {
        return reject(req, res, 503, '聊天室连接数已满，请稍后再试。', { 'Retry-After': '10' });
    }

    req.resume();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    clients.set(res, ip);
    res.on('close', () => clients.delete(res));
    writeEvent(res, `event: history\ndata: ${JSON.stringify(history)}\n\n`);
}

function checkPostRate(ip) {
    const now = Date.now();
    let window = rateWindows.get(ip);
    if (!window || window.expires <= now) {
        if (!window && rateWindows.size >= 1024) return 1;
        window = { expires: now + rateWindowMs, count: 0 };
        rateWindows.set(ip, window);
    }
    if (window.count >= postsPerWindow) return Math.ceil((window.expires - now) / 1000);
    window.count++;
    return 0;
}

function postMessage(req, res, ip) {
    const retryAfter = checkPostRate(ip);
    if (retryAfter) {
        return reject(req, res, 429, '发送太频繁，请稍后再试。', { 'Retry-After': String(retryAfter) });
    }
    const mime = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mime !== 'application/json') return reject(req, res, 415, '请以 JSON 格式提交消息。');
    if (Number(req.headers['content-length']) > maxBodyBytes) {
        return reject(req, res, 413, '请求内容太大。', { 'Connection': 'close' });
    }

    let bytes = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
        if (tooLarge) return;
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
            tooLarge = true;
            chunks.length = 0;
            sendJson(res, 413, { error: '请求内容太大。' }, { 'Connection': 'close' });
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (tooLarge || res.destroyed) return;
        let input;
        try {
            input = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        } catch {
            return sendJson(res, 400, { error: '消息不是有效的 JSON。' });
        }
        const name = typeof input?.name === 'string' ? input.name.trim() : '';
        const text = typeof input?.text === 'string' ? input.text.trim() : '';
        if (!name || name.length > 20) return sendJson(res, 400, { error: '昵称需要 1 到 20 个字符。' });
        if (!text || text.length > 300) return sendJson(res, 400, { error: '消息需要 1 到 300 个字符。' });

        const message = { id: randomUUID(), name, text, createdAt: new Date().toISOString() };
        history.push(message);
        if (history.length > 100) history.shift();
        const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
        for (const client of clients.keys()) writeEvent(client, event);
        sendJson(res, 201, message);
    });
}

async function servePage(req, res, filename) {
    req.resume();
    let page;
    try {
        page = await readFile(join(__dirname, filename));
    } catch (error) {
        if (res.destroyed) return;
        if (error.code === 'ENOENT') return sendJson(res, 404, { error: '找不到页面。' });
        return sendJson(res, 500, { error: '读取页面失败。' });
    }
    if (res.destroyed) return;
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': page.length,
        'Cache-Control': filename === 'Admin.html' ? 'no-store' : 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : page);
}

function handleRequest(req, res) {
    req.on('error', () => res.destroy());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const requestHost = (req.headers.host || '').toLowerCase();
    if (!lan && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(requestHost)) {
        return reject(req, res, 403, '请通过本机地址访问。');
    }

    const pathname = req.url.split('?', 1)[0];
    if (pathname === '/api/site' || pathname === '/api/guestbook' || pathname.startsWith('/api/admin/')) {
        return handleSiteApi(req, res, pathname).catch(error => {
            console.error('网站接口请求失败：', error.message);
            if (!res.destroyed && !res.headersSent) reject(req, res, 500, '网站服务暂时不可用。');
        });
    }
    if (pathname === '/api/chat/events' || pathname === '/api/chat/messages') {
        const origin = req.headers.origin?.toLowerCase();
        if (origin && origin !== 'http://' + requestHost && origin !== 'https://' + requestHost) {
            return reject(req, res, 403, '请从聊天室页面访问。');
        }
        const events = pathname === '/api/chat/events';
        const method = events ? 'GET' : 'POST';
        if (req.method !== method) {
            return reject(req, res, 405, '不支持此请求方法。', { Allow: method });
        }
        const ip = req.socket.remoteAddress || '';
        return events ? openEvents(req, res, ip) : postMessage(req, res, ip);
    }

    const filename = pages.get(pathname);
    if (!filename) return reject(req, res, 404, '找不到页面。');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reject(req, res, 405, '不支持此请求方法。', { Allow: 'GET, HEAD' });
    }
    return servePage(req, res, filename);
}

const server = http.createServer({
    headersTimeout: 10_000,
    requestTimeout: 15_000,
    connectionsCheckingInterval: 5_000
}, handleRequest);
server.maxConnections = 128;

setInterval(() => {
    for (const client of clients.keys()) writeEvent(client, ': heartbeat\n\n');
    const now = Date.now();
    for (const [ip, window] of rateWindows) {
        if (window.expires <= now) rateWindows.delete(ip);
    }
}, 15_000).unref();

server.on('error', error => {
    console.error(`网站服务启动失败：${error.message}`);
    process.exitCode = 1;
});
server.listen(port, host, () => {
    const listeningPort = server.address().port;
    console.log(`网站已启动：http://127.0.0.1:${listeningPort}/`);
    if (process.env.VIG_ADMIN_PASSWORD) {
        console.log(`网站后台：http://127.0.0.1:${listeningPort}/admin`);
    }
    console.log(`聊天室已启动：http://127.0.0.1:${listeningPort}/Chat.html`);
    if (lan) {
        const addresses = new Set(Object.values(networkInterfaces()).flat()
            .filter(info => info.family === 'IPv4' && !info.internal)
            .map(info => info.address));
        for (const address of addresses) {
            console.log(`局域网访问：http://${address}:${listeningPort}/Chat.html`);
        }
    }
});
