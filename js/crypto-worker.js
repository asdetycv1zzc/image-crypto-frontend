try {
    // 1. 引入所有脚本。将它们放在一个 try...catch 块中。
    // 把最可疑的放在前面。
    importScripts('image_processor.js');

    // 3. (可选但推荐) 进行统一的依赖检查
    if (typeof createImageProcessorModule === 'undefined') {
        throw new Error("一个或多个依赖库未能正确初始化。");
    }
} catch (e) {
    // 如果 importScripts 本身失败（例如404），这里会捕获到错误
    console.error("Worker: importScripts 失败:", e);
    // 向主线程报告一个致命的初始化错误
    self.postMessage({status: 'init_error', error: e.message});
}

let wasmApi = null;

/**
 * 使用 WASM (stb_image) 解码图像数据。
 * @param {object} wasmApi - 已初始化的 WASM API 对象。
 * @param {ArrayBuffer} fileBuffer - 包含原始图像文件（PNG, JPG, BMP等）的 ArrayBuffer。
 * @returns {{width: number, height: number, data: Uint8Array}} 解码后的 RGBA 像素数据。
 */
function decodeImageWasm(wasmApi, fileBuffer) {
    console.log("使用 WASM 解码图像...");
    const {Module, decode_image, _free} = wasmApi;
    let imagePtr = 0, widthPtr = 0, heightPtr = 0, decodedPtr = 0;

    try {
        // 1. 在 WASM 内存中为输入图像数据分配空间
        const imageSize = fileBuffer.byteLength;
        imagePtr = Module._malloc(imageSize);
        if (!imagePtr) throw new Error("WASM _malloc 失败：无法为输入图像分配内存。");

        // 2. 将 JS 的 ArrayBuffer 数据复制到 WASM 内存中
        Module.HEAPU8.set(new Uint8Array(fileBuffer), imagePtr);

        // 3. 为输出参数（宽度和高度）分配内存
        widthPtr = Module._malloc(4); // int
        heightPtr = Module._malloc(4); // int
        if (!widthPtr || !heightPtr) throw new Error("WASM _malloc 失败：无法为维度指针分配内存。");

        // 4. 调用 C 函数进行解码
        decodedPtr = decode_image(imagePtr, imageSize, widthPtr, heightPtr);
        if (!decodedPtr) {
            throw new Error("图像解码失败。WASM 函数返回空指针，可能是不支持的格式或文件已损坏。");
        }

        // 5. 从 WASM 内存中读回解码后的宽度和高度
        const width = Module.getValue(widthPtr, 'i32');
        const height = Module.getValue(heightPtr, 'i32');
        if (width === 0 || height === 0) throw new Error("WASM 解码返回无效的尺寸。");

        // 6. 将解码后的像素数据从 WASM 内存复制到 JS 内存
        // 至关重要：使用 .slice() 创建一个副本，因为我们马上要释放 WASM 内存。
        const decodedSize = width * height * 4; // RGBA
        const pixels = new Uint8Array(Module.HEAPU8.buffer, decodedPtr, decodedSize).slice();

        console.log(`WASM 解码成功: ${width}x${height}`);
        return {width, height, data: pixels};

    } finally {
        // 7. 释放所有在 WASM 中分配的内存，防止内存泄漏
        if (imagePtr) _free(imagePtr);
        if (widthPtr) _free(widthPtr);
        if (heightPtr) _free(heightPtr);
        if (decodedPtr) _free(decodedPtr); // stb_image 使用 malloc，所以必须释放
    }
}

/**
 * 使用 WASM (stb_image_write) 将 RGBA 像素数据编码为 PNG 文件。
 * @param {object} wasmApi - 已初始化的 WASM API 对象。
 * @param {Uint8Array} pixels - 原始 RGBA 像素数据。
 * @param {number} width - 图像宽度。
 * @param {number} height - 图像高度。
 * @returns {ArrayBuffer} 包含最终 PNG 文件数据的 ArrayBuffer。
 */
function encodePngWasm(wasmApi, pixels, width, height) {
    console.log("使用 WASM 编码 PNG...");
    const {Module, encode_png, _free} = wasmApi;
    let pixelsPtr = 0, sizePtr = 0, resultPtr = 0;

    try {
        // 1. 在 WASM 内存中为输入像素数据分配空间并复制
        pixelsPtr = Module._malloc(pixels.length);
        if (!pixelsPtr) throw new Error("WASM _malloc 失败：无法为像素缓冲区分配内存。");
        Module.HEAPU8.set(pixels, pixelsPtr);

        // 2. 为输出参数（PNG 文件大小）分配内存
        sizePtr = Module._malloc(4); // size_t
        if (!sizePtr) throw new Error("WASM _malloc 失败：无法为大小指针分配内存。");

        // 3. 调用 C 函数进行编码
        resultPtr = encode_png(pixelsPtr, width, height, sizePtr);
        if (!resultPtr) {
            throw new Error("PNG 编码失败。WASM 函数返回空指针。");
        }

        // 4. 从 WASM 内存中读回编码后的文件大小
        const resultSize = Module.getValue(sizePtr, 'i32');

        // 5. 将编码后的 PNG 数据从 WASM 内存复制到 JS 的 ArrayBuffer
        // 同样，使用 .slice().buffer 创建一个独立的副本。
        const resultBuffer = new Uint8Array(Module.HEAPU8.buffer, resultPtr, resultSize).slice().buffer;

        console.log(`WASM 编码成功，大小: ${resultSize} 字节`);
        return resultBuffer;

    } finally {
        // 6. 释放所有在 WASM 中分配的内存
        if (pixelsPtr) _free(pixelsPtr);
        if (sizePtr) _free(sizePtr);
        if (resultPtr) _free(resultPtr); // 我们的 C 代码分配了此内存，必须释放
    }
}

const MAGIC_PIXEL_PATTERN = [
    {r: 0xDE, g: 0xAD, b: 0xBE, a: 0xEF},
    {r: 0xCA, g: 0xFE, b: 0xBA, a: 0xBE},
    {r: 0xFE, g: 0xED, b: 0xDE, a: 0xED},
    {r: 0xDA, g: 0x7A, b: 0xB0, a: 0x55},
];
const CHANNELS = 4;

function generateMagicRow(width) {
    const magicRow = new Uint8Array(width * CHANNELS);
    for (let j = 0; j < width; j++) {
        const patternPixel = MAGIC_PIXEL_PATTERN[j % MAGIC_PIXEL_PATTERN.length];
        const offset = j * CHANNELS;
        magicRow[offset] = patternPixel.r;
        magicRow[offset + 1] = patternPixel.g;
        magicRow[offset + 2] = patternPixel.b;
        magicRow[offset + 3] = patternPixel.a;
    }
    return magicRow;
}

function areBuffersEqual(view1, view2) {
    // 传入的参数直接就是 Uint8Array 视图 (lastRow 和 expectedMagicRow)
    if (!view1 || !view2 || view1.length !== view2.length) {
        // [调试] 添加日志，看看长度是否匹配
        if (view1 && view2) {
            console.error(`Buffer 比较失败：长度不匹配。 view1.length=${view1.length}, view2.length=${view2.length}`);
        }
        return false;
    }

    // 直接逐字节比较视图内容
    for (let i = 0; i < view1.length; i++) {
        if (view1[i] !== view2[i]) {
            // [调试] 如果发现不匹配，打印出具体位置和值
            console.error(`Buffer 在索引 ${i} 处不匹配: view1[${i}]=${view1[i]}, view2[${i}]=${view2[i]}`);
            return false;
        }
    }

    // 如果循环完成都没有返回 false，说明它们是相等的
    return true;
}

function isEncrypted(pixelData, width, height) {
    if (height < 2) return false;
    const expectedMagicRow = generateMagicRow(width);
    const lastRowOffset = (height - 1) * width * CHANNELS;
    const lastRow = pixelData.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
    return areBuffersEqual(lastRow, expectedMagicRow);
}

// Module 是由 image_processor.js 创建的全局对象
// 等待WASM运行时初始化完成
createImageProcessorModule()
    .then(Module => {
        console.log("Worker: WASM 模块已加载并初始化。");

        // 填充 wasmApi 对象，包含所有需要从 JS 调用的 C 函数
        wasmApi = {
            Module: Module,
            // 内存管理
            _free: Module._free,
            // 来自 image_process.c
            perform_encryption: Module.cwrap(
                'perform_encryption', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
            ),
            perform_decryption: Module.cwrap(
                'perform_decryption', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
            ),
            // 来自 image_codecs_wasm.c
            decode_image: Module.cwrap(
                'decode_image_wasm', 'number', ['number', 'number', 'number', 'number']
            ),
            encode_png: Module.cwrap(
                'encode_png_wasm', 'number', ['number', 'number', 'number', 'number']
            ),
        };

        // 向主线程发送“准备就绪”的消息
        self.postMessage({status: 'ready'});
    })
    .catch(err => {
        console.error("Worker: WASM 模块加载失败:", err);
        self.postMessage({status: 'error', error: `WASM 模块加载失败: ${err.message}`});
    });

// 监听主线程发来的任务
self.onmessage = async (event) => {
    if (!wasmApi) {
        // 如果WASM还没准备好，则忽略消息
        return;
    }

    const {fileBuffer, fileName} = event.data;

    try {
        // -----------------------------------------------------------------
        // Worker 的核心逻辑：与您原来的单线程 processImageFile 几乎一样
        // 只是它现在在 Worker 内部运行
        // -----------------------------------------------------------------

        // 1. 解码图片
        const {width, height, data: pixels} = decodeImageWasm(wasmApi, fileBuffer);

        if (!width || !height) {
            throw new Error("解码失败，无法获取图片数据。");
        }

        // 2. 加密或解密
        const encrypted = isEncrypted(pixels, width, height);
        let outputPngBuffer;
        if (encrypted) {
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
                newFileName: encrypted ? `decrypted-${fileName}` : `encrypted-${fileName}.png`
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
    return encodePngWasm(wasmApi, outputPixels, width, newHeight);
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
        return encodePngWasm(wasmApi, finalDecryptedPixels, originalWidth, originalHeight);

    } finally {
        // 步骤 9: 无论成功与否，都必须释放 WASM 内存以避免内存泄漏
        // 使用 try...finally 结构确保即使在发生错误时也能执行清理。
        if (encryptedPixelsPtr) Module._free(encryptedPixelsPtr);
        if (shuffleMapPtr) Module._free(shuffleMapPtr);
        if (decryptedPixelsPtr) Module._free(decryptedPixelsPtr);
        console.log("WASM 内存已释放。");
    }
}