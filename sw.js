// sw.js

const CACHE_NAME = 'image-encryptor-v3';

// 需要缓存的完整文件列表，包括所有 HTML、CSS、JS 和第三方库
const URLS_TO_CACHE = [
    '/',
    'index.html',
    'style.css',
    'js/script.js',
    // --- 您的第三方库 ---
    "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js",
    "js/image_processor.js",
    "js/image_processor.wasm",
    "js/crypto-worker.js",
    // --- 您将在下一步创建的图标 ---
    'icons/icon-192x192.png',
    'icons/icon-512x512.png'
];

// 1. 安装 Service Worker 并缓存核心资源
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(URLS_TO_CACHE);
            })
    );
});

// 2. 激活 Service Worker 并清理旧缓存
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});


// 3. 拦截网络请求，实现“缓存优先”策略
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // 如果在缓存中找到了匹配的资源，则直接返回
                if (response) {
                    return response;
                }
                // 否则，通过网络去获取
                return fetch(event.request);
            })
    );
});