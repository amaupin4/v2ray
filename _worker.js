// _worker.js
// Cloudflare Worker ကုဒ်သည် V2Ray (VLESS+WS+TLS) နှင့် အလုပ်လုပ်ရန်အတွက် ပြင်ဆင်ထားသည်။

const upstream = ['cdn.xn--b6gac.eu.org', 'cdn-all.xn--b6gac.eu.org', 'workers.cloudflare.cyou']; // V2Ray ဆာဗာ၏ IP သို့မဟုတ် domain (ဥပမာ: dagonuniversity.edu.eu.org)
const upstreamPath = '/vless';
const uuid = '2a0eef91-bae7-4c2a-bcea-fcd45e7088ad'; // သင်၏ V2Ray UUID
const allowedPorts = [443, 8443, 2053, 2083, 2087, 2096];
const workerPort = 443;

// cn_hostnames စာရင်းကို သင်ပေးထားသော ကုဒ်မှ ထည့်သွင်းထားသည်။
const cn_hostnames = [
    'weibo.com', 'www.baidu.com', 'www.qq.com', 'www.taobao.com', 'www.jd.com', 
    'www.sina.com.cn', 'www.sohu.com', 'www.tmall.com', 'www.163.com', 'www.zhihu.com', 
    'www.youku.com', 'www.xinhuanet.com', 'www.douban.com', 'www.meituan.com', 
    'www.toutiao.com', 'www.ifeng.com', 'www.autohome.com.cn', 'www.360.cn', 
    'www.douyin.com', 'www.kuaidi100.com', 'www.wechat.com', 'www.csdn.net', 
    'www.imgo.tv', 'www.aliyun.com', 'www.eyny.com', 'www.mgtv.com', 'www.xunlei.com', 
    'www.hao123.com', 'www.bilibili.com', 'www.youth.cn', 'www.hupu.com', 
    'www.youzu.com', 'www.panda.tv', 'www.tudou.com', 'www.zol.com.cn', 
    'www.toutiao.io', 'www.tiktok.com', 'www.netease.com', 'www.cnki.net', 
    'www.zhibo8.cc', 'www.zhangzishi.cc', 'www.xueqiu.com', 'www.qqgongyi.com', 
    'www.ximalaya.com', 'www.dianping.com', 'www.suning.com', 'www.zhaopin.com', 
    'www.jianshu.com', 'www.mafengwo.cn', 'www.51cto.com', 'www.qidian.com', 
    'www.ctrip.com', 'www.pconline.com.cn', 'www.cnzz.com', 'www.telegraph.co.uk', 
    'www.ynet.com', 'www.ted.com', 'www.renren.com', 'www.pptv.com', 'www.liepin.com', 
    'www.881903.com', 'www.aipai.com', 'www.ttpaihang.com', 'www.quyaoya.com', 
    'www.91.com', 'www.dianyou.cn', 'www.tmtpost.com', 'www.douban.com', 
    'www.guancha.cn', 'www.so.com', 'www.58.com', 'www.cnblogs.com', 'www.cntv.cn', 
    'www.secoo.com'
];

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

/**
 * Handles incoming requests and routes them to either WebSocket or reverse proxy.
 * @param {Request} request The incoming request object.
 * @returns {Promise<Response>} A Promise that resolves to the response object.
 */
async function handleRequest(request) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');

    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        // Handle non-WebSocket requests with reverse proxy to cn_hostnames
        const randomHostname = cn_hostnames[Math.floor(Math.random() * cn_hostnames.length)];
        const newHeaders = new Headers(request.headers);
        newHeaders.set('cf-connecting-ip', '1.2.3.4');
        newHeaders.set('x-forwarded-for', '1.2.3.4');
        newHeaders.set('x-real-ip', '1.2.3.4');
        newHeaders.set('referer', 'https://www.google.com/search?q=edtunnel');

        const proxyUrl = `https://${randomHostname}${url.pathname}${url.search}`;
        let modifiedRequest = new Request(proxyUrl, {
            method: request.method,
            headers: newHeaders,
            body: request.body,
            redirect: 'manual',
        });

        const proxyResponse = await fetch(modifiedRequest, { redirect: 'manual' });
        if ([301, 302].includes(proxyResponse.status)) {
            return new Response(`Redirects to ${randomHostname} are not allowed.`, {
                status: 403,
                statusText: 'Forbidden',
            });
        }
        return proxyResponse;
    } else {
        // Handle WebSocket requests for V2Ray
        return await handleWebSocket(request);
    }
}

/**
 * Handles WebSocket requests for V2Ray.
 * @param {Request} request The incoming WebSocket request.
 * @returns {Promise<Response>} A Promise that resolves to a WebSocket response.
 */
async function handleWebSocket(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    const log = (info, event) => {
        console.log(`[${new Date().toISOString()}] ${info}`, event || '');
    };

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(server, earlyDataHeader, log);

    let remoteSocket = null;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const { hasError, message, addressRemote, portRemote, rawDataIndex, isUDP } = processVlessHeader(chunk, uuid);
            if (hasError) {
                throw new Error(message);
            }

            if (isUDP) {
                throw new Error('UDP is not supported in this configuration');
            }

            remoteSocket = await connectToRemote(addressRemote || upstream, portRemote || workerPort, log);
            const writer = remoteSocket.writable.getWriter();
            await writer.write(chunk.slice(rawDataIndex));
            writer.releaseLock();

            remoteSocketToWS(remoteSocket, server, null, log);
        },
        close() {
            log('Readable WebSocket stream closed');
            safeCloseWebSocket(server);
        },
        abort(reason) {
            log('Readable WebSocket stream aborted', JSON.stringify(reason));
            safeCloseWebSocket(server);
        },
    })).catch(err => {
        log('Error in WebSocket stream', err);
        safeCloseWebSocket(server);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

/**
 * Connects to the remote V2Ray server.
 * @param {string} address The remote address to connect to.
 * @param {number} port The remote port to connect to.
 * @param {function} log The logging function.
 * @returns {Promise<Socket>} A Promise that resolves to the connected socket.
 */
async function connectToRemote(address, port, log) {
    const socket = connect({
        hostname: address,
        port: port,
    });
    log(`Connected to ${address}:${port}`);
    return socket;
}

/**
 * Creates a readable stream from a WebSocket.
 * @param {WebSocket} webSocketServer The WebSocket server.
 * @param {string} earlyDataHeader The early data header.
 * @param {function} log The logging function.
 * @returns {ReadableStream} A readable stream from the WebSocket.
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', event => {
                if (readableStreamCancel) return;
                controller.enqueue(event.data);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) controller.close();
            });

            webSocketServer.addEventListener('error', err => {
                log('WebSocket error', err);
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
            log(`ReadableStream canceled: ${reason}`);
        }
    });
    return stream;
}

/**
 * Processes the VLESS header.
 * @param {ArrayBuffer} vlessBuffer The VLESS header buffer.
 * @param {string} userID The user ID for validation.
 * @returns {Object} The processed header information.
 */
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: 'Invalid VLESS header' };
    }

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
    const uuidString = stringify(uuidBytes);
    if (uuidString !== userID) {
        return { hasError: true, message: 'Invalid UUID' };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19 + optLength))[0];
    let isUDP = command === 2;

    if (command !== 1 && command !== 2) {
        return { hasError: true, message: `Unsupported command: ${command}` };
    }

    const portIndex = 19 + optLength;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    const addressIndex = portIndex + 2;
    const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
    let addressLength = 0;
    let addressValue = '';
    let addressValueIndex = addressIndex + 1;

    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2: // Domain
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex + 1, addressValueIndex + 1 + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            const ipv6 = [];
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true, message: `Invalid address type: ${addressType}` };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        isUDP,
    };
}

/**
 * Converts a remote socket to a WebSocket stream.
 * @param {Socket} remoteSocket The remote socket.
 * @param {WebSocket} webSocket The WebSocket connection.
 * @param {ArrayBuffer|null} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, log) {
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState !== 1) {
                return;
            }
            webSocket.send(vlessResponseHeader ? await new Blob([vlessResponseHeader, chunk]).arrayBuffer() : chunk);
        },
        close() {
            log('Remote socket closed');
        },
        abort(reason) {
            log('Remote socket aborted', reason);
        }
    })).catch(err => {
        log('Remote socket error', err);
        safeCloseWebSocket(webSocket);
    });

    if (!hasIncomingData) {
        log('No incoming data, retrying...');
        safeCloseWebSocket(webSocket);
    }
}

/**
 * Safely closes a WebSocket connection.
 * @param {WebSocket} socket The WebSocket to close.
 */
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === 1 || socket.readyState === 2) {
            socket.close();
        }
    } catch (error) {
        console.error('Error closing WebSocket', error);
    }
}

/**
 * Converts a base64 string to an ArrayBuffer.
 * @param {string} base64Str The base64 string.
 * @returns {Object} The decoded ArrayBuffer or error.
 */
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

/**
 * Converts a byte array to a UUID string.
 * @param {Uint8Array} arr The byte array.
 * @param {number} offset The offset to start from.
 * @returns {string} The UUID string.
 */
function stringify(arr, offset = 0) {
    const byteToHex = [];
    for (let i = 0; i < 256; ++i) {
        byteToHex.push((i + 256).toString(16).slice(1));
    }
    const uuid = (
        byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" +
        byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" +
        byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" +
        byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" +
        byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
    ).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
        throw TypeError("Invalid UUID");
    }
    return uuid;
}
