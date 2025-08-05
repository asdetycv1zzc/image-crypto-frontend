// crypto-worker.js

// 引入Emscripten生成的JS胶水文件，这是让每个worker加载WASM最简单的方式
importScripts('image_processor.js');
importScripts('utils.js');
let wasmApi = null;

// Module 是由 image_processor.js 创建的全局对象
// 等待WASM运行时初始化完成
createImageProcessorModule()
    .then(Module => {
        // 4. 当Promise解析后，我们才真正得到了Module对象
        console.log("Worker: WASM 模块已加载并初始化。");

        // 5. 现在可以安全地创建 wasmApi 对象了
        wasmApi = {
            Module: Module,
            perform_encryption: Module.cwrap(
                'perform_encryption', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
            ),
            perform_decryption: Module.cwrap(
                'perform_decryption', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
            )
        };

        // 6. 向主线程发送“准备就绪”的消息，表明这个worker可以开始接收任务了
        self.postMessage({ status: 'ready' });
    })
    .catch(err => {
        // 如果模块在worker内部加载失败，也要通知主线程
        console.error("Worker: WASM 模块加载失败:", err);
        self.postMessage({ status: 'error', error: `WASM 模块加载失败: ${err.message}` });
    });

// 监听主线程发来的任务
self.onmessage = async (event) => {
    if (!wasmApi) {
        // 如果WASM还没准备好，则忽略消息
        return;
    }

    const {file, fileBuffer, fileName} = event.data;

    try {
        // -----------------------------------------------------------------
        // Worker 的核心逻辑：与您原来的单线程 processImageFile 几乎一样
        // 只是它现在在 Worker 内部运行
        // -----------------------------------------------------------------

        // 1. 解码图片
        const {width, height, data: pixels} = decodeImage(fileBuffer); // 假设 decodeImage 等工具函数也在此作用域可用

        if (!width || !height) {
            throw new Error("解码失败，无法获取图片数据。");
        }

        // 2. 加密或解密
        const isEncrypted = isEncrypted(pixels, width, height);
        let outputPngBuffer;
        if (isEncrypted) {
            outputPngBuffer = await decryptWithShuffle(wasmApi, pixels, width, height);
        } else {
            outputPngBuffer = await encryptWithShuffle(wasmApi, pixels, width, height);
        }

        // 3. 将结果发送回主线程
        // 注意：ArrayBuffer需要作为可转移对象发送，以避免复制
        self.postMessage({
            status: 'done',
            originalFileName: fileName,
            result: {
                buffer: outputPngBuffer,
                newFileName: isEncrypted ? `decrypted-${fileName}` : `encrypted-${fileName}.png`
            }
        }, [outputPngBuffer]);

    } catch (e) {
        // 如果处理失败，将错误信息发回主线程
        self.postMessage({
            status: 'error',
            originalFileName: fileName,
            error: e.message
        });
    }
};

// --- 您需要将所有依赖的函数 (decodeImage, isEncrypted, etc.) 也放入Worker中 ---
// 简单的方法是通过 importScripts() 引入它们所在的js文件。
// 例如: importScripts('image-decoders.js', 'helpers.js');
// 或者将这些函数直接复制粘贴到这个 worker 文件的顶部。