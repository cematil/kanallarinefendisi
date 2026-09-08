const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

// Güvenlik Başlıkları Middleware
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(cors());

// Statik Dosya Sunumu
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(process.cwd()));

// HTML Rotaları
app.get('/main.html', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'main.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'index.html'));
});

// M3U Ayrıştırma Fonksiyonu
function parseM3U(filePath) {
    const channels = [];
    if (!fs.existsSync(filePath)) return channels;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let currentChannel = {};

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            const commaIndex = line.lastIndexOf(',');
            const name = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Kanal';

            const groupMatch = line.match(/group-title="([^"]+)"/);
            let category = groupMatch ? groupMatch[1].replace('┃TR┃', '').trim() : 'Diğer';

            const logoMatch = line.match(/tvg-logo="([^"]+)"/);
            let logo = logoMatch ? logoMatch[1].trim() : '';

            currentChannel = {
                name: name,
                category: category || 'Genel',
                logo: logo
            };
        } else if (line.startsWith('http')) {
            if (currentChannel.name) {
                currentChannel.url = line;
                channels.push(currentChannel);
                currentChannel = {};
            }
        }
    });

    return channels;
}

// Esnek Kanal API Rotası
app.get('/api/channels', (req, res) => {
    // Parametre verilmişse onu al, yoksa varsayılan olarak trtr.m3u oku
    const fileName = req.query.file || 'trtr.m3u';
    const filePath = path.join(process.cwd(), fileName);

    const channels = parseM3U(filePath);
    res.json(channels);
});

// Yayın Çekme (Proxy) Fonksiyonu
function fetchStream(targetUrl, callback) {
    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; Linux; U; Linux; rv:1.1) AppleWebKit/534.34 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/534.34',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }
    };

    const req = client.request(options, (remoteRes) => {
        if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
            const redirectUrl = new URL(remoteRes.headers.location, targetUrl).href;
            return fetchStream(redirectUrl, callback);
        }
        callback(null, remoteRes, parsedUrl.href);
    });

    req.on('error', (err) => callback(err));
    req.end();
}

// Proxy Rotası
app.get('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL eksik');

    const decodedUrl = decodeURIComponent(targetUrl);

    fetchStream(decodedUrl, (err, remoteRes, finalUrl) => {
        if (err) {
            console.error("Proxy Hatası:", err.message);
            return res.status(500).send('Proxy Hatası: ' + err.message);
        }

        if (remoteRes.statusCode === 403) {
            return res.status(403).send('Access Denied');
        }

        const contentType = remoteRes.headers['content-type'] || '';

        if (contentType.includes('mpegurl') || decodedUrl.includes('.m3u8') || decodedUrl.includes('extension=m3u8') || decodedUrl.includes('live.php')) {
            let body = '';
            remoteRes.setEncoding('utf8');
            remoteRes.on('data', chunk => body += chunk);
            remoteRes.on('end', () => {
                const lines = body.split('\n');
                const newLines = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '#EXT-X-ENDLIST' || trimmed === '#EXT-X-PLAYLIST-TYPE:VOD') {
                        return '';
                    }
                    if (trimmed && !trimmed.startsWith('#')) {
                        const absUrl = new URL(trimmed, finalUrl).href;
                        return `/proxy?url=${encodeURIComponent(absUrl)}`;
                    }
                    return line;
                });

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.send(newLines.join('\n'));
            });
        } else {
            res.setHeader('Content-Type', contentType || 'video/mp2t');
            remoteRes.pipe(res);
        }
    });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Node.js IPTV Sunucusu http://localhost:${PORT} adresinde aktif.`);
    });
}

module.exports = app;
