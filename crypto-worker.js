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
        self.postMessage({status: 'ready'});
    })
    .catch(err => {
        // 如果模块在worker内部加载失败，也要通知主线程
        console.error("Worker: WASM 模块加载失败:", err);
        self.postMessage({status: 'error', error: `WASM 模块加载失败: ${err.message}`});
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
async function processImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                console.log(`--- 开始处理文件: ${file.name} ---`);
                const buffer = event.target.result;
                const {width, height, data: pixels} = decodeImage(buffer);

                if (!width || !height || !pixels || pixels.length === 0) {
                    throw new Error("解码失败，无法获取图片数据。");
                }

                console.log(`解码后尺寸: ${width}x${height}`);

                const isAlreadyEncrypted = isEncrypted(pixels, width, height);
                console.log(`isEncrypted 函数返回: ${isAlreadyEncrypted}`);

                let outputPngBuffer;

                if (isAlreadyEncrypted) {
                    // 如果检测到 magic row，使用新的 shuffle 解密器
                    outputPngBuffer = await decryptWithShuffle(wasmApi, pixels, width, height);
                } else {
                    // 否则，使用新的 shuffle 加密器
                    outputPngBuffer = await encryptWithShuffle(wasmApi, pixels, width, height);
                }

                const imageBlob = new Blob([outputPngBuffer], {type: 'image/png'});
                const newFileName = isAlreadyEncrypted ? `decrypted-shuffled-${file.name.replace(/\.png$/i, '')}` : `encrypted-shuffled-${file.name.split('.').slice(0, -1).join('.') || file.name}.png`;

                resolve({name: newFileName, blob: imageBlob});
            } catch (error) {
                console.error("处理图片时发生错误:", error);
                // 提供更具体的错误信息给卡片
                const errorMessage = error.message || "未知错误";
                reject(new Error(`处理失败: ${errorMessage}`));
            }
        };
        reader.onerror = (error) => reject(new Error("文件读取失败。"));
        reader.readAsArrayBuffer(file);
    });
}
// 在您的 script.js 中，完整替换这个函数
async function encryptWithShuffle(wasmApi, pixels, width, height) {
    console.log("执行加密 (WASM 优化方案)...");

    const {Module, perform_encryption} = wasmApi;

    // --- 步骤 1: 尺寸和参数校验 (核心修复点) ---
    // 检查最小宽度要求：元数据行需要至少20字节，即宽度至少为5像素。
    if (width < 5) {
        throw new Error(`图片宽度太小 (${width}px)，无法写入元数据。最小宽度要求为 5px。`);
    }

    // 计算可用的内容区域
    const contentWidth = Math.floor(width / BLOCK_SIZE) * BLOCK_SIZE;
    const contentHeight = Math.floor(height / BLOCK_SIZE) * BLOCK_SIZE;

    // 检查内容区域是否足够进行分块
    if (contentWidth < BLOCK_SIZE || contentHeight < BLOCK_SIZE) {
        throw new Error(`图片尺寸太小 (有效区域 ${contentWidth}x${contentHeight}px)，无法进行分块加密。最小有效区域要求为 ${BLOCK_SIZE}x${BLOCK_SIZE}px。`);
    }

    const blocksX = contentWidth / BLOCK_SIZE;
    const blocksY = contentHeight / BLOCK_SIZE;
    const totalBlocks = blocksX * blocksY;

    // --- 步骤 2: 计算元数据和参数 ---
    const metadata = {
        originalWidth: width,
        originalHeight: height,
        contentWidth,
        contentHeight,
        totalBlocks
    };

    const shuffleMap = Array.from({length: totalBlocks}, (_, i) => i);
    shuffleArray(shuffleMap);

    const mapRows = Math.ceil(totalBlocks / width);
    const newHeight = 1 + mapRows + height + 1;

    // --- 步骤 3: 在 JavaScript 中创建并填充最终的输出缓冲区 ---
    const outputPixels = new Uint8Array(width * newHeight * CHANNELS);

    // 3a. 写入元数据行 (现在可以安全地写入了)
    const metadataRow = outputPixels.subarray(0, width * CHANNELS);
    encodeMetadataToRow(metadataRow, metadata);

    // 3b. 写入 Shuffle Map
    const mapStartOffset = width * CHANNELS;
    for (let i = 0; i < totalBlocks; i++) {
        encodeNumberToPixel(shuffleMap[i], outputPixels, mapStartOffset + i * CHANNELS);
    }

    // --- 步骤 4: 调用 WASM 执行核心的像素打乱操作 ---
    let originalPixelsPtr = 0, shuffleMapPtr = 0, outputImagePtr = 0;

    try {
        originalPixelsPtr = Module._malloc(pixels.length);
        shuffleMapPtr = Module._malloc(shuffleMap.length * 4);
        outputImagePtr = Module._malloc(pixels.length);

        if (!originalPixelsPtr || !shuffleMapPtr || !outputImagePtr) {
            throw new Error("在 WASM 中分配内存失败。");
        }

        Module.HEAPU8.set(pixels, originalPixelsPtr);
        Module.HEAPU32.set(new Uint32Array(shuffleMap), shuffleMapPtr / 4);

        perform_encryption(
            originalPixelsPtr, width, height, contentWidth, contentHeight,
            shuffleMapPtr, outputImagePtr, 0
        );

        const imageContentStartOffset = (1 + mapRows) * width * CHANNELS;
        const resultView = new Uint8Array(Module.HEAPU8.buffer, outputImagePtr, pixels.length);
        outputPixels.set(resultView, imageContentStartOffset);

    } finally {
        if (originalPixelsPtr) Module._free(originalPixelsPtr);
        if (shuffleMapPtr) Module._free(shuffleMapPtr);
        if (outputImagePtr) Module._free(outputImagePtr);
    }

    // --- 步骤 5: 写入最后的 Magic Row ---
    const magicRow = generateMagicRow(width);
    outputPixels.set(magicRow, (newHeight - 1) * width * CHANNELS);

    console.log(`WASM 无损加密完成。`);

    // --- 步骤 6: 将填充完毕的、完整的缓冲区进行 PNG 编码 ---
    return UPNG.encode([outputPixels.buffer], width, newHeight, 0);
}

const BLOCK_SIZE = 32;

/**
 * 将一个 32 位整数（块索引）编码到一个 RGBA 像素中。
 * @param {number} num - 要编码的数字.
 * @param {Uint8Array} pixelData - 目标像素数据 (长度为 4).
 * @param {number} offset - 在像素数据中的偏移量.
 */
function encodeNumberToPixel(num, pixelData, offset) {
    pixelData[offset] = (num >> 24) & 0xFF; // Red
    pixelData[offset + 1] = (num >> 16) & 0xFF; // Green
    pixelData[offset + 2] = (num >> 8) & 0xFF; // Blue
    pixelData[offset + 3] = num & 0xFF;         // Alpha
}

/**
 * 将所有必要的元数据编码到一行像素中。 (修正版)
 * @param {Uint8Array} metadataRow - 目标行 (这是一个 subarray 视图).
 * @param {object} metadata - 包含所有元数据的对象.
 */
function encodeMetadataToRow(metadataRow, metadata) {
    // --- 核心修正 ---
    // 当从一个 TypedArray 的 subarray 创建 DataView 时，
    // 必须使用包含 byteOffset 和 byteLength 的构造函数，
    // 以确保 DataView 精确地覆盖 subarray 的范围，而不是整个底层 buffer。
    const view = new DataView(metadataRow.buffer, metadataRow.byteOffset, metadataRow.byteLength);

    // 现在 view 的范围是正确的，写入操作将是安全的。
    view.setUint32(0, metadata.originalWidth, false);
    view.setUint32(4, metadata.originalHeight, false);
    view.setUint32(8, metadata.contentWidth, false);
    view.setUint32(12, metadata.contentHeight, false);
    view.setUint32(16, metadata.totalBlocks, false);
}

/**
 * 从一行像素中解码出所有元数据。 (修正版)
 * @param {Uint8Array} metadataRow - 包含元数据的行 (这是一个 subarray 视图).
 * @returns {object} - 解码出的元数据对象.
 */
function decodeMetadataFromRow(metadataRow) {
    // --- 核心修正 ---
    // 同样，为解密函数也应用相同的、正确的 DataView 创建方式，
    // 以保证代码的健壮性。
    const view = new DataView(metadataRow.buffer, metadataRow.byteOffset, metadataRow.byteLength);

    return {
        originalWidth: view.getUint32(0, false),
        originalHeight: view.getUint32(4, false),
        contentWidth: view.getUint32(8, false),
        contentHeight: view.getUint32(12, false),
        totalBlocks: view.getUint32(16, false),
    };
}

/**
 * 从一个 RGBA 像素中解码出 32 位整数。
 * @param {Uint8Array} pixelData - 包含像素数据的数组.
 * @param {number} offset - 像素的起始偏移量.
 * @returns {number} 解码后的数字.
 */
function decodeNumberFromPixel(pixelData, offset) {
    const r = pixelData[offset];
    const g = pixelData[offset + 1];
    const b = pixelData[offset + 2];
    const a = pixelData[offset + 3];
    return (r << 24) | (g << 16) | (b << 8) | a;
}

/**
 * Fisher-Yates (aka Knuth) Shuffle 算法，用于随机打乱数组。
 * @param {Array} array - 需要打乱的数组.
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * 使用 WASM 模块执行高效的无损解密。
 * 这个函数负责准备数据，调用C语言编译的WASM函数，并处理返回结果。
 * 核心的、计算密集的像素重排工作完全在WASM中完成。
 *
 * @param {Uint8Array} pixels 加密图像的完整像素数据。
 * @param {number} width 加密图像的宽度。
 * @param {number} height 加密图像的高度。
 * @returns {Promise<ArrayBuffer>} 一个包含解密后 PNG 文件数据的 ArrayBuffer。
 */
async function decryptWithShuffle(wasmApi, pixels, width, height) {
    // 步骤 1: 检查 WASM 模块是否已加载并准备就绪
    if (!wasmApi) {
        // 如果 wasmApi 为 null，说明模块还没加载好，无法继续。
        // 这是必要的安全检查。
        throw new Error("WASM 模块尚未准备好，请稍后再试。");
    }

    const {Module, perform_decryption} = wasmApi;

    console.log("执行解密 (WASM 优化方案)...");

    // 步骤 2: 从像素数据中解码元数据 (这部分逻辑不变，在JS中完成)
    // 这不是性能瓶颈，且在JS中操作更灵活。
    const metadataRow = pixels.subarray(0, width * CHANNELS);
    const metadata = decodeMetadataFromRow(metadataRow);
    const {originalWidth, originalHeight, contentWidth, contentHeight, totalBlocks} = metadata;

    // 验证元数据，确保文件没有损坏
    if (originalWidth !== width) {
        throw new Error(`宽度不匹配: 文件为 ${width}px, 元数据为 ${originalWidth}px.`);
    }
    if (totalBlocks <= 0 || contentWidth <= 0 || contentHeight <= 0) {
        throw new Error(`元数据无效: totalBlocks=${totalBlocks}, contentWidth=${contentWidth}, contentHeight=${contentHeight}`);
    }

    // 步骤 3: 从像素数据中解码 Shuffle Map (同上，在JS中完成)
    const mapRows = Math.ceil(totalBlocks / originalWidth);
    const mapStartOffset = originalWidth * CHANNELS;
    const shuffleMap = new Array(totalBlocks);
    for (let i = 0; i < totalBlocks; i++) {
        shuffleMap[i] = decodeNumberFromPixel(pixels, mapStartOffset + i * CHANNELS);
    }

    // 计算加密内容在完整像素数据中的起始行号
    const encryptedContentStartRow = 1 + mapRows;

    // --- 核心：WASM 交互 ---

    // 定义一些指针变量，初始化为0（空指针）
    let encryptedPixelsPtr = 0;
    let shuffleMapPtr = 0;
    let decryptedPixelsPtr = 0;

    try {
        // 步骤 4: 在 WASM 的线性内存中为所有数据分配空间
        // 这是调用C函数前的准备工作，必须为所有输入和输出数据预留内存。
        const encryptedPixelsSize = pixels.length;
        const shuffleMapSize = shuffleMap.length * 4; // Uint32Array，每个元素4字节
        const decryptedPixelsSize = originalWidth * originalHeight * CHANNELS;

        encryptedPixelsPtr = Module._malloc(encryptedPixelsSize);
        shuffleMapPtr = Module._malloc(shuffleMapSize);
        decryptedPixelsPtr = Module._malloc(decryptedPixelsSize);

        // 如果内存分配失败 (例如，图片太大导致内存不足)，_malloc 会返回 0
        if (!encryptedPixelsPtr || !shuffleMapPtr || !decryptedPixelsPtr) {
            throw new Error("在 WASM 中分配内存失败，可能是图片尺寸过大。");
        }

        // 步骤 5: 将 JavaScript 中的数据复制到 WASM 的内存中
        // 使用 HEAPU8 (Uint8Array 视图) 和 HEAPU32 (Uint32Array 视图) 进行高效复制。
        Module.HEAPU8.set(pixels, encryptedPixelsPtr);
        // 注意: HEAPU32 的偏移量需要除以4，因为它操作的是4字节整数。
        Module.HEAPU32.set(new Uint32Array(shuffleMap), shuffleMapPtr / 4);

        // 步骤 6: 调用导出的 C 函数 `perform_decryption`
        // 所有参数都以数字形式传递（包括指针，它本质上是内存地址的数字表示）。
        perform_decryption(
            encryptedPixelsPtr,           // const unsigned char* restrict encrypted_pixels
            width,                        // int width
            height,                       // int height
            contentWidth,                 // int content_width
            contentHeight,                // int content_height
            shuffleMapPtr,                // const unsigned int* restrict shuffle_map
            encryptedContentStartRow,     // int encrypted_content_start_row
            decryptedPixelsPtr            // unsigned char* restrict decrypted_pixels
        );

        // 步骤 7: 从 WASM 内存中将解密结果复制回 JavaScript
        // 创建一个指向 WASM 内存中结果区域的视图
        const wasmResultView = new Uint8Array(Module.HEAPU8.buffer, decryptedPixelsPtr, decryptedPixelsSize);

        // **至关重要**: 创建一个数据的 JavaScript 副本。
        // 因为 WASM 内存很快就会被释放，我们不能持有对它的引用。
        const finalDecryptedPixels = new Uint8Array(wasmResultView);

        console.log("WASM 无损解密完成。");

        // 步骤 8: 使用解密后的像素数据编码成最终的 PNG 文件
        // UPNG.encode 期望一个 ArrayBuffer 的数组，所以我们传入 .buffer。
        return UPNG.encode([finalDecryptedPixels.buffer], originalWidth, originalHeight, 0);

    } finally {
        // 步骤 9: 无论成功与否，都必须释放 WASM 内存以避免内存泄漏
        // 使用 try...finally 结构确保即使在发生错误时也能执行清理。
        if (encryptedPixelsPtr) Module._free(encryptedPixelsPtr);
        if (shuffleMapPtr) Module._free(shuffleMapPtr);
        if (decryptedPixelsPtr) Module._free(decryptedPixelsPtr);
        console.log("WASM 内存已释放。");
    }
}