const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

const defaults = Object.freeze({
    title: 'vioz官方网站',
    version: '1.0.0.0',
    announcement: 'Vig的第一个网站'
});
const fields = { title: 40, version: 20, announcement: 300 };
const maxMessages = 200;
const sessionSeconds = 8 * 60 * 60;
const maxBodyBytes = 8192;

class RequestError extends Error {
    constructor(status, message, headers) {
        super(message);
        this.status = status;
        this.headers = headers;
    }
}

function readSiteFields(input) {
    const site = {};
    for (const [field, limit] of Object.entries(fields)) {
        const value = typeof input?.[field] === 'string' ? input[field].trim() : '';
        if (!value || value.length > limit) return null;
        site[field] = value;
    }
    return site;
}

function createStore() {
    const directory = resolve(process.env.VIG_DATA_DIR || join(__dirname, '.vig-data'));
    const filename = join(directory, 'site.json');
    let snapshot;
    let pending = Promise.resolve();

    function read() {
        snapshot ??= readFile(filename, 'utf8').then(raw => {
            const data = JSON.parse(raw);
            const site = readSiteFields(data?.site);
            if (!site || !Array.isArray(data.messages) || !data.messages.every(message =>
                message && typeof message.id === 'string' && typeof message.name === 'string' &&
                typeof message.text === 'string' && Number.isFinite(Date.parse(message.createdAt)))) {
                throw new Error('站点数据格式无效。');
            }
            return { site, messages: data.messages.slice(0, maxMessages) };
        }).catch(error => {
            if (error.code === 'ENOENT') return { site: defaults, messages: [] };
            snapshot = undefined;
            throw error;
        });
        return snapshot;
    }

    function update(change) {
        const operation = pending.then(async () => {
            const previous = await read();
            const next = change(previous);
            if (next === previous) return;

            await mkdir(directory, { recursive: true, mode: 0o700 });
            const temporary = join(directory, `site-${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
                await rename(temporary, filename);
            } catch (error) {
                await rm(temporary, { force: true }).catch(() => {});
                throw error;
            }
            snapshot = Promise.resolve(next);
        });
        pending = operation.catch(() => {});
        return operation;
    }

    return { read, update };
}

async function readJson(req) {
    const mime = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mime !== 'application/json') throw new RequestError(415, '请以 JSON 格式提交。');
    const tooLarge = new RequestError(413, '请求内容太大。', { Connection: 'close' });
    if (Number(req.headers['content-length']) > maxBodyBytes) throw tooLarge;

    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBodyBytes) throw tooLarge;
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
        throw new RequestError(400, '请求不是有效的 JSON。');
    }
}

function rateWindow(windows, req, limit, duration, message) {
    const ip = req.socket.remoteAddress || '';
    const now = Date.now();
    let window = windows.get(ip);
    if (!window || window.expires <= now) {
        if (windows.size >= 1024) {
            for (const [address, entry] of windows) {
                if (entry.expires <= now) windows.delete(address);
            }
            if (windows.size >= 1024) throw new RequestError(429, message, { 'Retry-After': '60' });
        }
        window = { count: 0, expires: now + duration };
        windows.set(ip, window);
    }
    if (window.count >= limit) {
        const retry = Math.ceil((window.expires - now) / 1000);
        throw new RequestError(429, message, { 'Retry-After': String(retry) });
    }
    return window;
}

function digest(password) {
    return createHash('sha256').update(password).digest();
}

function sessionCookie(req, token, age) {
    const secure = req.socket.encrypted || req.headers.origin?.toLowerCase().startsWith('https://');
    return { 'Set-Cookie': `vig_admin_session=${token}; Max-Age=${age}; Path=/api/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}` };
}

function createSiteApi({ sendJson, reject }) {
    const store = createStore();
    const passwordDigest = process.env.VIG_ADMIN_PASSWORD ? digest(process.env.VIG_ADMIN_PASSWORD) : null;
    const sessions = new Map();
    const loginWindows = new Map();
    const messageWindows = new Map();

    function getSession(req) {
        const token = req.headers.cookie?.match(/(?:^|;\s*)vig_admin_session=([a-f0-9]{64})(?:;|$)/)?.[1];
        if (!token || !sessions.has(token)) return null;
        if (sessions.get(token) > Date.now()) return token;
        sessions.delete(token);
        return null;
    }

    return async function handleSiteApi(req, res, pathname) {
        try {
            const origin = req.headers.origin?.toLowerCase();
            const host = (req.headers.host || '').toLowerCase();
            if (req.method !== 'GET' && origin && origin !== `http://${host}` && origin !== `https://${host}`) {
                throw new RequestError(403, '请从本站页面操作。');
            }

            let allowed;
            const deletion = /^\/api\/admin\/guestbook\/([^/]+)$/.exec(pathname);
            switch (pathname) {
                case '/api/site':
                case '/api/admin/session': allowed = ['GET']; break;
                case '/api/guestbook': allowed = ['GET', 'POST']; break;
                case '/api/admin/login':
                case '/api/admin/logout': allowed = ['POST']; break;
                case '/api/admin/site': allowed = ['GET', 'PUT']; break;
                default:
                    if (!deletion) throw new RequestError(404, '找不到接口。');
                    allowed = ['DELETE'];
            }
            if (!allowed.includes(req.method)) {
                throw new RequestError(405, '不支持此请求方法。', { Allow: allowed.join(', ') });
            }
            if (req.method === 'GET' || req.method === 'DELETE') req.resume();

            if (pathname === '/api/site') {
                const { site } = await store.read();
                return sendJson(res, 200, { ...site, adminEnabled: Boolean(passwordDigest) });
            }
            if (pathname === '/api/guestbook') {
                if (req.method === 'GET') {
                    const { messages } = await store.read();
                    return sendJson(res, 200, { messages });
                }
                const input = await readJson(req);
                const name = typeof input?.name === 'string' ? input.name.trim() : '';
                const text = typeof input?.text === 'string' ? input.text.trim() : '';
                if (name.length > 10 || (input?.name != null && typeof input.name !== 'string')) {
                    throw new RequestError(400, '昵称最多 10 个字符。');
                }
                if (!text || text.length > 50) throw new RequestError(400, '留言需要 1 到 50 个字符。');
                rateWindow(messageWindows, req, 10, 60_000, '留言太频繁，请稍后再试。').count++;
                const message = { id: randomUUID(), name: name || '匿名访客', text, createdAt: new Date().toISOString() };
                await store.update(state => ({ ...state, messages: [message, ...state.messages].slice(0, maxMessages) }));
                return sendJson(res, 201, message);
            }

            if (!passwordDigest) throw new RequestError(503, '尚未设置管理员密码，请先配置 VIG_ADMIN_PASSWORD。');
            const session = getSession(req);
            if (pathname === '/api/admin/session') return sendJson(res, 200, { authenticated: Boolean(session) });
            if (pathname === '/api/admin/login') {
                const input = await readJson(req);
                const window = rateWindow(loginWindows, req, 5, 60_000, '登录尝试过多，请稍后再试。');
                if (typeof input?.password !== 'string' || !timingSafeEqual(digest(input.password), passwordDigest)) {
                    window.count++;
                    throw new RequestError(401, '管理员密码不正确。');
                }
                loginWindows.delete(req.socket.remoteAddress || '');
                sessions.delete(session);
                if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
                const token = randomBytes(32).toString('hex');
                sessions.set(token, Date.now() + sessionSeconds * 1000);
                return sendJson(res, 200, {}, sessionCookie(req, token, sessionSeconds));
            }
            if (pathname === '/api/admin/logout') {
                await readJson(req);
                sessions.delete(session);
                return sendJson(res, 200, {}, sessionCookie(req, '', 0));
            }
            if (!session) throw new RequestError(401, '请先登录管理后台。');

            if (deletion) {
                const id = deletion[1];
                await store.update(state => {
                    const messages = state.messages.filter(message => message.id !== id);
                    return messages.length === state.messages.length ? state : { ...state, messages };
                });
                return sendJson(res, 200, {});
            }
            if (req.method === 'GET') return sendJson(res, 200, (await store.read()).site);

            const site = readSiteFields(await readJson(req));
            if (!site) throw new RequestError(400, '请填写网站标题、版本和公告，分别最多 40、20 和 300 个字符。');
            await store.update(state => ({ ...state, site }));
            return sendJson(res, 200, site);
        } catch (error) {
            if (res.destroyed || res.writableEnded) return;
            if (error instanceof RequestError) return reject(req, res, error.status, error.message, error.headers);
            console.error('站点后台处理失败：', error);
            return reject(req, res, 500, '站点数据操作失败，请稍后重试。');
        }
    };
}

module.exports = { createSiteApi };
